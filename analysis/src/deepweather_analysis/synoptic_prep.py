"""Synoptic prepared-run publishing: ECMWF fields -> features/charts/wind grid/manifest.

Orchestrates the route-independent per-model-run pipeline (brief §4.1):
1. fetch the ECMWF open-data cycle (ecmwf_open_data.fetch_fields);
2. detect pressure systems per step, track them, run named-regime rules on
   the analysis step;
3. render synoptic chart panels with auto-captions;
4. publish under data/processed/runs/<run_id>/ (run_id =
   "ecmwf-ifs025-<cycle>"):
   - synoptic/features.json   (contracts/synoptic-features.schema.json;
     route_transitions stays [] — that detection is the TS engine's job)
   - synoptic/charts/tNNN.png
   - wind_grid.json           (contracts/region-grid.schema.json, kind
     "wind10m", Channel window, native 0.25 deg, kt)
   - run.json                 (contracts/prepared-run.schema.json)
5. merge data/processed/runs/latest.json read-modify-write, never dropping
   existing artifacts (the CMEMS current_grid in particular).

Every artifact is jsonschema-validated against its contract before the final
write.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from .ecmwf_open_data import fetch_fields, parse_cycle
from .paths import contracts_dir, processed_dir
from .synoptic import detect_systems, detect_mistral, render_panels, track_systems

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
MS_TO_KNOTS = 1.9438445
RUN_ID_PREFIX = "ecmwf-ifs025"
MODEL_NAME = "ECMWF IFS 0.25 deg (open data)"
VALID_HOURS = 12  # next-but-one cycle supersedes this run

# Channel wind-grid window (native 0.25 deg kept).
WIND_BOUNDS: Dict[str, float] = {
    "min_lat": 49.0,
    "max_lat": 51.0,
    "min_lon": -6.0,
    "max_lon": 0.0,
}

DEFAULT_PANEL_STEPS = (0, 24, 48, 72)


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _validate(artifact: Dict[str, Any], schema_file: str) -> None:
    import jsonschema

    schema = json.loads((contracts_dir() / schema_file).read_text())
    jsonschema.validate(instance=artifact, schema=schema)


def _write_json(path: Path, artifact: Dict[str, Any], schema_file: str) -> None:
    """Validate against the contract, then write (never write invalid JSON)."""
    _validate(artifact, schema_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")


def _mslp_hpa(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if np.nanmean(values) > 10000.0:  # tolerate Pa input
        values = values / 100.0
    return values


def _build_features(
    run_id: str,
    cycle_time: datetime,
    systems: List[Dict],
    regimes: List[Dict],
    chart_captions: List[Dict],
) -> Dict[str, Any]:
    out_systems = []
    for system in systems:
        track = [
            {
                "step_h": p["step_h"],
                "valid_time": _iso_z(cycle_time + timedelta(hours=p["step_h"])),
                "lat": round(p["lat"], 3),
                "lon": round(p["lon"], 3),
                "center_hpa": p["center_hpa"],
                "closed_contour": p["closed_contour"],
            }
            for p in system["track"]
        ]
        out_systems.append(
            {
                "system_id": system["system_id"],
                "kind": system["kind"],
                "track": track,
                "deepening_hpa_per_24h": system["deepening_hpa_per_24h"],
                "motion": system["motion"],
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "systems": out_systems,
        # Front-like transition detection along routes is the TS engine's job.
        "route_transitions": [],
        "regimes": regimes,
        "chart_captions": chart_captions,
    }


def _build_wind_grid(ds, run_id: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    """Region-grid artifact (kind wind10m) over the Channel window, native res."""
    sub = ds.sel(
        latitude=slice(WIND_BOUNDS["min_lat"], WIND_BOUNDS["max_lat"]),
        longitude=slice(WIND_BOUNDS["min_lon"], WIND_BOUNDS["max_lon"]),
    )
    lats = np.asarray(sub["latitude"].values, dtype=float)
    lons = np.asarray(sub["longitude"].values, dtype=float)
    if lats.size < 2 or lons.size < 2:
        raise RuntimeError(f"Wind window {WIND_BOUNDS} not covered by the dataset")
    steps = np.asarray(sub["step"].values).astype(int).reshape(-1)

    cycle_time = parse_cycle(meta["cycle"])
    time_axis = [_iso_z(cycle_time + timedelta(hours=int(h))) for h in steps]

    # (step, lat, lon) ravel matches index = (t*nlat + i)*nlon + j.
    u_kt = np.round(np.asarray(sub["u10"].values, dtype=float) * MS_TO_KNOTS, 2)
    v_kt = np.round(np.asarray(sub["v10"].values, dtype=float) * MS_TO_KNOTS, 2)

    def _to_json_list(arr: np.ndarray) -> List[Optional[float]]:
        return [None if not np.isfinite(x) else float(x) for x in arr.ravel().tolist()]

    dlat = float(np.median(np.diff(lats)))
    dlon = float(np.median(np.diff(lons)))
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "wind10m",
        "run_id": run_id,
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "lat0": float(lats[0]),
        "lon0": float(lons[0]),
        "dlat": dlat,
        "dlon": dlon,
        "nlat": int(lats.size),
        "nlon": int(lons.size),
        "time_axis": time_axis,
        "u_kt": _to_json_list(u_kt),
        "v_kt": _to_json_list(v_kt),
        "under_resolved_note": (
            "native IFS 0.25 deg grid; ~28 km cells under-resolve coastal "
            "acceleration zones and headland effects"
        ),
        "source": {
            "mode": "live",
            "dataset_id": meta.get("dataset_id"),
            "resolution_deg": 0.25,
            "fetched_at": meta.get("fetched_at"),
        },
    }


def _merge_latest(runs_dir: Path, run_id: str, new_artifacts: Dict[str, Any]) -> Dict[str, Any]:
    """Read-modify-write latest.json; existing keys (current_grid!) survive."""
    latest_path = runs_dir / "latest.json"
    latest: Dict[str, Any] = {}
    if latest_path.exists():
        try:
            latest = json.loads(latest_path.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("latest.json unreadable; rebuilding it")
            latest = {}
    latest["run_id"] = run_id
    artifacts = latest.get("artifacts")
    if not isinstance(artifacts, dict):
        artifacts = {}
    artifacts.update(new_artifacts)
    latest["artifacts"] = artifacts
    latest_path.write_text(json.dumps(latest, indent=2) + "\n")
    return latest


def prepare_synoptic(
    cycle: str | None = None,
    *,
    panel_steps: Sequence[int] = DEFAULT_PANEL_STEPS,
    force: bool = False,
    prefer_long: bool = False,
) -> Dict[str, Any]:
    """
    Run the full synoptic prep for one ECMWF open-data cycle and publish the
    prepared-run artifacts.

    Args:
        cycle: cycle label like '20260712T00Z'; None = latest available
        panel_steps: forecast hours to render as chart panels
        force: re-download the cycle even when cached

    Returns:
        summary dict {run_id, cycle, publication_lag_minutes, systems,
        regimes, charts, artifact paths, latest}.
    """
    ds, meta = fetch_fields(cycle, force=force, prefer_long=prefer_long)
    cycle_label = meta["cycle"]
    cycle_time = parse_cycle(cycle_label)
    run_id = f"{RUN_ID_PREFIX}-{cycle_label}"

    ds = ds.sortby("step")
    lats = np.asarray(ds["latitude"].values, dtype=float)
    lons = np.asarray(ds["longitude"].values, dtype=float)
    steps = [int(s) for s in np.asarray(ds["step"].values).reshape(-1)]

    # a) detection per step -> tracking; regimes on the analysis step.
    per_step = [
        detect_systems(_mslp_hpa(ds["msl"].sel(step=step_h).values), lats, lons)
        for step_h in steps
    ]
    systems = track_systems(per_step, steps)

    step0 = steps[0]
    regime = detect_mistral(
        _mslp_hpa(ds["msl"].sel(step=step0).values),
        np.asarray(ds["u10"].sel(step=step0).values, dtype=float),
        np.asarray(ds["v10"].sel(step=step0).values, dtype=float),
        lats,
        lons,
    )
    regimes = [regime] if regime else []

    run_dir = processed_dir("runs", run_id)
    synoptic_dir = run_dir / "synoptic"
    charts_dir = synoptic_dir / "charts"

    # c) chart panels (before features: captions land in features.json).
    panels = render_panels(ds, systems, charts_dir, steps=panel_steps)
    chart_rel: List[str] = []
    chart_captions: List[Dict[str, Any]] = []
    for panel in panels:
        rel = f"runs/{run_id}/synoptic/charts/{Path(panel['file']).name}"
        chart_rel.append(rel)
        chart_captions.append(
            {
                "step_h": panel["step_h"],
                "file": rel,
                "caption": panel["caption"],
                # chart geometry: lets the viewer overlay the per-user route
                # client-side while the PNG itself stays route-independent
                "size_px": panel["size_px"],
                "geo": panel["geo"],
                "axes_px": panel["axes_px"],
            }
        )

    # b) features.json (validated before write).
    features = _build_features(run_id, cycle_time, systems, regimes, chart_captions)
    features_rel = f"runs/{run_id}/synoptic/features.json"
    _write_json(synoptic_dir / "features.json", features, "synoptic-features.schema.json")

    # d) Channel wind grid at native resolution.
    wind_grid = _build_wind_grid(ds, run_id, meta)
    wind_rel = f"runs/{run_id}/wind_grid.json"
    _write_json(run_dir / "wind_grid.json", wind_grid, "region-grid.schema.json")

    # e) prepared-run manifest.
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "model": MODEL_NAME,
        "cycle": cycle_label,
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "steps_h": steps,
        "bounds": dict(meta.get("window") or {
            "min_lat": float(lats.min()),
            "max_lat": float(lats.max()),
            "min_lon": float(lons.min()),
            "max_lon": float(lons.max()),
        }),
        "valid_until": _iso_z(cycle_time + timedelta(hours=VALID_HOURS)),
        "artifacts": {
            "synoptic_features": features_rel,
            "synoptic_charts": chart_rel,
            "wind_grid": wind_rel,
        },
        "sources": [
            {
                "kind": "ecmwf-open-data",
                "mode": "live",
                "dataset_id": meta.get("dataset_id"),
                "fetched_at": meta["fetched_at"],
                "checksum_sha256": meta.get("checksum"),
                "licence": meta.get("licence"),
            }
        ],
    }
    manifest_rel = f"runs/{run_id}/run.json"
    _write_json(run_dir / "run.json", manifest, "prepared-run.schema.json")

    # f) latest.json merge (current_grid and anything else untouched).
    latest = _merge_latest(
        processed_dir("runs"),
        run_id,
        {
            "synoptic_features": features_rel,
            "synoptic_charts": chart_rel,
            "wind_grid": wind_rel,
            "run_manifest": manifest_rel,
        },
    )

    logger.info(
        "Published synoptic run %s: %d systems, %d regime(s), %d chart(s)",
        run_id,
        len(systems),
        len(regimes),
        len(panels),
    )
    return {
        "run_id": run_id,
        "cycle": cycle_label,
        "publication_lag_minutes": meta.get("publication_lag_minutes"),
        "systems": systems,
        "regimes": regimes,
        "charts": panels,
        "features_path": str(synoptic_dir / "features.json"),
        "wind_grid_path": str(run_dir / "wind_grid.json"),
        "manifest_path": str(run_dir / "run.json"),
        "latest": latest,
    }


__all__ = ["prepare_synoptic", "WIND_BOUNDS", "MS_TO_KNOTS", "DEFAULT_PANEL_STEPS"]
