# Vendored from coachregatta analysis/src/coachregatta_analysis/environment_fetcher.py, 2026-07-11 — adapted for deepweather (forecast products, DEEPWEATHER_* env vars).
"""
CMEMS forecast surface-current fetcher (currents-only).

Fetches Copernicus Marine regional analysis & forecast (anfc) surface currents
(hourly uo/vo) for a bounding box and time window, with an expiry-based cache
under data/cache/environment/.

Adaptations from the coachregatta original:
- Forecast-only: catalogue resolution prefers dataset ids containing 'anfc'
  (analysis & forecast) with hourly temporal resolution; reanalysis/multiyear
  (GLORYS/_my_) and ERA5 weather code dropped entirely.
- Env vars renamed COACHREGATTA_* -> DEEPWEATHER_*.
- Cache metadata gains fetched_at + valid_until (12 h expiry — forecast
  products update at least twice daily); a cached file past valid_until or
  with changed bounds/time-window is refetched.
- copernicusmarine 2.x API: subset(overwrite=True) replaces the removed
  force_download flag.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

from .fileutil import check_xarray as _check_xarray
from .fileutil import compute_file_checksum
from .fileutil import open_nc_robust as _open_nc_robust
from .paths import data_root
from .timeutil import parse_iso_utc

logger = logging.getLogger(__name__)

# Cache directory relative to repo root unless overridden (DEEPWEATHER_DATA_ROOT).
CACHE_ROOT = data_root() / "cache" / "environment"

# =============================================================================
# Regional Model Configuration
# =============================================================================


@dataclass
class RegionalModel:
    """Configuration for a Copernicus Marine regional model."""

    code: str
    name: str
    bounds: Dict[str, Tuple[float, float]]  # lat: (min, max), lon: (min, max)
    resolution_deg: float


REGIONAL_MODELS: Dict[str, RegionalModel] = {
    "IBI": RegionalModel(
        code="IBI",
        name="Iberian Biscay Irish",
        bounds={"lat": (26, 56), "lon": (-19, 5)},
        resolution_deg=0.027,  # 1/36° ~3 km
    ),
    "NWS": RegionalModel(
        code="NWS",
        name="Northwest Shelf",
        bounds={"lat": (48, 63), "lon": (-20, 13)},
        resolution_deg=1 / 9,  # ~7 km
    ),
    "MED": RegionalModel(
        code="MED",
        name="Mediterranean",
        bounds={"lat": (30, 46), "lon": (-6, 37)},
        resolution_deg=1 / 24,  # ~4 km
    ),
    "BAL": RegionalModel(
        code="BAL",
        name="Baltic Sea",
        bounds={"lat": (53.5, 66), "lon": (9, 30.5)},
        resolution_deg=1 / 60,  # ~2 km
    ),
    "GLO": RegionalModel(
        code="GLO",
        name="Global Ocean",
        bounds={"lat": (-80, 90), "lon": (-180, 180)},
        resolution_deg=1 / 12,  # ~9 km
    ),
}

# GLO covers everything, so it must stay last: a corridor inside a regional
# model's box always resolves to that (finer) model first.
REGION_PRIORITY = ["IBI", "NWS", "MED", "BAL", "GLO"]


@dataclass(frozen=True)
class ResolvedDataset:
    dataset_id: str
    product_id: Optional[str]
    temporal_resolution: str


_RESOLVED_REGIONAL_DATASETS: Dict[str, ResolvedDataset] = {}

# Currents downsampling defaults (auto-applied for large areas)
COARSE_CURRENTS_ENABLED = os.getenv("DEEPWEATHER_CURRENTS_COARSE", "1") != "0"
COARSE_CURRENTS_AREA_DEG2 = float(os.getenv("DEEPWEATHER_CURRENTS_COARSE_AREA_DEG2", "250"))
COARSE_CURRENTS_TARGET_RES_DEG = float(os.getenv("DEEPWEATHER_CURRENTS_COARSE_RES_DEG", "0.1"))
COARSE_CURRENTS_TARGET_TIME_HOURS = int(os.getenv("DEEPWEATHER_CURRENTS_COARSE_TIME_HOURS", "3"))
CURRENTS_MAX_REQUEST_POINTS = int(os.getenv("DEEPWEATHER_CURRENTS_MAX_REQUEST_POINTS", "100000000"))

MAX_CURRENTS_RETRIES = int(os.getenv("DEEPWEATHER_CURRENTS_RETRIES", "2"))
# Backoff between failed attempts only; successful downloads return immediately.
CURRENTS_FETCH_DELAY = float(os.getenv("DEEPWEATHER_CURRENTS_DELAY_S", "2.0"))
# Minimum overlap fraction to consider a regional model a good fit.
REGION_OVERLAP_THRESHOLD = float(os.getenv("DEEPWEATHER_CURRENTS_REGION_OVERLAP", "0.25"))

# Forecast products update at least twice daily; cached fetches expire after this.
CACHE_VALIDITY_HOURS = float(os.getenv("DEEPWEATHER_CURRENTS_CACHE_HOURS", "12"))


# =============================================================================
# Metadata Schema
# =============================================================================


@dataclass
class CurrentsMetadata:
    """Metadata for a cached forecast-currents fetch (expiry-based)."""

    fetch_id: str
    fetched_at: str  # ISO format
    valid_until: str  # ISO format; past this the cache is stale
    bounds: Dict[str, float] = field(default_factory=dict)
    time_range: Dict[str, str] = field(default_factory=dict)
    currents: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CurrentsMetadata":
        """Create from dictionary."""
        return cls(**data)


# =============================================================================
# Utility Functions
# =============================================================================


def _cleanup_partial_file(file_path: Path, label: str) -> None:
    """Remove a partial/corrupt download so later runs do not reuse it."""
    if not file_path.exists():
        return
    try:
        file_path.unlink()
        logger.warning("Removed incomplete %s file at %s", label, file_path)
    except OSError as exc:
        logger.warning(
            "Failed to remove incomplete %s file at %s: %s",
            label,
            file_path,
            exc,
        )


def _overlap_fraction(area_bounds: Dict[str, float], model: RegionalModel) -> float:
    min_lat = area_bounds.get("min_lat")
    max_lat = area_bounds.get("max_lat")
    min_lon = area_bounds.get("min_lon")
    max_lon = area_bounds.get("max_lon")
    if min_lat is None or max_lat is None or min_lon is None or max_lon is None:
        return 0.0

    overlap_min_lat = max(min_lat, model.bounds["lat"][0])
    overlap_max_lat = min(max_lat, model.bounds["lat"][1])
    overlap_min_lon = max(min_lon, model.bounds["lon"][0])
    overlap_max_lon = min(max_lon, model.bounds["lon"][1])
    if overlap_max_lat <= overlap_min_lat or overlap_max_lon <= overlap_min_lon:
        return 0.0

    overlap_area = (overlap_max_lat - overlap_min_lat) * _normalize_lon_span(
        overlap_min_lon, overlap_max_lon
    )
    total_area = _area_bounds_deg2(area_bounds) or 0.0
    if total_area <= 0:
        return 0.0
    return overlap_area / total_area


def detect_region(area_bounds: Dict[str, float]) -> Optional[str]:
    """
    Detect which regional model covers the area.

    Args:
        area_bounds: Dict with min_lat, max_lat, min_lon, max_lon

    Returns:
        Region code ('IBI', 'NWS', 'MED', 'BAL') or None if no coverage.
        Prioritizes IBI over NWS for overlapping areas (finer resolution).
    """
    min_lat = area_bounds.get("min_lat")
    max_lat = area_bounds.get("max_lat")
    min_lon = area_bounds.get("min_lon")
    max_lon = area_bounds.get("max_lon")

    if min_lat is None or max_lat is None or min_lon is None or max_lon is None:
        return None

    # Priority order: IBI, NWS, MED, BAL
    for region_code in REGION_PRIORITY:
        model = REGIONAL_MODELS[region_code]
        if (
            min_lat >= model.bounds["lat"][0]
            and max_lat <= model.bounds["lat"][1]
            and min_lon >= model.bounds["lon"][0]
            and max_lon <= model.bounds["lon"][1]
        ):
            return region_code

    # If not fully covered, choose the best overlap above threshold.
    best_region = None
    best_fraction = 0.0
    for region_code in REGION_PRIORITY:
        fraction = _overlap_fraction(area_bounds, REGIONAL_MODELS[region_code])
        if fraction > best_fraction:
            best_fraction = fraction
            best_region = region_code

    if best_region and best_fraction >= REGION_OVERLAP_THRESHOLD:
        return best_region
    return None


def get_cache_dir(fetch_id: str) -> Path:
    """Get cache directory for a fetch."""
    return CACHE_ROOT / fetch_id


def load_currents_metadata(fetch_id: str) -> Optional[CurrentsMetadata]:
    """Load existing metadata for a fetch, if available."""
    cache_dir = get_cache_dir(fetch_id)
    meta_path = cache_dir / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return CurrentsMetadata.from_dict(json.load(f))
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        logger.warning("Failed to load metadata for %s: %s", fetch_id, e)
        return None


def save_currents_metadata(metadata: CurrentsMetadata) -> Path:
    """Save metadata to cache directory."""
    cache_dir = get_cache_dir(metadata.fetch_id)
    cache_dir.mkdir(parents=True, exist_ok=True)
    meta_path = cache_dir / "metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata.to_dict(), f, indent=2)
    return meta_path


def _normalize_lon_span(min_lon: float, max_lon: float) -> float:
    span = abs(max_lon - min_lon)
    if span > 180:
        return 360 - span
    return span


def _raw_lon_span(min_lon: float, max_lon: float) -> float:
    return abs(max_lon - min_lon)


def _area_bounds_deg2(bounds: Dict[str, float]) -> Optional[float]:
    min_lat = bounds.get("min_lat")
    max_lat = bounds.get("max_lat")
    min_lon = bounds.get("min_lon")
    max_lon = bounds.get("max_lon")
    if min_lat is None or max_lat is None or min_lon is None or max_lon is None:
        return None
    lat_span = abs(max_lat - min_lat)
    lon_span = _normalize_lon_span(min_lon, max_lon)
    return lat_span * lon_span


def _estimate_request_grid_points(
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    *,
    resolution_deg: float,
    time_hours: int,
    use_raw_lon_span: bool = True,
) -> Optional[int]:
    min_lat = bounds.get("min_lat")
    max_lat = bounds.get("max_lat")
    min_lon = bounds.get("min_lon")
    max_lon = bounds.get("max_lon")
    if (
        min_lat is None
        or max_lat is None
        or min_lon is None
        or max_lon is None
        or resolution_deg <= 0
        or time_hours <= 0
    ):
        return None
    lat_span = abs(max_lat - min_lat)
    lon_span = (
        _raw_lon_span(min_lon, max_lon)
        if use_raw_lon_span
        else _normalize_lon_span(min_lon, max_lon)
    )
    duration_hours = max(0.0, (end_time - start_time).total_seconds() / 3600.0)
    lat_points = max(1, int(math.ceil(lat_span / resolution_deg)) + 1)
    lon_points = max(1, int(math.ceil(lon_span / resolution_deg)) + 1)
    time_points = max(1, int(math.ceil(duration_hours / time_hours)) + 1)
    return lat_points * lon_points * time_points


def _request_too_large_error(
    label: str,
    estimated_points: int,
    max_points: int,
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
) -> str:
    min_lon = bounds.get("min_lon", 0.0)
    max_lon = bounds.get("max_lon", 0.0)
    min_lat = bounds.get("min_lat", 0.0)
    max_lat = bounds.get("max_lat", 0.0)
    raw_lon_span = _raw_lon_span(min_lon, max_lon)
    lat_span = abs(max_lat - min_lat)
    duration_days = max(0.0, (end_time - start_time).total_seconds() / 86400.0)
    return (
        f"{label} request too large "
        f"({estimated_points:,} estimated grid points > {max_points:,}; "
        f"{lat_span:.1f}deg lat x {raw_lon_span:.1f}deg lon x {duration_days:.1f} days)"
    )


def _should_downsample_currents(bounds: Dict[str, float]) -> tuple[bool, float | None]:
    if not COARSE_CURRENTS_ENABLED:
        return False, None
    area = _area_bounds_deg2(bounds)
    if area is None:
        return False, None
    return area >= COARSE_CURRENTS_AREA_DEG2, area


def _get_lat_lon_coord_names(ds: Any) -> tuple[Optional[str], Optional[str]]:
    lat_name = None
    lon_name = None
    for candidate in ("latitude", "lat", "nav_lat"):
        if candidate in ds.coords:
            lat_name = candidate
            break
    for candidate in ("longitude", "lon", "nav_lon"):
        if candidate in ds.coords:
            lon_name = candidate
            break
    return lat_name, lon_name


def _downsample_currents_file(
    path: Path,
    bounds: Dict[str, float],
    target_resolution_deg: float,
    target_time_hours: int,
) -> Optional[Dict[str, Any]]:
    should_downsample, area = _should_downsample_currents(bounds)
    if not should_downsample:
        return None
    if not _check_xarray():
        logger.warning("xarray not installed; skipping currents downsampling")
        return None
    try:
        ds = _open_nc_robust(path)
    except Exception as e:
        logger.warning("Failed to open currents for downsampling: %s", e)
        return None

    with ds:
        time_coord = _get_time_coord_name(ds)
        lat_coord, lon_coord = _get_lat_lon_coord_names(ds)
        if not time_coord or not lat_coord or not lon_coord:
            logger.warning("Missing coords for currents downsampling; skipping")
            return None

        lats = np.array(ds[lat_coord].values).reshape(-1)
        lons = np.array(ds[lon_coord].values).reshape(-1)
        if lats.size < 2 or lons.size < 2:
            logger.warning("Insufficient grid for currents downsampling; skipping")
            return None

        lat_step = float(np.median(np.abs(np.diff(lats))))
        lon_step = float(np.median(np.abs(np.diff(lons))))
        native_res = max(lat_step, lon_step)
        spatial_stride = max(1, int(math.ceil(target_resolution_deg / native_res)))

        times_arr = np.array(ds[time_coord].values).reshape(-1)
        time_stride = 1
        native_hours = None
        if times_arr.size >= 2:
            sorted_times = np.sort(times_arr.astype("datetime64[ns]"))
            deltas = np.diff(sorted_times)
            seconds = np.median(deltas.astype("timedelta64[s]").astype("int64"))
            native_hours = seconds / 3600.0
            if native_hours > 0 and native_hours < target_time_hours:
                time_stride = max(1, int(math.floor(target_time_hours / native_hours)))

        if spatial_stride < 2 and time_stride < 2:
            return None

        downsampled = ds
        if spatial_stride >= 2:
            downsampled = downsampled.isel(
                {
                    lat_coord: slice(None, None, spatial_stride),
                    lon_coord: slice(None, None, spatial_stride),
                }
            )
        if time_stride >= 2 and time_coord:
            downsampled = downsampled.isel(
                {
                    time_coord: slice(None, None, time_stride),
                }
            )

        tmp_path = path.with_suffix(".downsample.nc")
        if tmp_path.exists():
            tmp_path.unlink()
        downsampled.to_netcdf(tmp_path)
        downsampled.close()
        tmp_path.replace(path)

        result_hours = None
        if native_hours is not None:
            result_hours = native_hours * time_stride

        logger.info(
            "Downsampled currents (area=%.1f deg^2): spatial x%d, time x%d",
            area,
            spatial_stride,
            time_stride,
        )

        return {
            "strategy": "auto",
            "area_deg2": area,
            "native_resolution_deg": native_res,
            "native_time_hours": native_hours,
            "spatial_stride": spatial_stride,
            "time_stride": time_stride,
            "target_resolution_deg": target_resolution_deg,
            "target_time_hours": target_time_hours,
            "result_resolution_deg": native_res * spatial_stride,
            "result_time_hours": result_hours,
        }


def _get_time_coord_name(ds: Any) -> Optional[str]:
    for candidate in ("time", "valid_time"):
        if candidate in ds.coords:
            return candidate
    return None


def _validate_currents_file(path: Path, allow_daily: bool = False) -> tuple[bool, Optional[str]]:
    if not path.exists():
        return False, "missing currents.nc"
    if not _check_xarray():
        logger.warning("xarray not installed; skipping currents frequency validation")
        return True, None
    try:
        ds = _open_nc_robust(path)
    except Exception as e:
        return False, f"failed to open currents file: {e}"

    with ds:
        time_coord = _get_time_coord_name(ds)
        if not time_coord:
            return False, "missing time coordinate"
        times_arr = np.array(ds[time_coord].values).reshape(-1)
        if times_arr.size < 2:
            return False, "single timestep"
        sorted_times = np.sort(times_arr.astype("datetime64[ns]"))
        deltas = np.diff(sorted_times)
        if deltas.size == 0:
            return False, "single timestep"
        seconds = np.median(deltas.astype("timedelta64[s]").astype("int64"))
        hours = seconds / 3600.0
        if not allow_daily and hours > 3.0:
            return False, f"temporal resolution {hours:.1f}h"
    return True, None


def _temporal_resolution_from_dataset_id(dataset_id: str) -> Optional[str]:
    dataset_id = dataset_id.lower()
    if "p1h" in dataset_id or "pt1h" in dataset_id:
        return "hourly"
    if "p3h" in dataset_id or "pt3h" in dataset_id:
        return "3-hourly"
    if "pt15m" in dataset_id:
        # MED anfc publishes currents only as 15-min instantaneous (no PT1H sibling)
        return "15-min"
    return None


def _format_temporal_resolution(hours: Optional[float], fallback: str) -> str:
    if hours is None:
        return fallback
    if hours <= 0.5:
        return "15-min"
    if hours <= 1.5:
        return "hourly"
    if hours <= 3.5:
        return "3-hourly"
    return f"{hours:.1f}h"


def _dataset_id_looks_like_currents(dataset_id: str) -> bool:
    dataset_id = dataset_id.lower()
    return "cur" in dataset_id or "uv" in dataset_id or "current" in dataset_id


def _dataset_is_forecast(dataset_id: str) -> bool:
    """True for analysis & forecast (anfc) product-family dataset ids."""
    return "anfc" in dataset_id.lower()


def _dataset_is_multiyear(dataset_id: str) -> bool:
    """True for reanalysis/multiyear dataset ids (e.g. *_my_*, *_myint_*)."""
    return re.search(r"_my(int)?_", dataset_id.lower()) is not None


def _dataset_has_currents(dataset: Any) -> bool:
    has_variable_metadata = False
    for version in getattr(dataset, "versions", []):
        for part in getattr(version, "parts", []):
            for service in getattr(part, "services", []):
                variables = getattr(service, "variables", [])
                if variables:
                    has_variable_metadata = True
                var_names = {var.short_name for var in variables}
                if "uo" in var_names and "vo" in var_names:
                    return True
    if not has_variable_metadata:
        return _dataset_id_looks_like_currents(getattr(dataset, "dataset_id", ""))
    return False


def _check_copernicusmarine() -> bool:
    """Check if copernicusmarine is available."""
    try:
        import copernicusmarine  # noqa: F401

        return True
    except ImportError:
        return False


def _resolve_regional_dataset(region_code: str) -> Optional[ResolvedDataset]:
    """
    Resolve the FORECAST currents dataset for a region.

    Prefers dataset ids containing 'anfc' (analysis & forecast, e.g. the IBI
    family cmems_mod_ibi_phy_anfc_*) with hourly temporal resolution and uo/vo
    variables. Reanalysis/multiyear (_my_) datasets are excluded. Overridable
    per region via DEEPWEATHER_CURRENTS_DATASET_{IBI|NWS|MED|BAL}.
    """
    cached = _RESOLVED_REGIONAL_DATASETS.get(region_code)
    if cached:
        return cached

    override = os.getenv(f"DEEPWEATHER_CURRENTS_DATASET_{region_code}")
    if override:
        temporal = _temporal_resolution_from_dataset_id(override)
        if not temporal:
            logger.warning(
                "Override dataset %s for %s is not hourly/3-hourly; ignoring.",
                override,
                region_code,
            )
        else:
            resolved = ResolvedDataset(
                dataset_id=override,
                product_id=None,
                temporal_resolution=temporal,
            )
            _RESOLVED_REGIONAL_DATASETS[region_code] = resolved
            return resolved

    if not _check_copernicusmarine():
        logger.error("copernicusmarine not installed. Run: pip install copernicusmarine")
        return None

    import copernicusmarine  # type: ignore[import-untyped]

    try:
        catalogue = copernicusmarine.describe(
            contains=[region_code.lower()],
            disable_progress_bar=True,
        )
    except Exception as e:
        logger.error("Failed to query Copernicus catalogue for %s: %s", region_code, e)
        return None

    candidates: list[ResolvedDataset] = []
    for product in getattr(catalogue, "products", []):
        for dataset in getattr(product, "datasets", []):
            dataset_id = dataset.dataset_id
            if region_code.lower() not in dataset_id.lower():
                continue
            if _dataset_is_multiyear(dataset_id):
                continue  # forecast-only: skip reanalysis/multiyear
            temporal = _temporal_resolution_from_dataset_id(dataset_id)
            if temporal is None:
                continue
            if not _dataset_has_currents(dataset):
                continue
            candidates.append(
                ResolvedDataset(
                    dataset_id=dataset_id,
                    product_id=product.product_id,
                    temporal_resolution=temporal,
                )
            )

    if not candidates:
        logger.warning(
            "No hourly/3-hourly forecast currents dataset found for %s in catalogue",
            region_code,
        )
        return None

    def candidate_score(candidate: ResolvedDataset) -> tuple[int, int, int, str]:
        forecast_score = 1 if _dataset_is_forecast(candidate.dataset_id) else 0
        # hourly is the sweet spot (bandwidth); 15-min beats settling for 3-hourly
        temporal_score = {"hourly": 3, "15-min": 2}.get(candidate.temporal_resolution, 1)
        looks_like_currents = 1 if _dataset_id_looks_like_currents(candidate.dataset_id) else 0
        return (forecast_score, temporal_score, looks_like_currents, candidate.dataset_id)

    candidates.sort(key=candidate_score, reverse=True)
    resolved = candidates[0]
    _RESOLVED_REGIONAL_DATASETS[region_code] = resolved
    return resolved


# =============================================================================
# Copernicus Marine Current Fetching
# =============================================================================


def _resolution_from_dataset_id(dataset_id: str, fallback: float) -> float:
    match = re.search(r"(\d+(?:\.\d+)?)deg", dataset_id.lower())
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return fallback
    return fallback


def fetch_regional_currents(
    region: str,
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    output_path: Path,
) -> Optional[Dict[str, Any]]:
    """
    Fetch regional forecast current data (surface uo/vo, hourly).

    Args:
        region: Region code ('IBI', 'NWS', 'MED', 'BAL', 'GLO')
        bounds: Dict with min_lat, max_lat, min_lon, max_lon
        start_time: Start datetime (UTC)
        end_time: End datetime (UTC)
        output_path: Path to save NetCDF file

    Returns:
        SourceInfo dict on success, or status dict if unavailable
    """
    if region not in REGIONAL_MODELS:
        logger.error("Unknown region: %s", region)
        return None

    if not _check_copernicusmarine():
        logger.error("copernicusmarine not installed. Run: pip install copernicusmarine")
        return {"status": "unavailable", "error": "copernicusmarine missing"}

    model = REGIONAL_MODELS[region]
    resolved = _resolve_regional_dataset(region)
    if not resolved:
        return {
            "status": "unavailable",
            "error": "No hourly/3-hourly forecast dataset found",
        }

    import copernicusmarine

    # Add 6-hour buffer
    fetch_start = start_time - timedelta(hours=6)
    fetch_end = end_time + timedelta(hours=6)

    logger.info(
        "Fetching %s regional forecast currents for %s to %s",
        region,
        fetch_start.date(),
        fetch_end.date(),
    )

    temporal_hours = {"hourly": 1, "15-min": 0.25}.get(resolved.temporal_resolution, 3)
    estimated_points = _estimate_request_grid_points(
        bounds,
        fetch_start,
        fetch_end,
        resolution_deg=model.resolution_deg,
        time_hours=temporal_hours,
        use_raw_lon_span=True,
    )
    if estimated_points is not None and estimated_points > CURRENTS_MAX_REQUEST_POINTS:
        error = _request_too_large_error(
            f"{region} currents",
            estimated_points,
            CURRENTS_MAX_REQUEST_POINTS,
            bounds,
            fetch_start,
            fetch_end,
        )
        logger.warning("Skipping %s regional currents fetch: %s", region, error)
        _cleanup_partial_file(output_path, f"{region} currents")
        return {"status": "unavailable", "error": error}

    last_error: Optional[str] = None
    for attempt in range(1, MAX_CURRENTS_RETRIES + 1):
        try:
            if output_path.exists():
                output_path.unlink()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            copernicusmarine.subset(
                dataset_id=resolved.dataset_id,
                variables=["uo", "vo"],
                minimum_longitude=bounds["min_lon"],
                maximum_longitude=bounds["max_lon"],
                minimum_latitude=bounds["min_lat"],
                maximum_latitude=bounds["max_lat"],
                start_datetime=fetch_start.strftime("%Y-%m-%dT%H:%M:%S"),
                end_datetime=fetch_end.strftime("%Y-%m-%dT%H:%M:%S"),
                # top model level is ~0.494 m in both regional and global anfc
                # products (GLO merged-uv carries ONLY that level); the grid
                # loader then takes the shallowest level as the surface.
                minimum_depth=0.0,
                maximum_depth=5.0,
                output_filename=str(output_path.name),
                output_directory=str(output_path.parent),
                overwrite=True,
                disable_progress_bar=True,
            )

            downsample_info = _downsample_currents_file(
                output_path,
                bounds,
                target_resolution_deg=COARSE_CURRENTS_TARGET_RES_DEG,
                target_time_hours=COARSE_CURRENTS_TARGET_TIME_HOURS,
            )

            valid, error = _validate_currents_file(output_path)
            if not valid:
                last_error = error
                if attempt < MAX_CURRENTS_RETRIES:
                    logger.warning(
                        "%s currents attempt %d/%d: corrupted download (%s), retrying...",
                        region,
                        attempt,
                        MAX_CURRENTS_RETRIES,
                        error,
                    )
                    _cleanup_partial_file(output_path, f"{region} currents")
                    time.sleep(CURRENTS_FETCH_DELAY * attempt)
                    continue
                logger.warning("Discarding currents for %s: %s", region, error)
                _cleanup_partial_file(output_path, f"{region} currents")
                return {
                    "status": "unavailable",
                    "error": f"Currents not hourly/3-hourly ({error})",
                }

            resolution_deg = model.resolution_deg
            temporal_resolution = resolved.temporal_resolution
            if downsample_info:
                resolution_deg = downsample_info.get("result_resolution_deg", resolution_deg)
                temporal_resolution = _format_temporal_resolution(
                    downsample_info.get("result_time_hours"),
                    temporal_resolution,
                )

            checksum = compute_file_checksum(output_path)
            payload: Dict[str, Any] = {
                "source": resolved.dataset_id,
                "product_id": resolved.product_id,
                "region": region,
                "resolution_deg": resolution_deg,
                "temporal_resolution": temporal_resolution,
                "variables": ["uo", "vo"],
                "checksum": checksum,
                "status": "ok",
            }
            if downsample_info:
                payload["downsample"] = downsample_info
            return payload
        except Exception as e:
            last_error = str(e)
            logger.error(
                "%s currents attempt %d/%d failed: %s",
                region,
                attempt,
                MAX_CURRENTS_RETRIES,
                e,
            )
            _cleanup_partial_file(output_path, f"{region} currents")
            if attempt < MAX_CURRENTS_RETRIES:
                time.sleep(CURRENTS_FETCH_DELAY * attempt)

    return {
        "status": "failed",
        "source": resolved.dataset_id,
        "product_id": resolved.product_id,
        "region": region,
        "error": last_error,
    }


# =============================================================================
# Main Orchestration (expiry-based cache)
# =============================================================================


def _bounds_fetch_id(region: str, bounds: Dict[str, float]) -> str:
    """Deterministic cache key for a region + bounding box."""
    key = json.dumps({k: round(float(bounds[k]), 3) for k in sorted(bounds)}, sort_keys=True)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]
    return f"{region.lower()}-{digest}"


def _metadata_expired(metadata: CurrentsMetadata, now: Optional[datetime] = None) -> bool:
    """True if the cached fetch is past its valid_until expiry."""
    if now is None:
        now = datetime.now(timezone.utc)
    try:
        valid_until = parse_iso_utc(str(metadata.valid_until))
    except (TypeError, ValueError):
        return True
    return now >= valid_until


def _extent_changed(
    existing: CurrentsMetadata,
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
) -> bool:
    """True if the requested bounds/time window differ materially from the cache.

    The cached NetCDF only covers the box and window it was fetched for; a
    changed extent means the cache is stale and must not be reused.
    """
    old_bounds = existing.bounds or {}
    for key in ("min_lat", "max_lat", "min_lon", "max_lon"):
        try:
            if abs(float(old_bounds.get(key)) - float(bounds.get(key))) > 0.1:
                return True
        except (TypeError, ValueError):
            return True

    time_range = existing.time_range or {}
    try:
        old_start = parse_iso_utc(str(time_range["start"]))
        old_end = parse_iso_utc(str(time_range["end"]))
    except (KeyError, ValueError, TypeError):
        return True
    if abs((old_start - start_time).total_seconds()) > 3600:
        return True
    if abs((old_end - end_time).total_seconds()) > 3600:
        return True
    return False


def fetch_forecast_currents(
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    force: bool = False,
) -> CurrentsMetadata:
    """
    Fetch forecast surface currents for a bounding box and time window.

    Cached fetches are reused until valid_until (fetched_at + 12 h — forecast
    products update at least twice daily); a stale cache, a changed extent, or
    an invalid cached file triggers a refetch.

    Args:
        bounds: Dict with min_lat, max_lat, min_lon, max_lon
        start_time: Window start datetime (UTC)
        end_time: Window end datetime (UTC)
        force: If True, re-fetch even if cached

    Returns:
        CurrentsMetadata with fetch results (currents["status"] == "ok" on success)
    """
    region = detect_region(bounds)
    if region is None:
        raise ValueError(
            f"No regional forecast model covers bounds {bounds} "
            f"(overlap threshold {REGION_OVERLAP_THRESHOLD})"
        )

    fetch_id = _bounds_fetch_id(region, bounds)
    cache_dir = get_cache_dir(fetch_id)
    currents_path = cache_dir / "currents.nc"

    # Check for existing cache
    if not force:
        existing = load_currents_metadata(fetch_id)
        if existing and _metadata_expired(existing):
            logger.info(
                "Cached currents for %s expired (valid_until %s); refetching",
                fetch_id,
                existing.valid_until,
            )
            existing = None
        if existing and _extent_changed(existing, bounds, start_time, end_time):
            logger.info(
                "Requested extent (bounds/time window) changed since last fetch for %s; refetching",
                fetch_id,
            )
            existing = None
        if existing:
            if existing.currents and existing.currents.get("status") == "ok":
                ok, error = _validate_currents_file(currents_path)
                if ok:
                    logger.info("Forecast currents already cached for %s", fetch_id)
                    return existing
                logger.info("Cached currents invalid (%s); refetching", error)
            else:
                logger.info(
                    "Cached currents for %s recorded a failed fetch; retrying",
                    fetch_id,
                )

    fetched_at = datetime.now(timezone.utc)
    metadata = CurrentsMetadata(
        fetch_id=fetch_id,
        fetched_at=fetched_at.isoformat(),
        valid_until=(fetched_at + timedelta(hours=CACHE_VALIDITY_HOURS)).isoformat(),
        bounds=dict(bounds),
        time_range={
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        },
    )

    currents_result = fetch_regional_currents(region, bounds, start_time, end_time, currents_path)
    metadata.currents = currents_result or {
        "status": "failed",
        "error": "Current fetch returned None",
    }

    save_currents_metadata(metadata)
    logger.info("Forecast currents fetch complete for %s", fetch_id)
    return metadata


__all__ = [
    "CurrentsMetadata",
    "REGIONAL_MODELS",
    "REGION_PRIORITY",
    "ResolvedDataset",
    "detect_region",
    "fetch_forecast_currents",
    "fetch_regional_currents",
    "get_cache_dir",
    "load_currents_metadata",
    "save_currents_metadata",
    "compute_file_checksum",
]
