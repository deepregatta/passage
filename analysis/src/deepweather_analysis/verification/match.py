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
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..geo import EARTH_RADIUS_KM as EARTH_RADIUS_KM
from ..geo import haversine_km
from ..paths import contracts_dir, processed_dir
from .persistence import atomic_write_json
from ..timeutil import iso_z as _iso_z
from ..timeutil import parse_iso_utc

SCHEMA_VERSION = 2


def canonical_case(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Semantic case content; retry clocks and pair ordering are not revisions."""
    content = {k: v for k, v in doc.items() if k not in {"generated_at", "case_revision"}}
    content["pairs"] = sorted(content["pairs"], key=lambda p: json.dumps(p, sort_keys=True))
    content["not_independently_observed"] = sorted(content["not_independently_observed"])
    return content


def case_revision(doc: Dict[str, Any]) -> str:
    content = json.dumps(
        canonical_case(doc), sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(content.encode()).hexdigest()


def validate_case(doc: Dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads((contracts_dir() / "verification-case.schema.json").read_text())
    jsonschema.validate(doc, schema, format_checker=jsonschema.FormatChecker())
    if doc.get("observation_provenance", {}).get("mode") == "synthetic" and (
        doc.get("observation_source") != "emulated"
        or any(p["coverage_class"] != "emulated" for p in doc["pairs"])
    ):
        raise ValueError("synthetic observations must remain emulated")
    if doc["schema_version"] == 2 and doc["case_revision"] != case_revision(doc):
        raise ValueError("verification case revision does not match its content")


def _wind_cycle(findings: Dict[str, Any]) -> Optional[str]:
    # Only an unambiguous frozen primary wind cycle can describe these pairs.
    # Multimodel comparisons, tides, and prepared publication clocks are not it.
    primary = [
        m
        for m in findings.get("inputs", {}).get("forecast_tiles", [])
        if m.get("layer") == "weather"
    ]
    cycles = {m.get("cycle") for m in primary}
    if len(cycles) != 1:
        return None
    cycle = next(iter(cycles))
    try:
        return _iso_z(parse_iso_utc(cycle)) if cycle else None
    except (TypeError, ValueError):
        return None


DEFAULT_MAX_KM = 25.0
DEFAULT_MAX_MIN = 40.0
NEAR_KM = 10.0
NEAR_MIN = 20.0


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
        A schema-version-2 verification case with observation provenance and
        separate check/model lead times. Calibration retains check-lead bands.
    """
    stations = list(observations.get("stations", []))
    synthetic = (observations.get("source") or {}).get("mode") == "synthetic"
    # A departure time is not evidence of when a sailor made the check.
    generated_at_raw = findings.get("generated_at")
    generated_at = parse_iso_utc(generated_at_raw) if generated_at_raw else None
    model_cycle = _wind_cycle(findings)

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
                    "check_lead_h": lead_h,
                    "model_cycle": model_cycle,
                    "model_lead_h": round(
                        (valid_time - parse_iso_utc(model_cycle)).total_seconds() / 3600, 2
                    )
                    if model_cycle
                    else None,
                    "coverage_class": coverage_class,
                    **({"source_kind": "emulated"} if synthetic else {}),
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

    provenance = observations.get("source") or {}
    doc = {
        "schema_version": SCHEMA_VERSION,
        "snapshot_id": findings.get("snapshot_id"),
        "generated_at": _iso_z(datetime.now(timezone.utc)),
        "check_generated_at": generated_at_raw,
        "source_mode": (observations.get("source") or {}).get("mode"),
        "observation_source": "emulated" if synthetic else provenance.get("name") or "unknown",
        **({"source_kind": "emulated"} if synthetic else {}),
        "observation_provenance": provenance,
        "lead_basis": "time_since_check",
        "pairs": pairs,
        "coverage_summary": coverage_summary,
        "not_independently_observed": uncovered,
        "params": {"max_km": max_km, "max_min": max_min, "near_km": NEAR_KM, "near_min": NEAR_MIN},
    }
    doc["case_revision"] = case_revision(doc)
    validate_case(doc)
    return doc


def write_verification(doc: Dict[str, Any]) -> Path:
    """Write to data/processed/verification/cases/<snapshot_id>.json."""
    validate_case(doc)
    snapshot_id = doc["snapshot_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", snapshot_id):
        raise ValueError("invalid verification snapshot identifier")
    out_dir = processed_dir("verification", "cases")
    path = out_dir / f"{snapshot_id}.json"
    # Keep the original verification clock on an exact semantic retry.
    if path.exists():
        existing = json.loads(path.read_text())
        validate_case(existing)
        if existing.get("case_revision") != doc.get("case_revision"):
            atomic_write_json(path, doc)
    else:
        atomic_write_json(path, doc)
    index_path = out_dir / "index.json"
    entries = []
    for case_path in sorted(out_dir.glob("*.json")):
        if case_path == index_path:
            continue
        case = json.loads(case_path.read_text())
        validate_case(case)
        entries.append(
            {
                "snapshot_id": case["snapshot_id"],
                "observation_source": case.get("observation_source", "unknown"),
            }
        )
    atomic_write_json(index_path, {"cases": entries})
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
