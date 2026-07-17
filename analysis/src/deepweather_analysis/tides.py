"""Tidal predictions at reference ports — HW/LW series (M10).

Modes (config/providers.json "tides"):

live — CMEMS IBI 15-minute sea-surface height (dataset
  cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i, variable zos). The IBI model
  carries explicit tidal forcing, so its SSH series contains the real tide;
  HW/LW are extracted at the nearest wet grid cell to each reference port.
  Heights are model SSH (≈ above mean sea level) shifted by the port's Z0
  (mean level above chart datum) as an approximate datum transfer — good for
  gate *timing*, indicative only for heights. Any fetch failure degrades to
  the synthetic path below so the artifact stays honestly badged.

synthetic — harmonic synthesis with plausible-but-NOT-surveyed constituents:
  h(t) = Z0 + Σ A_i · cos(ω_i·t − φ_i) over M2/S2/N2/K1/O1; downstream
  evidence is badged "emulated" and the briefing carries a disclosure section.

Both paths find HW/LW as sign changes of dh/dt on a regular grid, refined by
a local quadratic fit.
"""

from __future__ import annotations

import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .paths import contracts_dir, data_root, processed_dir
from .providers import Mode, provider_mode

logger = logging.getLogger(__name__)

CMEMS_SSH_DATASET = os.environ.get(
    "DEEPWEATHER_CMEMS_TIDES_DATASET", "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i"
)
# half-width of the per-port subset box, degrees (~8 nm) — enough to find a wet cell
PORT_BOX_HALF_DEG = 0.14

# angular speeds, degrees per hour (standard values)
OMEGA = {"M2": 28.9841042, "S2": 30.0, "N2": 28.4397295, "K1": 15.0410686, "O1": 13.9430356}

# SYNTHETIC constituents: amplitudes (m) and phases (deg) are plausible for the
# region's character (large semidiurnal, marked spring/neap) but are NOT surveyed
# values. Z0 = mean level above chart datum.
PORTS: dict[str, dict] = {
    "cherbourg": {
        "name": "Cherbourg",
        "lat": 49.65,
        "lon": -1.63,
        "z0": 3.8,
        "constituents": {
            "M2": (1.9, 220),
            "S2": (0.7, 260),
            "N2": (0.4, 200),
            "K1": (0.1, 75),
            "O1": (0.08, 330),
        },
    },
    "st-helier": {
        "name": "St Helier",
        "lat": 49.18,
        "lon": -2.12,
        "z0": 6.1,
        "constituents": {
            "M2": (3.5, 190),
            "S2": (1.3, 235),
            "N2": (0.7, 170),
            "K1": (0.08, 90),
            "O1": (0.07, 340),
        },
    },
    "brest": {
        "name": "Brest",
        "lat": 48.38,
        "lon": -4.5,
        "z0": 4.0,
        "constituents": {
            "M2": (2.0, 140),
            "S2": (0.75, 180),
            "N2": (0.42, 120),
            "K1": (0.07, 70),
            "O1": (0.07, 325),
        },
    },
    "plymouth": {
        "name": "Plymouth (Devonport)",
        "lat": 50.37,
        "lon": -4.19,
        "z0": 3.2,
        "constituents": {
            "M2": (1.7, 135),
            "S2": (0.6, 180),
            "N2": (0.35, 115),
            "K1": (0.06, 65),
            "O1": (0.06, 320),
        },
    },
}

EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def height_m(port_id: str, when: datetime) -> float:
    port = PORTS[port_id]
    hours = (when - EPOCH).total_seconds() / 3600.0
    h = port["z0"]
    for name, (amp, phase) in port["constituents"].items():
        h += amp * math.cos(math.radians(OMEGA[name] * hours - phase))
    return h


def hw_lw_events(port_id: str, start: datetime, end: datetime) -> list[dict]:
    """HW/LW via derivative sign change on a 6-min grid + quadratic refinement."""
    events = []
    step = timedelta(minutes=6)
    t = start
    prev_h = height_m(port_id, t - step)
    cur_h = height_m(port_id, t)
    while t <= end:
        next_h = height_m(port_id, t + step)
        rising_before = cur_h > prev_h
        rising_after = next_h > cur_h
        if rising_before != rising_after:
            # quadratic vertex through the three samples for sub-step timing
            denom = prev_h - 2 * cur_h + next_h
            offset_frac = 0.5 * (prev_h - next_h) / denom if abs(denom) > 1e-9 else 0.0
            t_ext = t + step * max(-1.0, min(1.0, offset_frac))
            events.append(
                {
                    "kind": "HW" if rising_before else "LW",
                    "time": t_ext.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "height_m": round(height_m(port_id, t_ext), 2),
                }
            )
        prev_h, cur_h = cur_h, next_h
        t += step
    return events


def _events_from_samples(times_ms: list[float], heights: list[float]) -> list[dict]:
    """HW/LW from a regularly sampled series: slope sign change + quadratic vertex."""
    events = []
    for i in range(1, len(heights) - 1):
        prev_h, cur_h, next_h = heights[i - 1], heights[i], heights[i + 1]
        rising_before = cur_h > prev_h
        rising_after = next_h > cur_h
        if rising_before == rising_after:
            continue
        step_ms = (times_ms[i + 1] - times_ms[i - 1]) / 2.0
        denom = prev_h - 2 * cur_h + next_h
        offset_frac = 0.5 * (prev_h - next_h) / denom if abs(denom) > 1e-9 else 0.0
        offset_frac = max(-1.0, min(1.0, offset_frac))
        t_ext = times_ms[i] + step_ms * offset_frac
        # height at the quadratic vertex
        h_ext = cur_h - 0.25 * (prev_h - next_h) * offset_frac
        events.append(
            {
                "kind": "HW" if rising_before else "LW",
                "time": datetime.fromtimestamp(t_ext / 1000.0, tz=timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "height_m": round(h_ext, 2),
            }
        )
    return events


def _fetch_port_ssh_events(port_id: str, start: datetime, end: datetime) -> list[dict]:
    """Live path: subset CMEMS SSH around one port, extract HW/LW at nearest wet cell."""
    import copernicusmarine
    import numpy as np
    import xarray as xr

    port = PORTS[port_id]
    cache_dir = data_root() / "cache" / "tides"
    cache_dir.mkdir(parents=True, exist_ok=True)
    nc_path = cache_dir / f"{port_id}.nc"
    copernicusmarine.subset(
        dataset_id=CMEMS_SSH_DATASET,
        variables=["zos"],
        minimum_longitude=port["lon"] - PORT_BOX_HALF_DEG,
        maximum_longitude=port["lon"] + PORT_BOX_HALF_DEG,
        minimum_latitude=port["lat"] - PORT_BOX_HALF_DEG,
        maximum_latitude=port["lat"] + PORT_BOX_HALF_DEG,
        start_datetime=start.strftime("%Y-%m-%dT%H:%M:%S"),
        end_datetime=end.strftime("%Y-%m-%dT%H:%M:%S"),
        output_directory=str(cache_dir),
        output_filename=nc_path.name,
        overwrite=True,
    )
    with xr.open_dataset(nc_path) as ds:
        zos = ds["zos"]
        wet = ~np.isnan(zos.isel(time=0).values)
        if not wet.any():
            raise RuntimeError(f"no wet cells within {PORT_BOX_HALF_DEG}° of {port_id}")
        lats = ds["latitude"].values
        lons = ds["longitude"].values
        cos_lat = math.cos(math.radians(port["lat"]))
        lat_grid, lon_grid = np.meshgrid(lats, lons, indexing="ij")
        dist2 = (lat_grid - port["lat"]) ** 2 + ((lon_grid - port["lon"]) * cos_lat) ** 2
        dist2[~wet] = np.inf
        i, j = np.unravel_index(int(np.argmin(dist2)), dist2.shape)
        series = zos.values[:, i, j].astype(float)
        times_ms = ds["time"].values.astype("datetime64[ms]").astype(float).tolist()
    if np.isnan(series).any():
        raise RuntimeError(f"NaN in SSH series at {port_id}")
    # approximate chart-datum transfer: model SSH (~MSL) + port mean level above CD
    heights = [h + port["z0"] for h in series.tolist()]
    return _events_from_samples(times_ms, heights)


def _live_doc(start: datetime, end: datetime) -> dict:
    ports = []
    for port_id, port in PORTS.items():
        ports.append(
            {
                "port_id": port_id,
                "name": port["name"],
                "lat": port["lat"],
                "lon": port["lon"],
                "events": _fetch_port_ssh_events(port_id, start, end),
            }
        )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "mode": "live",
            "note": (
                f"HW/LW extracted from CMEMS IBI 15-min sea-surface height "
                f"({CMEMS_SSH_DATASET}) at the nearest wet cell to each reference "
                "port. Heights = model SSH + port mean level above chart datum "
                "(approximate datum transfer); use for gate timing, not clearances."
            ),
        },
        "ports": ports,
    }


def _synthetic_doc(start: datetime, end: datetime, degraded_reason: str | None = None) -> dict:
    note = (
        "SYNTHETIC harmonic constituents — plausible regional character, not "
        "surveyed values. Never use for a real passage. Real source "
        "(SHOM/UKHO/FES) is a data swap behind the same contract."
    )
    if degraded_reason:
        note = f"live CMEMS fetch failed ({degraded_reason}); degraded to synthetic. " + note
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "mode": "synthetic",
            "constituents": list(OMEGA.keys()),
            "note": note,
        },
        "ports": [
            {
                "port_id": port_id,
                "name": port["name"],
                "lat": port["lat"],
                "lon": port["lon"],
                "events": hw_lw_events(port_id, start, end),
            }
            for port_id, port in PORTS.items()
        ],
    }


def prepare_tides(start_iso: str | None = None, hours: int = 96) -> Path:
    from jsonschema import Draft202012Validator

    start = (
        datetime.fromisoformat(start_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
        if start_iso
        else datetime.now(timezone.utc)
    )
    end = start + timedelta(hours=hours)

    if provider_mode("tides") is Mode.LIVE:
        try:
            doc = _live_doc(start, end)
        except Exception as error:  # noqa: BLE001 — feed failure must degrade, not crash
            logger.warning("live tides fetch failed, degrading to synthetic: %s", error)
            doc = _synthetic_doc(start, end, degraded_reason=str(error))
    else:
        doc = _synthetic_doc(start, end)

    schema = json.loads((contracts_dir() / "tides.schema.json").read_text())
    Draft202012Validator(schema).validate(doc)

    out = processed_dir("tides") / "channel.json"
    out.write_text(json.dumps(doc, indent=1))
    return out
