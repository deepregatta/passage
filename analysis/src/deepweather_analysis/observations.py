"""Synthetic buoy/station observations for the verification layer (brief §9).

SYNTHETIC provider (config/providers.json: observations.mode == 'synthetic').
Every document carries source.mode == 'synthetic'; the matcher (§9 honesty
rule) forces the coverage class of anything matched against these to
'emulated' — fake observations can never claim real verification. The first
easy live swap is EMODnet ERDDAP.

Fully deterministic: 'noise' is sin-based (no RNG), phases/biases derive from
a stable per-station hash, so the same window always yields the same document.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .paths import contracts_dir, processed_dir

SCHEMA_VERSION = 1
SOURCE_NAME = "synthetic-channel-stations"
RECORD_STEP_MIN = 10

# Fixed synthetic station set (Channel verification geometry).
STATIONS: tuple[Dict[str, Any], ...] = (
    {"station_id": "casquets-buoy", "name": "Casquets Buoy (synthetic)", "lat": 49.72, "lon": -2.34},
    {"station_id": "mid-channel", "name": "Mid-Channel Buoy (synthetic)", "lat": 49.95, "lon": -3.0},
    {"station_id": "plymouth-approach", "name": "Plymouth Approach (synthetic)", "lat": 50.25, "lon": -4.1},
)

# Fields a base_series may carry (per-station hourly truth-ish arrays).
VARIABLES = ("wind_kt", "gust_kt", "wind_dir_deg", "pressure_hpa", "hs_m")


def _station_hash(station_id: str) -> int:
    """Stable tiny hash (no PYTHONHASHSEED dependence)."""
    h = 0
    for ch in station_id:
        h = (h * 31 + ord(ch)) % 100003
    return h


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _interp_hourly(series: Sequence[float], hours: float) -> float:
    """Linear interpolation into an hourly array, clamped at the ends."""
    if not series:
        raise ValueError("empty base series")
    if hours <= 0:
        return float(series[0])
    idx = int(hours)
    if idx >= len(series) - 1:
        return float(series[-1])
    frac = hours - idx
    return float(series[idx]) * (1.0 - frac) + float(series[idx + 1]) * frac


def _default_truth(station: Dict[str, Any], hours: float) -> Dict[str, float]:
    """Plausible Channel ambient conditions (deterministic, per-station)."""
    h = _station_hash(station["station_id"])
    phase = (h % 360) * math.pi / 180.0
    wind = 12.0 + 4.0 * math.sin(2.0 * math.pi * hours / 12.0 + phase)
    return {
        "wind_kt": wind,
        "gust_kt": wind * 1.35,
        "wind_dir_deg": (240.0 + 25.0 * math.sin(2.0 * math.pi * hours / 24.0 + phase)) % 360.0,
        "pressure_hpa": 1014.0 - 3.0 * math.sin(2.0 * math.pi * hours / 18.0 + phase),
        "hs_m": 1.1 + 0.4 * math.sin(2.0 * math.pi * hours / 12.0 + phase * 0.5),
    }


def _noise_and_bias(station_id: str, variable: str, minutes: float) -> float:
    """Deterministic sin 'noise' + a small fixed per-station bias (no RNG)."""
    h = _station_hash(station_id + ":" + variable)
    phase = (h % 628) / 100.0
    amplitude = {
        "wind_kt": 0.9,
        "gust_kt": 1.4,
        "wind_dir_deg": 6.0,
        "pressure_hpa": 0.4,
        "hs_m": 0.08,
    }[variable]
    bias = ((h % 11) - 5) * amplitude / 10.0  # small, in [-0.5, +0.5] * amplitude
    return amplitude * math.sin(minutes / 7.3 + phase) + bias


def window_label(start_iso: str, end_iso: str) -> str:
    start = _parse_iso(start_iso)
    end = _parse_iso(end_iso)
    return f"{start:%Y%m%dT%H%M}Z-{end:%Y%m%dT%H%M}Z"


def generate_observations(
    start_iso: str,
    end_iso: str,
    base_series: Optional[Dict[str, Dict[str, Sequence[float]]]] = None,
    *,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Generate a synthetic observations document per contracts/observations.schema.json.

    Args:
        start_iso, end_iso: window (UTC ISO); records every 10 minutes,
            inclusive of both ends.
        base_series: optional per-station hourly truth-ish arrays,
            {station_id: {variable: [hourly values from start]}}. When given,
            values are interpolated to 10-min cadence and perturbed with
            deterministic sin 'noise' plus a small fixed bias; stations or
            variables absent from base_series fall back to the default model.
        generated_at: override the stamped generation time (determinism aids).

    Returns:
        schema-valid observations dict, source.mode == 'synthetic'.
    """
    start = _parse_iso(start_iso)
    end = _parse_iso(end_iso)
    if end < start:
        raise ValueError(f"end {end_iso} before start {start_iso}")
    base_series = base_series or {}

    stations_out: List[Dict[str, Any]] = []
    for station in STATIONS:
        sid = station["station_id"]
        per_station = base_series.get(sid) or {}
        records: List[Dict[str, Any]] = []
        t = start
        while t <= end:
            minutes = (t - start).total_seconds() / 60.0
            hours = minutes / 60.0
            truth = _default_truth(station, hours)
            record: Dict[str, Any] = {"time": _iso_z(t)}
            for variable in VARIABLES:
                series = per_station.get(variable)
                base = _interp_hourly(series, hours) if series else truth[variable]
                value = base + _noise_and_bias(sid, variable, minutes)
                if variable == "wind_dir_deg":
                    value = value % 360.0
                    record[variable] = round(value, 0)
                elif variable in ("wind_kt", "gust_kt"):
                    record[variable] = round(max(0.0, value), 1)
                elif variable == "pressure_hpa":
                    record[variable] = round(value, 1)
                else:  # hs_m
                    record[variable] = round(max(0.0, value), 2)
            records.append(record)
            t += timedelta(minutes=RECORD_STEP_MIN)
        stations_out.append(
            {
                "station_id": sid,
                "name": station["name"],
                "lat": station["lat"],
                "lon": station["lon"],
                "quality_flags": ["synthetic"],
                "records": records,
            }
        )

    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or _iso_z(datetime.now(timezone.utc)),
        "source": {"mode": "synthetic", "name": SOURCE_NAME},
        "stations": stations_out,
    }
    validate_observations(doc)
    return doc


def validate_observations(doc: Dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads((contracts_dir() / "observations.schema.json").read_text())
    jsonschema.validate(instance=doc, schema=schema)


def write_observations(doc: Dict[str, Any], start_iso: str, end_iso: str) -> Path:
    """Validate and write to data/processed/verification/observations/<window>.json."""
    validate_observations(doc)
    out_dir = processed_dir("verification", "observations")
    path = out_dir / f"{window_label(start_iso, end_iso)}.json"
    path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    return path


__all__ = [
    "STATIONS",
    "VARIABLES",
    "generate_observations",
    "validate_observations",
    "window_label",
    "write_observations",
]
