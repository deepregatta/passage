"""Publish a land-mask artifact for the routing engine.

Rasterizes global_land_mask's GLOBE-derived land/sea lookup over a lat/lon
window (default: the Channel) into a flat 0/1 array artifact at
data/processed/runs/land_mask.json, and registers it in
data/processed/runs/latest.json under artifacts.land_mask.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from global_land_mask import globe

from .latest import update_latest
from .paths import processed_dir

__all__ = ["publish_land_mask", "CHANNEL_BOUNDS"]

# Default window: the English Channel.
CHANNEL_BOUNDS: dict[str, float] = {
    "min_lat": 49.0,
    "max_lat": 51.2,
    "min_lon": -6.0,
    "max_lon": 0.0,
}

_ARTIFACT_FILENAME = "land_mask.json"


def publish_land_mask(
    bounds: dict[str, float] | None = None,
    resolution_deg: float = 0.02,
    *,
    runs_dir: Path | None = None,
) -> Path:
    """Compute the land mask over `bounds` and publish the artifact.

    The artifact is a row-major flat array: land[i * nlon + j] is 1 for land
    at (lat0 + i*dlat, lon0 + j*dlon), 0 for sea. Also merges
    artifacts.land_mask into runs/latest.json without dropping existing keys.

    Returns the path of the written artifact.
    """
    bounds = bounds or CHANNEL_BOUNDS
    target_dir = runs_dir if runs_dir is not None else processed_dir("runs")
    target_dir.mkdir(parents=True, exist_ok=True)

    lat0 = float(bounds["min_lat"])
    lon0 = float(bounds["min_lon"])
    nlat = int(round((float(bounds["max_lat"]) - lat0) / resolution_deg)) + 1
    nlon = int(round((float(bounds["max_lon"]) - lon0) / resolution_deg)) + 1

    lats = lat0 + resolution_deg * np.arange(nlat)
    lons = lon0 + resolution_deg * np.arange(nlon)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    land = globe.is_land(lat_grid, lon_grid).astype(int)  # shape (nlat, nlon)

    artifact = {
        "schema_version": 1,
        "kind": "land_mask",
        "lat0": lat0,
        "lon0": lon0,
        "dlat": resolution_deg,
        "dlon": resolution_deg,
        "nlat": nlat,
        "nlon": nlon,
        "land": land.ravel().tolist(),  # index i*nlon + j (C order)
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {"mode": "live", "dataset_id": "global-land-mask GLOBE"},
    }

    out_path = target_dir / _ARTIFACT_FILENAME
    out_path.write_text(json.dumps(artifact) + "\n", encoding="utf-8")

    update_latest(target_dir, None, {"land_mask": f"runs/{_ARTIFACT_FILENAME}"})
    return out_path
