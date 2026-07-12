# Vendored from coachregatta analysis/src/coachregatta_analysis/environment_fetcher.py, 2026-07-12
"""ERA5/ERA5T reanalysis fetch for the verification layer (brief §9).

Vendored machinery from coachregatta's ``fetch_era5_weather``: cdsapi client,
ERA5 vs ERA5T tier selection by event age (< 90 days -> ERA5T), request
shaping ([N, W, S, E] area, year/month/day/time lists), NetCDF output and
SHA-256 checksum, per-case metadata.json cache.

deepweather adaptations (marked inline):
- variables fixed to 10u/10v/msl (the verification set);
- cache lives under data/cache/era5/<case-id>/ via paths.cache_dir;
- 3-hourly time shaping by default (the corpus replays detection per 3 h
  step — hourly would only inflate the CDS queue);
- no fetch-window buffer (corpus windows are explicit, unlike race tracks);
- new-CDS request keys (data_format/download_format) — the CDS migration of
  2024 renamed them; on the new CDS, ERA5T is served transparently from the
  same dataset for recent dates, so the tier flag is provenance labelling,
  not a different request;
- env overrides use the DEEPWEATHER_* prefix.

§9: ERA5 is a verification REFERENCE only — reanalysis assimilates
observations but is not independent ground truth ('reanalysis-referenced').
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from ..paths import cache_dir

logger = logging.getLogger(__name__)

# ERA5 variables for the verification set: 10 m wind + MSLP.
ERA5_VARIABLES = [
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "mean_sea_level_pressure",
]

ERA5_RESOLUTION_DEG = 0.25
ERA5T_AGE_DAYS = 90  # events younger than this get the preliminary tier

WEATHER_MAX_REQUEST_POINTS = int(os.getenv("DEEPWEATHER_ERA5_MAX_REQUEST_POINTS", "20000000"))


def compute_file_checksum(file_path: Path) -> str:
    """Compute SHA256 checksum of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return f"sha256:{sha256.hexdigest()}"


def _cleanup_partial_file(file_path: Path, label: str) -> None:
    """Remove a partial/corrupt download so later runs do not reuse it."""
    if not file_path.exists():
        return
    try:
        file_path.unlink()
        logger.warning("Removed incomplete %s file at %s", label, file_path)
    except OSError as exc:
        logger.warning("Failed to remove incomplete %s file at %s: %s", label, file_path, exc)


def _check_cdsapi() -> bool:
    try:
        import cdsapi  # type: ignore[import-untyped]  # noqa: F401

        return True
    except ImportError:
        return False


def event_age_days(start_time: datetime) -> int:
    """Event age in days (drives the ERA5 vs ERA5T tier label)."""
    now = datetime.now(timezone.utc)
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    return (now - start_time).days


def _estimate_request_grid_points(
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    *,
    resolution_deg: float,
    time_hours: int,
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
    lon_span = abs(max_lon - min_lon)
    duration_hours = max(0.0, (end_time - start_time).total_seconds() / 3600.0)
    lat_points = max(1, int(math.ceil(lat_span / resolution_deg)) + 1)
    lon_points = max(1, int(math.ceil(lon_span / resolution_deg)) + 1)
    time_points = max(1, int(math.ceil(duration_hours / time_hours)) + 1)
    return lat_points * lon_points * time_points


def get_case_cache_dir(case_id: str) -> Path:
    """Cache directory for one corpus case: data/cache/era5/<case-id>/."""
    path = cache_dir("era5") / case_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_case_metadata(case_id: str) -> Optional[Dict[str, Any]]:
    meta_path = get_case_cache_dir(case_id) / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to load ERA5 metadata for %s: %s", case_id, exc)
        return None


def _save_case_metadata(case_id: str, metadata: Dict[str, Any]) -> Path:
    meta_path = get_case_cache_dir(case_id) / "metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2) + "\n")
    return meta_path


def _extent_matches(
    existing: Dict[str, Any],
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
) -> bool:
    """True if the cached extent matches the request (coachregatta pattern)."""
    old_bounds = existing.get("bounds") or {}
    for key in ("min_lat", "max_lat", "min_lon", "max_lon"):
        try:
            if abs(float(old_bounds.get(key)) - float(bounds.get(key))) > 0.1:
                return False
        except (TypeError, ValueError):
            return False
    time_range = existing.get("time_range") or {}
    try:
        old_start = datetime.fromisoformat(str(time_range["start"]))
        old_end = datetime.fromisoformat(str(time_range["end"]))
    except (KeyError, ValueError, TypeError):
        return False
    if abs((old_start - start_time).total_seconds()) > 3600:
        return False
    if abs((old_end - end_time).total_seconds()) > 3600:
        return False
    return True


def fetch_era5_weather(
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    output_path: Path,
    use_era5t: bool = False,
    *,
    time_step_h: int = 3,
) -> Optional[Dict[str, Any]]:
    """
    Fetch ERA5 or ERA5T weather data (10u/10v/msl) as NetCDF.

    Args:
        bounds: Dict with min_lat, max_lat, min_lon, max_lon
        start_time: Start datetime (UTC)
        end_time: End datetime (UTC)
        output_path: Path to save NetCDF file
        use_era5t: If True, label the fetch ERA5T (preliminary, ~5-day latency)
        time_step_h: hour spacing of requested analysis times (default 3)

    Returns:
        SourceInfo dict on success, None on failure
    """
    if not _check_cdsapi():
        logger.error("cdsapi not installed. Run: pip install cdsapi")
        return None

    import cdsapi

    tier = "1T" if use_era5t else "1"
    source = "ERA5T" if use_era5t else "ERA5"

    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    if end_time.tzinfo is None:
        end_time = end_time.replace(tzinfo=timezone.utc)

    # deepweather: no fetch buffer — corpus windows are explicit.
    fetch_start = start_time
    fetch_end = end_time

    dates = []
    current = fetch_start.date()
    while current <= fetch_end.date():
        dates.append(current)
        current += timedelta(days=1)

    # Group by year/month for the API (vendored shape; corpus windows sit
    # within one month so the cartesian product is exact).
    years = sorted(set(d.year for d in dates))
    months = sorted(set(d.month for d in dates))
    days = sorted(set(d.day for d in dates))

    estimated_points = _estimate_request_grid_points(
        bounds,
        fetch_start,
        fetch_end,
        resolution_deg=ERA5_RESOLUTION_DEG,
        time_hours=time_step_h,
    )
    if estimated_points is not None and estimated_points > WEATHER_MAX_REQUEST_POINTS:
        error = (
            f"{source} request too large ({estimated_points:,} estimated grid "
            f"points > {WEATHER_MAX_REQUEST_POINTS:,})"
        )
        logger.warning("Skipping %s weather fetch: %s", source, error)
        _cleanup_partial_file(output_path, f"{source} weather")
        return {
            "source": source,
            "tier": tier,
            "resolution_deg": ERA5_RESOLUTION_DEG,
            "variables": ["u10", "v10", "msl"],
            "status": "unavailable",
            "error": error,
        }

    request = {
        "product_type": ["reanalysis"],
        # deepweather: new-CDS keys ('format: netcdf' was the pre-2024 name).
        "data_format": "netcdf",
        "download_format": "unarchived",
        "variable": ERA5_VARIABLES,
        "year": [str(y) for y in years],
        "month": [f"{m:02d}" for m in months],
        "day": [f"{d:02d}" for d in days],
        "time": [f"{h:02d}:00" for h in range(0, 24, max(1, time_step_h))],
        "area": [
            bounds["max_lat"],  # North
            bounds["min_lon"],  # West
            bounds["min_lat"],  # South
            bounds["max_lon"],  # East
        ],
    }

    logger.info("Fetching %s weather for %s to %s", source, fetch_start.date(), fetch_end.date())

    try:
        # DEEPWEATHER_CDSAPI_URL/KEY override ~/.cdsapirc when set.
        url = os.getenv("DEEPWEATHER_CDSAPI_URL")
        key = os.getenv("DEEPWEATHER_CDSAPI_KEY")
        client = cdsapi.Client(url=url, key=key) if url or key else cdsapi.Client()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        client.retrieve("reanalysis-era5-single-levels", request, str(output_path))

        checksum = compute_file_checksum(output_path)
        return {
            "source": source,
            "tier": tier,
            "resolution_deg": ERA5_RESOLUTION_DEG,
            "variables": ["u10", "v10", "msl"],
            "checksum": checksum,
            "status": "ok",
        }
    except Exception as e:
        logger.error("Failed to fetch %s: %s", source, e)
        _cleanup_partial_file(output_path, f"{source} weather")
        return {
            "source": source,
            "tier": tier,
            "resolution_deg": ERA5_RESOLUTION_DEG,
            "variables": ["u10", "v10", "msl"],
            "status": "failed",
            "error": str(e),
        }


def fetch_era5_case(
    case_id: str,
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    *,
    time_step_h: int = 3,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Fetch (or reuse cached) ERA5/ERA5T fields for one corpus case.

    Tier by event age (coachregatta pattern): < 90 days -> ERA5T ('1T'),
    otherwise final ERA5 ('1').

    Returns a metadata dict {case_id, status, path, source, tier, checksum,
    bounds, time_range, fetched_at, cached}; status != 'ok' means the NetCDF
    is not usable (error carries the reason).
    """
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    if end_time.tzinfo is None:
        end_time = end_time.replace(tzinfo=timezone.utc)

    case_dir = get_case_cache_dir(case_id)
    weather_path = case_dir / "weather.nc"

    if not force:
        existing = _load_case_metadata(case_id)
        if (
            existing
            and existing.get("status") == "ok"
            and weather_path.exists()
            and _extent_matches(existing, bounds, start_time, end_time)
        ):
            logger.info("ERA5 already cached for case %s", case_id)
            return {**existing, "cached": True}

    use_era5t = event_age_days(start_time) < ERA5T_AGE_DAYS
    result = fetch_era5_weather(
        bounds, start_time, end_time, weather_path, use_era5t=use_era5t, time_step_h=time_step_h
    ) or {"status": "failed", "error": "cdsapi unavailable"}

    metadata: Dict[str, Any] = {
        "case_id": case_id,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "bounds": dict(bounds),
        "time_range": {"start": start_time.isoformat(), "end": end_time.isoformat()},
        "time_step_h": time_step_h,
        "path": str(weather_path),
        "cached": False,
        **result,
    }
    _save_case_metadata(case_id, metadata)
    return metadata


def _open_nc_robust(path: Path) -> Any:
    """Open a NetCDF/HDF5 file trying netcdf4 then h5netcdf engines."""
    import xarray as xr

    last_exc: Exception = RuntimeError("No engines available")
    for engine in ("netcdf4", "h5netcdf"):
        try:
            return xr.open_dataset(path, engine=engine)
        except Exception as exc:
            last_exc = exc
    raise last_exc


def open_case_dataset(case_id: str) -> Tuple[Any, Dict[str, Any]]:
    """
    Open a cached case NetCDF as an xarray Dataset, normalised for detection:
    time coordinate named 'time', 'expver'/'number' dims reduced away.

    Returns (dataset, metadata). Raises FileNotFoundError when the case has
    no usable cache.
    """
    metadata = _load_case_metadata(case_id)
    if not metadata or metadata.get("status") != "ok":
        raise FileNotFoundError(f"No usable ERA5 cache for case '{case_id}' — fetch it first")
    path = Path(metadata["path"])
    if not path.exists():
        raise FileNotFoundError(f"ERA5 cache file missing for case '{case_id}': {path}")

    ds = _open_nc_robust(path)
    # New-CDS NetCDF names the time axis 'valid_time'.
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    # ERA5/ERA5T mixtures carry an 'expver' dim: values are identical where
    # both exist and NaN otherwise, so a skipna mean collapses it faithfully.
    if "expver" in ds.dims:
        ds = ds.mean("expver", skipna=True, keep_attrs=True)
    if "number" in ds.dims and ds.sizes["number"] == 1:
        ds = ds.squeeze("number", drop=True)
    return ds, metadata


__all__ = [
    "ERA5_VARIABLES",
    "ERA5_RESOLUTION_DEG",
    "ERA5T_AGE_DAYS",
    "compute_file_checksum",
    "event_age_days",
    "fetch_era5_case",
    "fetch_era5_weather",
    "get_case_cache_dir",
    "open_case_dataset",
]
