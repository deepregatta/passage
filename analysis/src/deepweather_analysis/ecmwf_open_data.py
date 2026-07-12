"""ECMWF open-data ingestion: IFS 0.25 deg msl/10u/10v -> cached NetCDF window.

Fetches one forecast cycle of the free ECMWF open data (CC-BY-4.0) via the
``ecmwf-opendata`` client (source "ecmwf", model IFS, resolution 0.25 deg):
parameters msl, 10u, 10v at steps 0..90 by 3 h. The global GRIB is decoded
with cfgrib/xarray, cropped to the North Atlantic window 35-65N, 35W-10E,
and cached as NetCDF under data/cache/ecmwf/<cycle>/fields.nc alongside a
metadata.json (cycle, fetched_at, checksum, licence, publication lag).

Cached dataset conventions (normalised at ingest so downstream code never
unit-sniffs):
- dims: step (int forecast hours), latitude (ascending), longitude
  (ascending, -180..180)
- variables: msl in hPa (attrs units="hPa"), u10/v10 in m/s
- coord valid_time (datetime64) = cycle time + step

Only ``fetch_fields`` touches the network; a fresh cache hit is returned
without any request.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Tuple

import numpy as np
import xarray as xr

from .paths import cache_dir

logger = logging.getLogger(__name__)

# Request shape: 3 params x one cycle's published steps. ECMWF open data
# publishes 00Z/12Z cycles 3-hourly to 144 h then 6-hourly to 240 h (10 days);
# 06Z/18Z cycles stop at 90 h. Request whatever the cycle actually offers.
PARAMS = ["msl", "10u", "10v"]
STEPS_SHORT = list(range(0, 91, 3))
STEPS_LONG = list(range(0, 145, 3)) + list(range(150, 241, 6))
# Backwards-compatible alias (short set is valid for every cycle).
STEPS = STEPS_SHORT


def steps_for_cycle(cycle_time: datetime) -> list[int]:
    """The step list a given cycle publishes (00Z/12Z reach 240 h)."""
    return STEPS_LONG if cycle_time.hour in (0, 12) else STEPS_SHORT


# North Atlantic crop window (route-independent synoptic board).
WINDOW: Dict[str, float] = {
    "min_lat": 35.0,
    "max_lat": 65.0,
    "min_lon": -35.0,
    "max_lon": 10.0,
}

MODEL = "ifs"
RESOL = "0p25"
DATASET_ID = "ifs-0.25-open-data"
LICENCE = "CC-BY-4.0, source: ECMWF open data"

# A cycle stays "current" ~12 h (next-but-one cycle lands by then).
CACHE_MAX_AGE_HOURS = 12.0


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cycle_str(cycle_time: datetime) -> str:
    """Canonical cycle label, e.g. '20260712T00Z'."""
    return cycle_time.astimezone(timezone.utc).strftime("%Y%m%dT%HZ")


def parse_cycle(cycle: str) -> datetime:
    """Parse '20260712T00Z' (or '2026-07-12T00Z') into an aware UTC datetime."""
    text = cycle.strip().upper().replace("-", "")
    if not text.endswith("Z"):
        raise ValueError(f"cycle must end with 'Z': {cycle!r}")
    dt = datetime.strptime(text[:-1], "%Y%m%dT%H")
    if dt.hour not in (0, 6, 12, 18):
        raise ValueError(f"cycle hour must be 00/06/12/18: {cycle!r}")
    return dt.replace(tzinfo=timezone.utc)


def compute_file_checksum(file_path: Path) -> str:
    """SHA256 checksum, 'sha256:<hex>' (same convention as environment_fetcher)."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha256.update(chunk)
    return f"sha256:{sha256.hexdigest()}"


def _normalise_lonlat(ds: xr.Dataset) -> xr.Dataset:
    """Longitudes to -180..180 ascending, latitudes ascending."""
    lon = ds["longitude"].values
    lon_wrapped = ((lon + 180.0) % 360.0) - 180.0
    if not np.array_equal(lon_wrapped, lon):
        ds = ds.assign_coords(longitude=lon_wrapped)
    ds = ds.sortby("longitude")
    if float(ds["latitude"].values[0]) > float(ds["latitude"].values[-1]):
        ds = ds.sortby("latitude")
    return ds


def _decode_grib(grib_path: Path, cycle_time: datetime) -> xr.Dataset:
    """Decode the open-data GRIB into the normalised, cropped dataset."""
    import cfgrib

    # msl (meanSea) and 10u/10v (heightAboveGround) live in different GRIB
    # hypercubes; open them all and merge after dropping scalar level coords.
    parts = cfgrib.open_datasets(str(grib_path), backend_kwargs={"indexpath": ""})
    cleaned = []
    for part in parts:
        drop = [
            name
            for name in ("heightAboveGround", "meanSea", "surface", "number", "time")
            if name in part.coords and part[name].ndim == 0
        ]
        cleaned.append(part.drop_vars(drop))
    ds = xr.merge(cleaned, compat="override", combine_attrs="drop_conflicts")

    missing = [v for v in ("msl", "u10", "v10") if v not in ds]
    if missing:
        raise RuntimeError(f"GRIB decode missing variables {missing}; got {list(ds.data_vars)}")

    # step: timedelta64 -> integer forecast hours.
    step_hours = (ds["step"].values / np.timedelta64(1, "h")).astype(int)
    ds = ds.assign_coords(step=("step", step_hours))
    if "valid_time" in ds.coords:
        ds = ds.drop_vars("valid_time")
    base = np.datetime64(cycle_time.replace(tzinfo=None), "ns")
    valid = base + step_hours.astype("timedelta64[h]")
    ds = ds.assign_coords(valid_time=("step", valid))

    ds = _normalise_lonlat(ds)
    ds = ds.sel(
        latitude=slice(WINDOW["min_lat"], WINDOW["max_lat"]),
        longitude=slice(WINDOW["min_lon"], WINDOW["max_lon"]),
    )

    # Pa -> hPa once, at ingest.
    msl = ds["msl"]
    if float(np.nanmean(msl.values)) > 10000.0:
        ds["msl"] = msl / 100.0
    ds["msl"].attrs = {"units": "hPa", "long_name": "mean sea level pressure"}
    ds["u10"].attrs = {"units": "m s-1", "long_name": "10 metre U wind component"}
    ds["v10"].attrs = {"units": "m s-1", "long_name": "10 metre V wind component"}
    ds = ds.transpose("step", "latitude", "longitude")
    return ds.load()


def _cache_paths(cycle: str) -> Tuple[Path, Path, Path]:
    root = cache_dir("ecmwf") / cycle
    return root, root / "fields.nc", root / "metadata.json"


def _load_cached(cycle: str) -> Tuple[xr.Dataset, Dict[str, Any]] | None:
    _, nc_path, meta_path = _cache_paths(cycle)
    if not (nc_path.exists() and meta_path.exists()):
        return None
    try:
        meta = json.loads(meta_path.read_text())
        ds = xr.open_dataset(nc_path).load()
        ds.close()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Ignoring unreadable ECMWF cache for %s: %s", cycle, exc)
        return None
    logger.info("ECMWF open-data cache hit for cycle %s", cycle)
    return ds, meta


def fetch_fields(
    cycle: str | None = None, *, force: bool = False, prefer_long: bool = False
) -> Tuple[xr.Dataset, Dict[str, Any]]:
    """
    Fetch (or load from cache) one IFS 0.25 open-data cycle, cropped to the
    North Atlantic window.

    Args:
        cycle: cycle label like '20260712T00Z'; None = latest available
               (resolved by the client; the resolved cycle is recorded).
        force: re-download even when a cache entry exists.
        prefer_long: with cycle=None, resolve the latest 00Z/12Z cycle whose
               full 240 h step set is published (up to ~12 h older than the
               freshest 06Z/18Z cycle, but 10 days deep instead of ~4).

    Returns:
        (dataset, meta): normalised xarray Dataset (msl hPa, u10/v10 m/s) and
        the metadata dict (cycle, cycle_time, fetched_at, checksum, licence,
        publication_lag_minutes, params, steps_h, window).
    """
    from ecmwf.opendata import Client

    client = Client(source="ecmwf", model=MODEL, resol=RESOL)
    request: Dict[str, Any] = {
        "type": "fc",
        "param": PARAMS,
        "step": STEPS_LONG if prefer_long else STEPS_SHORT,
    }

    if cycle is None:
        cycle_time = client.latest(**request)
        if cycle_time.tzinfo is None:
            cycle_time = cycle_time.replace(tzinfo=timezone.utc)
        cycle = cycle_str(cycle_time)
        logger.info("Latest available ECMWF open-data cycle: %s", cycle)
    else:
        cycle_time = parse_cycle(cycle)
        cycle = cycle_str(cycle_time)

    if not force:
        cached = _load_cached(cycle)
        if cached is not None:
            return cached

    cache_root, nc_path, meta_path = _cache_paths(cycle)
    cache_root.mkdir(parents=True, exist_ok=True)
    grib_path = cache_root / "fields.grib2"

    steps = steps_for_cycle(cycle_time)
    request.update(
        {"date": cycle_time.strftime("%Y-%m-%d"), "time": cycle_time.hour, "step": steps}
    )
    logger.info(
        "Retrieving ECMWF open data %s (%d params x %d steps, to +%d h)",
        cycle,
        len(PARAMS),
        len(steps),
        steps[-1],
    )
    fetch_started = datetime.now(timezone.utc)
    try:
        client.retrieve(request, str(grib_path))
    except Exception:
        if steps == STEPS_SHORT:
            raise
        # a 00Z/12Z cycle whose long tail is not fully published yet: take the
        # guaranteed short set rather than failing the whole prepare-run
        logger.warning("Long step set unavailable for %s; falling back to 0–90 h", cycle)
        steps = list(STEPS_SHORT)
        request["step"] = steps
        client.retrieve(request, str(grib_path))
    fetched_at = datetime.now(timezone.utc)

    try:
        ds = _decode_grib(grib_path, cycle_time)
        ds.attrs.update(
            {
                "cycle": cycle,
                "model": DATASET_ID,
                "licence": LICENCE,
            }
        )
        if nc_path.exists():
            nc_path.unlink()
        ds.to_netcdf(nc_path)
    finally:
        # The global GRIB is bulky; the cropped NetCDF is the cache artifact.
        grib_path.unlink(missing_ok=True)
        idx = grib_path.with_suffix(grib_path.suffix + ".idx")
        idx.unlink(missing_ok=True)

    lag_minutes = round((fetched_at - cycle_time).total_seconds() / 60.0, 1)
    meta: Dict[str, Any] = {
        "cycle": cycle,
        "cycle_time": _iso_z(cycle_time),
        "fetched_at": _iso_z(fetched_at),
        "fetch_seconds": round((fetched_at - fetch_started).total_seconds(), 1),
        "checksum": compute_file_checksum(nc_path),
        "licence": LICENCE,
        "dataset_id": DATASET_ID,
        "params": list(PARAMS),
        "steps_h": list(steps),
        "window": dict(WINDOW),
        # Cycle nominal time vs wall clock at fetch: upper bound on how long
        # after the cycle the data became available (true publication lag is
        # <= this; measured exactly only when fetching right at publication).
        "publication_lag_minutes": lag_minutes,
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    logger.info("Cached ECMWF fields for %s at %s (lag %.0f min)", cycle, nc_path, lag_minutes)
    return ds, meta


__all__ = [
    "PARAMS",
    "STEPS",
    "STEPS_SHORT",
    "STEPS_LONG",
    "steps_for_cycle",
    "WINDOW",
    "DATASET_ID",
    "LICENCE",
    "cycle_str",
    "parse_cycle",
    "compute_file_checksum",
    "fetch_fields",
]
