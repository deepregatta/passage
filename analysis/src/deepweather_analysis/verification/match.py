"""Match a snapshot's findings against observations. Pure core.

Coverage classes:
- 'verified_near_observation'  — pair within 10 km / 20 min of a real record;
- 'partially_observed'         — matched, but only within 25 km / 40 min;
- 'emulated'                   — FORCED whenever observations.source.mode ==
                                 'synthetic'; fake observations can never
                                 claim real verification;
- legs with no station coverage are listed 'not_independently_observed'.

Every pair carries distance/time offsets and lead time; the calibration
accumulator never drops the sample size.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..paths import processed_dir
from ..timeutil import parse_iso_utc

SCHEMA_VERSION = 1

DEFAULT_MAX_KM = 25.0
DEFAULT_MAX_MIN = 40.0
NEAR_KM = 10.0
NEAR_MIN = 20.0

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _nearest_station(
    sample_point: Dict[str, float], stations: List[Dict[str, Any]], max_km: float
) -> Optional[tuple[Dict[str, Any], float]]:
    best: Optional[tuple[Dict[str, Any], float]] = None
    for station in stations:
        d = haversine_km(sample_point["lat"], sample_point["lon"], station["lat"], station["lon"])
        if d <= max_km and (best is None or d < best[1]):
            best = (station, d)
    return best


def _nearest_record(
    station: Dict[str, Any], valid_time: datetime, max_min: float
) -> Optional[tuple[Dict[str, Any], float]]:
    """Nearest-in-time record with wind data within max_min minutes."""
    best: Optional[tuple[Dict[str, Any], float]] = None
    for record in station.get("records", []):
        if record.get("wind_kt") is None:
            continue
        offset_min = abs((parse_iso_utc(record["time"]) - valid_time).total_seconds()) / 60.0
        if offset_min <= max_min and (best is None or offset_min < best[1]):
            best = (record, offset_min)
    return best


def match_snapshot(
    findings: Dict[str, Any],
    observations: Dict[str, Any],
    max_km: float = DEFAULT_MAX_KM,
    max_min: float = DEFAULT_MAX_MIN,
) -> Dict[str, Any]:
    """
    Match forecast leg-hours against observation records.

    For each leg-hour with wind data: nearest station within max_km of the
    leg's sample_point, then the nearest record within max_min of the hour's
    valid_time -> one wind_kt pair with error and lead time.

    Args:
        findings: findings.json document (contracts/findings.schema.json)
        observations: observations document (contracts/observations.schema.json)

    Returns:
        {snapshot_id, generated_at, source_mode, pairs, coverage_summary,
        not_independently_observed, params}
    """
    stations = list(observations.get("stations", []))
    synthetic = (observations.get("source") or {}).get("mode") == "synthetic"
    generated_at_raw = findings.get("generated_at") or findings.get("departure_utc")
    generated_at = parse_iso_utc(generated_at_raw) if generated_at_raw else None

    pairs: List[Dict[str, Any]] = []
    uncovered: List[str] = []

    for leg in findings.get("legs", []):
        leg_id = leg.get("leg_id", "?")
        sample_point = leg.get("sample_point")
        if not sample_point:
            uncovered.append(leg_id)
            continue
        near = _nearest_station(sample_point, stations, max_km)
        if near is None:
            uncovered.append(leg_id)
            continue
        station, distance_km = near

        leg_pairs = 0
        for hour in leg.get("hours", []):
            forecast = hour.get("wind_kt")
            if forecast is None or not hour.get("valid_time"):
                continue
            valid_time = parse_iso_utc(hour["valid_time"])
            matched = _nearest_record(station, valid_time, max_min)
            if matched is None:
                continue
            record, offset_min = matched
            observed = float(record["wind_kt"])

            if synthetic:
                # Synthetic observations can never claim real verification.
                coverage_class = "emulated"
            elif distance_km <= NEAR_KM and offset_min <= NEAR_MIN:
                coverage_class = "verified_near_observation"
            else:
                coverage_class = "partially_observed"

            lead_h = (
                round((valid_time - generated_at).total_seconds() / 3600.0, 2)
                if generated_at
                else None
            )
            pairs.append(
                {
                    "leg_id": leg_id,
                    "station_id": station["station_id"],
                    "valid_time": _iso_z(valid_time),
                    "variable": "wind_kt",
                    "forecast": round(float(forecast), 2),
                    "observed": round(observed, 2),
                    "error": round(float(forecast) - observed, 2),
                    "distance_km": round(distance_km, 2),
                    "time_offset_min": round(offset_min, 1),
                    "lead_h": lead_h,
                    "coverage_class": coverage_class,
                }
            )
            leg_pairs += 1
        if leg_pairs == 0:
            uncovered.append(leg_id)

    coverage_summary: Dict[str, int] = {}
    for pair in pairs:
        coverage_summary[pair["coverage_class"]] = (
            coverage_summary.get(pair["coverage_class"], 0) + 1
        )
    if uncovered:
        coverage_summary["not_independently_observed"] = len(uncovered)

    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_id": findings.get("snapshot_id"),
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "forecast_generated_at": generated_at_raw,
        "source_mode": (observations.get("source") or {}).get("mode"),
        "pairs": pairs,
        "coverage_summary": coverage_summary,
        "not_independently_observed": uncovered,
        "params": {"max_km": max_km, "max_min": max_min, "near_km": NEAR_KM, "near_min": NEAR_MIN},
    }


def write_verification(doc: Dict[str, Any]) -> Path:
    """Write to data/processed/verification/cases/<snapshot_id>.json."""
    snapshot_id = doc.get("snapshot_id") or "unknown-snapshot"
    out_dir = processed_dir("verification", "cases")
    path = out_dir / f"{snapshot_id}.json"
    path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    return path


__all__ = [
    "DEFAULT_MAX_KM",
    "DEFAULT_MAX_MIN",
    "NEAR_KM",
    "NEAR_MIN",
    "haversine_km",
    "match_snapshot",
    "write_verification",
]
