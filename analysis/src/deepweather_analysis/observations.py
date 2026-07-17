"""Buoy/station observations for the verification layer (brief §9).

LIVE (config/providers.json: observations.mode == 'live'): real Channel buoys
via NDBC's realtime2 mirror of the GTS marine network — Channel Lightship
(62103, mid-Channel) and E1 (62050, Plymouth approach), both UK Met Office
moorings reporting hourly wind/direction/pressure. No account or token needed.
Records only exist for the past (~45-day rolling window at hourly cadence);
a future passage window honestly yields empty station records, which the
matcher reports as 'not_independently_observed'.

SYNTHETIC fallback: kept for fixture mode and for graceful degradation when
the live fetch fails. Every synthetic document carries source.mode ==
'synthetic'; the matcher (§9 honesty rule) forces the coverage class of
anything matched against these to 'emulated' — fake observations can never
claim real verification.

The synthetic generator is fully deterministic: 'noise' is sin-based (no RNG),
phases/biases derive from a stable per-station hash, so the same window always
yields the same document.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .paths import contracts_dir, processed_dir
from .providers import Mode, provider_mode
from .route_sources import (
    live_observations_source_name,
    live_stations,
    synthetic_observations_source_name,
    synthetic_stations,
)

SCHEMA_VERSION = 1
SOURCE_NAME = synthetic_observations_source_name()
RECORD_STEP_MIN = 10

# --- live source: NDBC realtime2 mirror of Met Office GTS buoys -------------

NDBC_URL_TEMPLATE = os.environ.get(
    "DEEPWEATHER_NDBC_URL_TEMPLATE",
    "https://www.ndbc.noaa.gov/data/realtime2/{station_id}.txt",
)
# Default route's source label; per-route lookups go through the registry.
LIVE_SOURCE_NAME = live_observations_source_name()
KT_PER_MS = 1.9438445

# Real moorings on the route track, from config/route-sources.json (default
# route). Legs beyond ~25 km of these stay 'not_independently_observed'.
LIVE_STATIONS: tuple[Dict[str, Any], ...] = live_stations()

# Keep records this far outside the requested window so the matcher's
# nearest-in-time search (max 40 min) never starves at the edges.
WINDOW_SLACK_MIN = 40

# Fixed synthetic station set (default route's verification geometry).
STATIONS: tuple[Dict[str, Any], ...] = synthetic_stations()

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
    route_id: Optional[str] = None,
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
        route_id: route-sources registry key (default route when omitted).

    Returns:
        schema-valid observations dict, source.mode == 'synthetic'.
    """
    start = _parse_iso(start_iso)
    end = _parse_iso(end_iso)
    if end < start:
        raise ValueError(f"end {end_iso} before start {start_iso}")
    base_series = base_series or {}

    stations_out: List[Dict[str, Any]] = []
    for station in synthetic_stations(route_id):
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
        "source": {"mode": "synthetic", "name": synthetic_observations_source_name(route_id)},
        "stations": stations_out,
    }
    validate_observations(doc)
    return doc


def parse_realtime2(raw_text: str) -> List[Dict[str, Any]]:
    """
    Parse an NDBC realtime2 station file into schema records.

    Columns (fixed order): YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES
    ... — 'MM' means missing. Wind speeds arrive in m/s and convert to knots.
    Input rows are newest-first; the result is chronological.
    """
    records: List[Dict[str, Any]] = []
    for line in raw_text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 13:
            continue

        def _num(token: str) -> Optional[float]:
            return None if token == "MM" else float(token)

        try:
            t = datetime(
                int(parts[0]), int(parts[1]), int(parts[2]),
                int(parts[3]), int(parts[4]), tzinfo=timezone.utc,
            )
        except ValueError:
            continue
        wdir, wspd, gust, wvht = (_num(parts[i]) for i in (5, 6, 7, 8))
        pres = _num(parts[12])
        records.append(
            {
                "time": _iso_z(t),
                "wind_kt": round(wspd * KT_PER_MS, 1) if wspd is not None else None,
                "gust_kt": round(gust * KT_PER_MS, 1) if gust is not None else None,
                "wind_dir_deg": round(wdir, 0) if wdir is not None else None,
                "pressure_hpa": round(pres, 1) if pres is not None else None,
                "hs_m": round(wvht, 2) if wvht is not None else None,
            }
        )
    records.reverse()
    return records


def fetch_live(
    start_iso: str,
    end_iso: str,
    *,
    generated_at: Optional[str] = None,
    route_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Fetch real observations from NDBC realtime2 for the window.

    Stations whose fetch fails are skipped; if every station fails, raises so
    the dispatcher can degrade to synthetic (badged). Stations that respond
    but have no records inside the window (e.g. a future passage) are kept
    with empty records — the matcher then reports those legs as
    'not_independently_observed', which is the honest answer.
    """
    import requests

    start = _parse_iso(start_iso) - timedelta(minutes=WINDOW_SLACK_MIN)
    end = _parse_iso(end_iso) + timedelta(minutes=WINDOW_SLACK_MIN)

    stations_out: List[Dict[str, Any]] = []
    failures: List[str] = []
    for station in live_stations(route_id):
        url = NDBC_URL_TEMPLATE.format(station_id=station["station_id"])
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as exc:
            failures.append(f"{station['station_id']}: {exc}")
            continue
        records = [
            r for r in parse_realtime2(resp.text) if start <= _parse_iso(r["time"]) <= end
        ]
        stations_out.append(
            {
                "station_id": station["station_id"],
                "name": station["name"],
                "lat": station["lat"],
                "lon": station["lon"],
                "quality_flags": ["gts-hourly"],
                "records": records,
            }
        )
    if not stations_out:
        raise RuntimeError(f"all NDBC station fetches failed: {'; '.join(failures)}")

    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or _iso_z(datetime.now(timezone.utc)),
        "source": {"mode": "live", "name": live_observations_source_name(route_id)},
        "stations": stations_out,
    }
    validate_observations(doc)
    return doc


def fetch_observations(
    start_iso: str, end_iso: str, *, route_id: Optional[str] = None
) -> Dict[str, Any]:
    """Provider-mode dispatch: live NDBC buoys, degrading visibly to synthetic."""
    if provider_mode("observations") is Mode.LIVE:
        try:
            return fetch_live(start_iso, end_iso, route_id=route_id)
        except Exception as exc:  # degrade, but never silently
            doc = generate_observations(start_iso, end_iso, route_id=route_id)
            source_name = synthetic_observations_source_name(route_id)
            doc["source"]["name"] = f"{source_name} (live fetch failed: {exc})"
            return doc
    return generate_observations(start_iso, end_iso, route_id=route_id)


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
    "LIVE_STATIONS",
    "STATIONS",
    "VARIABLES",
    "fetch_live",
    "fetch_observations",
    "generate_observations",
    "parse_realtime2",
    "validate_observations",
    "window_label",
    "write_observations",
]
