"""Region-grid artifact preparation: CMEMS forecast currents -> current_grid.json.

Fetches forecast surface currents (via the vendored environment_fetcher),
stride-subsamples the native grid to a regular ~0.05 deg lat/lon hourly grid,
gap-fills coastal NaNs with the vendored KDTree fill, converts m/s to knots,
and publishes a region-grid JSON artifact (contracts/region-grid.schema.json)
under data/processed/runs/<run_id>/current_grid.json plus a latest.json pointer.

Regridding note: the native CMEMS grid is regular; when it is finer than the
target resolution we stride-subsample (pick every Nth native grid line, no
smoothing), so artifact values are exact native cell values. When the native
grid is coarser than the target (e.g. NWS ~0.11 deg) the native grid is kept
and the artifact carries an under_resolved_note.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from . import environment_fetcher as fetcher
from .environment_grid import EnvironmentGrid
from .paths import contracts_dir, processed_dir
from .route_sources import currents_bounds
from .timeutil import iso_z as _iso_z
from .timeutil import parse_iso_utc
from .units import MS_TO_KNOTS

logger = logging.getLogger(__name__)

TARGET_RESOLUTION_DEG = 0.05
DEFAULT_WINDOW_HOURS = 120  # CMEMS IBI publishes ~5 days of forecast currents
SCHEMA_VERSION = 1


# Types for the legacy aliases resolved lazily by __getattr__.
CHANNEL_BOUNDS: Dict[str, float]


def __getattr__(name: str):
    """Resolve the historical default-corridor alias only on explicit access."""
    if name == "CHANNEL_BOUNDS":
        return currents_bounds()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _regular_axis(values: np.ndarray, name: str) -> tuple[float, float]:
    """Return (origin, step) for a regular ascending axis; fail loudly otherwise."""
    if values.size < 2:
        raise ValueError(f"{name} axis has fewer than 2 points")
    diffs = np.diff(values)
    step = float(np.median(diffs))
    if step <= 0:
        raise ValueError(f"{name} axis is not ascending")
    if np.max(np.abs(diffs - step)) > max(1e-4, 0.01 * step):
        raise ValueError(f"{name} axis is not regular (steps {diffs.min()}..{diffs.max()})")
    return float(values[0]), step


def _stride_axis(values: np.ndarray, native_step: float, target_step: float) -> int:
    """Stride so the subsampled axis approaches the target resolution."""
    if native_step >= target_step:
        return 1
    return max(1, round(target_step / native_step))


def _load_region_grid_schema() -> Dict[str, Any]:
    schema_path = contracts_dir() / "region-grid.schema.json"
    return json.loads(schema_path.read_text())


def prepare_current_grid(
    bounds: Optional[Dict[str, float]] = None,
    start: str | datetime | None = None,
    end: str | datetime | None = None,
    *,
    target_resolution_deg: float = TARGET_RESOLUTION_DEG,
    force: bool = False,
    route_id: str | None = None,
) -> Path:
    """
    Fetch forecast currents and publish a region-grid artifact.

    Args:
        bounds: min_lat/max_lat/min_lon/max_lon dict; defaults to the route's
            corridor window from config/route-sources.json (default route when
            route_id is omitted)
        start: window start (ISO or datetime); default now (floored to the hour)
        end: window end; default start + 72 h
        target_resolution_deg: target regular grid resolution (~0.05 deg)
        force: re-fetch even when a fresh cache exists
        route_id: route-sources registry key for the default bounds

    Returns:
        Path to the written current_grid.json artifact.
    """
    bounds = dict(bounds or currents_bounds(route_id))
    start_time = (
        parse_iso_utc(start)
        if start is not None
        else datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    )
    end_time = (
        parse_iso_utc(end)
        if end is not None
        else start_time + timedelta(hours=DEFAULT_WINDOW_HOURS)
    )
    if end_time <= start_time:
        raise ValueError(f"end ({end_time}) must be after start ({start_time})")

    # 1. Detect region (regional models first — IBI/NWS/MED/BAL — then global GLO).
    region = fetcher.detect_region(bounds)
    if region is None:
        raise RuntimeError(f"No regional forecast model covers bounds {bounds}")
    logger.info("Region %s selected for bounds %s", region, bounds)

    # 2. Fetch forecast currents into data/cache/environment/.
    metadata = fetcher.fetch_forecast_currents(bounds, start_time, end_time, force=force)
    currents_info = metadata.currents or {}
    if currents_info.get("status") != "ok":
        raise RuntimeError(
            f"Forecast currents fetch failed for {region}: "
            f"{currents_info.get('error', 'unknown error')}"
        )

    currents_path = fetcher.get_cache_dir(metadata.fetch_id) / "currents.nc"

    # 3-5. Load, stride-subsample to a regular grid, gap-fill, convert to knots.
    with EnvironmentGrid(currents_path=currents_path) as grid:
        if not grid.has_currents:
            raise RuntimeError(f"Cached currents at {currents_path} could not be loaded")
        artifact = _build_grid_artifact(
            grid,
            bounds=bounds,
            start_time=start_time,
            end_time=end_time,
            target_resolution_deg=target_resolution_deg,
            region=region,
            dataset_id=str(currents_info.get("source")),
            native_resolution_deg=currents_info.get("resolution_deg"),
            fetched_at=metadata.fetched_at,
        )

    # 7. Validate against the contract schema before writing (fail loudly).
    import jsonschema

    schema = _load_region_grid_schema()
    jsonschema.validate(instance=artifact, schema=schema)

    # 6. Write artifact + latest.json pointer.
    run_id = artifact["run_id"]
    run_dir = processed_dir("runs", run_id)
    artifact_path = run_dir / "current_grid.json"
    artifact_path.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")

    runs_dir = processed_dir("runs")
    latest_path = runs_dir / "latest.json"
    latest: Dict[str, Any] = {}
    if latest_path.exists():
        try:
            latest = json.loads(latest_path.read_text())
        except (json.JSONDecodeError, OSError):
            latest = {}
    latest["run_id"] = run_id
    artifacts = latest.get("artifacts")
    if not isinstance(artifacts, dict):
        artifacts = {}
    artifacts["current_grid"] = f"runs/{run_id}/current_grid.json"
    latest["artifacts"] = artifacts
    latest_path.write_text(json.dumps(latest, indent=2) + "\n")

    logger.info("Published %s (latest.json updated)", artifact_path)
    return artifact_path


def _build_grid_artifact(
    grid: EnvironmentGrid,
    *,
    bounds: Dict[str, float],
    start_time: datetime,
    end_time: datetime,
    target_resolution_deg: float,
    region: str,
    dataset_id: str,
    native_resolution_deg: Optional[float],
    fetched_at: str,
) -> Dict[str, Any]:
    """Build the region-grid artifact dict from a loaded currents grid."""
    ds = grid.dataset
    assert ds is not None
    lat_coord, lon_coord, time_coord = grid._get_coord_names(ds)

    native_lats = np.asarray(ds[lat_coord].values, dtype=float).reshape(-1)
    native_lons = np.asarray(ds[lon_coord].values, dtype=float).reshape(-1)
    lat_indices = np.arange(native_lats.size)
    lon_indices = np.arange(native_lons.size)
    if native_lats[0] > native_lats[-1]:
        native_lats = native_lats[::-1]
        lat_indices = lat_indices[::-1]
    if native_lons[0] > native_lons[-1]:
        native_lons = native_lons[::-1]
        lon_indices = lon_indices[::-1]

    # Crop to the requested bounds (the fetch adds a small buffer window).
    lat_mask = (native_lats >= bounds["min_lat"] - 1e-9) & (native_lats <= bounds["max_lat"] + 1e-9)
    lon_mask = (native_lons >= bounds["min_lon"] - 1e-9) & (native_lons <= bounds["max_lon"] + 1e-9)
    native_lats, lat_indices = native_lats[lat_mask], lat_indices[lat_mask]
    native_lons, lon_indices = native_lons[lon_mask], lon_indices[lon_mask]

    _, native_dlat = _regular_axis(native_lats, "latitude")
    _, native_dlon = _regular_axis(native_lons, "longitude")

    # Stride-subsample when the native grid is finer than the target resolution.
    stride_lat = _stride_axis(native_lats, native_dlat, target_resolution_deg)
    stride_lon = _stride_axis(native_lons, native_dlon, target_resolution_deg)
    target_lats = native_lats[::stride_lat]
    target_lons = native_lons[::stride_lon]
    lat0, dlat = _regular_axis(target_lats, "strided latitude")
    lon0, dlon = _regular_axis(target_lons, "strided longitude")
    nlat = int(target_lats.size)
    nlon = int(target_lons.size)

    under_resolved_note: Optional[str] = None
    if stride_lat > 1 or stride_lon > 1:
        under_resolved_note = (
            f"stride-subsampled x{max(stride_lat, stride_lon)} from native "
            f"{native_dlat:.4f} deg to {dlat:.4f} deg (target {target_resolution_deg} deg); "
            "values are exact native cell values, no smoothing"
        )
    elif native_dlat > target_resolution_deg + 1e-9:
        under_resolved_note = (
            f"native resolution {native_dlat:.4f} deg is coarser than the "
            f"{target_resolution_deg} deg target; native grid kept"
        )

    # Hourly time axis: the dataset's native (hourly) steps within the window.
    native_times = np.asarray(ds[time_coord].values).reshape(-1).astype("datetime64[s]")
    time_indices = np.argsort(native_times)
    native_times = native_times[time_indices]
    window_start = np.datetime64(start_time.replace(tzinfo=None), "s")
    window_end = np.datetime64(end_time.replace(tzinfo=None), "s")
    time_mask = (native_times >= window_start) & (native_times <= window_end)
    times = native_times[time_mask]
    if times.size == 0:
        raise RuntimeError(
            f"No forecast timesteps within {start_time.isoformat()}..{end_time.isoformat()}"
        )
    time_axis = [
        _iso_z(datetime.fromtimestamp(int(t.astype("int64")), tz=timezone.utc)) for t in times
    ]
    times_epoch = times.astype("int64")
    ntime = int(times.size)

    # These are exact native nodes and timesteps: select directly instead of
    # interpolating (which can turn a wet cell beside a NaN into another NaN).
    selected = ds.isel(
        {
            lat_coord: lat_indices[::stride_lat],
            lon_coord: lon_indices[::stride_lon],
            time_coord: time_indices[time_mask],
        }
    )

    def _surface_values(name: str) -> np.ndarray:
        var = selected[name]
        if "depth" in var.dims:
            var = var.isel(depth=0)
        # Copy: coastal fill mutates arrays; never modify the source dataset.
        # Match linear interpolation's float precision before knot rounding.
        values = var.transpose(time_coord, lat_coord, lon_coord).values
        return np.asarray(values, dtype=float).reshape(-1).copy()

    u_ms, v_ms = _surface_values("uo"), _surface_values("vo")

    # 4. Preserve the existing KDTree pair fill and distance limit. Only masked
    # native cells need lookup; unresolved land cells remain NaN -> null.
    if grid.has_coastal_fill:
        lat_flat = np.tile(np.repeat(target_lats, nlon), ntime)
        lon_flat = np.tile(target_lons, nlat * ntime)
        time_flat = np.repeat(times_epoch, nlat * nlon)
        u_ms, v_ms = grid._fill_coastal_gaps(u_ms, v_ms, lat_flat, lon_flat, time_flat)

    # 5. m/s -> knots, rounded to 0.01.
    u_kt = np.round(u_ms * MS_TO_KNOTS, 2)
    v_kt = np.round(v_ms * MS_TO_KNOTS, 2)

    def _to_json_list(arr: np.ndarray) -> List[Optional[float]]:
        return [None if not math.isfinite(x) else float(x) for x in arr.tolist()]

    fetched_dt = parse_iso_utc(fetched_at)
    run_id = f"cmems-{region.lower()}-{fetched_dt.strftime('%Y%m%dT%H')}Z"

    resolution_deg = (
        float(native_resolution_deg) if native_resolution_deg is not None else float(dlat)
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "surface_current",
        "run_id": run_id,
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "lat0": lat0,
        "lon0": lon0,
        "dlat": dlat,
        "dlon": dlon,
        "nlat": nlat,
        "nlon": nlon,
        "time_axis": time_axis,
        "u_kt": _to_json_list(u_kt),
        "v_kt": _to_json_list(v_kt),
        "under_resolved_note": under_resolved_note,
        "source": {
            "mode": "live",
            "dataset_id": dataset_id,
            "resolution_deg": resolution_deg,
            "fetched_at": _iso_z(fetched_dt),
        },
    }


__all__ = [
    "CHANNEL_BOUNDS",
    "TARGET_RESOLUTION_DEG",
    "MS_TO_KNOTS",
    "prepare_current_grid",
]
