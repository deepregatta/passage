"""Publish a land-mask artifact for the routing engine.

Rasterizes global_land_mask's GLOBE-derived land/sea lookup over a lat/lon
window (default: the Channel) into a flat 0/1 array artifact at
data/processed/runs/land_mask.json, and registers it in
data/processed/runs/latest.json under artifacts.land_mask.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from global_land_mask import globe

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

    _register_artifact(target_dir, "land_mask", f"runs/{_ARTIFACT_FILENAME}")
    return out_path


def _read_latest(latest_path: Path) -> dict:
    """Read latest.json, retrying briefly if a concurrent writer left it
    mid-write. Never silently discards existing content."""
    if not latest_path.exists():
        return {}
    last_error: Exception | None = None
    for _ in range(5):
        text = latest_path.read_text(encoding="utf-8")
        if not text.strip():
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:  # concurrent writer mid-write?
            last_error = exc
            time.sleep(0.1)
    raise RuntimeError(
        f"Could not parse {latest_path} after retries; refusing to overwrite it"
    ) from last_error


def _register_artifact(runs_dir: Path, key: str, rel_path: str) -> None:
    """Read-modify-write latest.json, merging artifacts.<key> = rel_path.

    Re-reads the file immediately before writing and preserves every existing
    key (current_grid, synoptic entries, etc. may be added concurrently).
    """
    latest_path = runs_dir / "latest.json"
    latest = _read_latest(latest_path)
    artifacts = latest.get("artifacts")
    if not isinstance(artifacts, dict):
        artifacts = {}
    artifacts[key] = rel_path
    latest["artifacts"] = artifacts
    latest_path.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")
