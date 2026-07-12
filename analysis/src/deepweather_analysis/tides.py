"""Tidal predictions at reference ports — SYNTHETIC harmonic synthesis (M10).

Real constituent sets are licence/account-gated (FES registration, SHOM/UKHO),
so this module ships plausible-but-synthetic constituents for the Channel
reference ports. Every artifact carries source.mode="synthetic"; downstream
evidence is badged "emulated" and the briefing carries a disclosure section.
Swapping in real constituents later is a data change, not a code change.

Method: h(t) = Z0 + Σ A_i · cos(ω_i·t − φ_i) over M2/S2/N2/K1/O1;
HW/LW = sign changes of dh/dt on a 6-minute grid, refined by local quadratic fit.
Spring/neap emerges naturally from the M2/S2 beat.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .paths import contracts_dir, processed_dir

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


def prepare_tides(start_iso: str | None = None, hours: int = 96) -> Path:
    from jsonschema import Draft202012Validator

    start = (
        datetime.fromisoformat(start_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
        if start_iso
        else datetime.now(timezone.utc)
    )
    end = start + timedelta(hours=hours)

    doc = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "mode": "synthetic",
            "constituents": list(OMEGA.keys()),
            "note": (
                "SYNTHETIC harmonic constituents — plausible regional character, not "
                "surveyed values. Never use for a real passage. Real source "
                "(SHOM/UKHO/FES) is a data swap behind the same contract."
            ),
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

    schema = json.loads((contracts_dir() / "tides.schema.json").read_text())
    Draft202012Validator(schema).validate(doc)

    out = processed_dir("tides") / "channel.json"
    out.write_text(json.dumps(doc, indent=1))
    return out
