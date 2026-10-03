"""Replaceable case contributions; evidence only, never model weighting.

Rebuild in canonical order instead of merging rounded aggregates. One current
revision per snapshot is persisted in the aggregate itself. Legacy totals are
preserved separately because their unknown retry history cannot be recovered.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from ..paths import contracts_dir, processed_dir
from .match import canonical_case, validate_case
from .persistence import atomic_write_json

SCHEMA_VERSION = 2
DEFAULT_AREA = "channel"
# Preserve the original meaning: valid time minus check creation, not model cycle.
LEAD_BANDS: Tuple[Tuple[int, int], ...] = ((0, 12), (12, 24), (24, 48))


def _band_for(lead_h: float) -> Optional[Tuple[int, int]]:
    return next((band for band in LEAD_BANDS if band[0] <= lead_h < band[1]), None)


def default_calibration_path() -> Path:
    return processed_dir("verification") / "calibration.json"


def _validate(doc: Dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads((contracts_dir() / "calibration.schema.json").read_text())
    jsonschema.validate(doc, schema, format_checker=jsonschema.FormatChecker())


def accumulate_calibration(
    verification_docs: Iterable[Dict[str, Any]],
    *,
    area: str = DEFAULT_AREA,
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Upsert a current versioned case per snapshot, then rebuild all statistics.

    A later call replaces earlier observations for the same snapshot. Conflicting
    revisions of one snapshot in one batch are ambiguous and rejected. Retrying
    identical content does not write or change clocks. Unsupported/corrupt saved
    documents fail closed; nothing is silently discarded. Single local writer.
    """
    target = path or default_calibration_path()
    existing = json.loads(target.read_text()) if target.exists() else None
    contributions = {}
    legacy = None
    if existing is not None:
        _validate(existing)
        if existing["schema_version"] == 1:
            legacy = existing
        else:
            legacy = existing.get("legacy_evidence")
            for contribution in existing["contributions"]:
                case = contribution["case"]
                validate_case(case)
                if case["snapshot_id"] in contributions:
                    raise ValueError("duplicate persisted verification contributions")
                contributions[case["snapshot_id"]] = contribution

    updates = {}
    for case in verification_docs:
        validate_case(case)
        if case["schema_version"] != 2:
            raise ValueError("legacy cases require explicit re-verification before aggregation")
        contribution = {
            "area": area,
            "case": {
                **canonical_case(case),
                "case_revision": case["case_revision"],
                "generated_at": case["generated_at"],
            },
        }
        key = case["snapshot_id"]
        if key in updates and updates[key]["case"]["case_revision"] != case["case_revision"]:
            raise ValueError(f"conflicting verification revisions for {key}")
        previous = contributions.get(key) or updates.get(key)
        if (
            previous
            and previous["area"] == area
            and previous["case"]["case_revision"] == case["case_revision"]
        ):
            contribution = previous
        updates[key] = contribution
    contributions.update(updates)
    ordered = [contributions[key] for key in sorted(contributions)]

    groups = {}
    skipped = 0
    for contribution in ordered:
        case = contribution["case"]
        emulated = case["observation_source"] == "emulated"
        for pair in case["pairs"]:
            lead, error = pair["check_lead_h"], pair["error"]
            band = _band_for(lead) if lead is not None else None
            if emulated or pair["coverage_class"] == "emulated" or band is None or error is None:
                skipped += 1
                continue
            key = (pair["variable"], band, contribution["area"])
            groups.setdefault(key, []).append((error, pair["coverage_class"]))

    records = []
    for (variable, band, rec_area), samples in sorted(groups.items()):
        values = sorted(value for value, _ in samples)
        mean = math.fsum(values) / len(values)
        variance = math.fsum((value - mean) ** 2 for value in values) / len(values)
        classes = sorted({klass for _, klass in samples})
        records.append(
            {
                "variable": variable,
                "lead_band_h": list(band),
                "area": rec_area,
                "n_pairs": len(values),
                "bias": round(mean, 4),
                "spread": round(math.sqrt(variance), 4),
                "coverage_classes": {
                    klass: sum(c == klass for _, c in samples) for klass in classes
                },
            }
        )
    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lead_basis": "time_since_check",
        "records": records,
        "contributions": ordered,
        "skipped_pairs": skipped,
    }
    if legacy is not None:
        doc["legacy_evidence"] = legacy
    # Comparing all derived content also detects inconsistent saved statistics.
    if existing is not None and {k: v for k, v in existing.items() if k != "generated_at"} == {
        k: v for k, v in doc.items() if k != "generated_at"
    }:
        return existing
    _validate(doc)
    atomic_write_json(target, doc)
    return doc


__all__ = ["LEAD_BANDS", "DEFAULT_AREA", "accumulate_calibration", "default_calibration_path"]
