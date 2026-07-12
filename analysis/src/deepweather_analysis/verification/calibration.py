"""Calibration accumulation (brief §9). Records only — never weighting.

Aggregates matched forecast/observation pairs into per-(variable, lead band,
area) records: sample size, coverage-class counts, bias (mean error) and
spread (population std of error).

§9 rules (binding):
- every record carries its sample size (the contract makes n_pairs required);
- NO weighting logic lives here — records are evidence, and nothing may turn
  them into model weights until the sample justifies it.

Merging with an existing calibration.json combines aggregates exactly
(n-weighted mean; pooled population variance), so incremental accumulation
matches a one-shot computation up to stored rounding.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..paths import contracts_dir, processed_dir

SCHEMA_VERSION = 1
DEFAULT_AREA = "channel"

# Lead-time bands in hours: [lo, hi) — pairs with lead outside all bands are
# counted nowhere (recorded honestly in the return value's 'skipped_pairs').
LEAD_BANDS: Tuple[Tuple[int, int], ...] = ((0, 12), (12, 24), (24, 48))

_ROUND = 4


def _band_for(lead_h: float) -> Optional[Tuple[int, int]]:
    for lo, hi in LEAD_BANDS:
        if lo <= lead_h < hi:
            return (lo, hi)
    return None


def default_calibration_path() -> Path:
    return processed_dir("verification") / "calibration.json"


def _validate(doc: Dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads((contracts_dir() / "calibration.schema.json").read_text())
    jsonschema.validate(instance=doc, schema=schema)


class _Agg:
    """Exact-mergeable population aggregate (n, mean, variance)."""

    def __init__(self) -> None:
        self.n = 0
        self.mean = 0.0
        self.var = 0.0  # population variance
        self.classes: Dict[str, int] = {}

    def add_value(self, value: float) -> None:
        # Incremental population mean/variance (Welford, population form).
        self.n += 1
        delta = value - self.mean
        self.mean += delta / self.n
        self.var += (delta * (value - self.mean) - self.var) / self.n

    def merge_aggregate(self, n: int, mean: Optional[float], var: Optional[float]) -> None:
        if n <= 0:
            return
        mean = mean or 0.0
        var = var or 0.0
        total = self.n + n
        combined_mean = (self.n * self.mean + n * mean) / total
        # Pooled population variance: E[x^2] - mean^2 over the union.
        ex2 = (self.n * (self.var + self.mean**2) + n * (var + mean**2)) / total
        self.n = total
        self.mean = combined_mean
        self.var = max(0.0, ex2 - combined_mean**2)

    def add_classes(self, classes: Dict[str, int]) -> None:
        for name, count in (classes or {}).items():
            self.classes[name] = self.classes.get(name, 0) + int(count)


def accumulate_calibration(
    verification_docs: Iterable[Dict[str, Any]],
    *,
    area: str = DEFAULT_AREA,
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Accumulate verification pairs into the calibration record and persist it.

    Args:
        verification_docs: match_snapshot outputs (each with a 'pairs' list)
        area: area label for the new pairs (v0: 'channel')
        path: calibration.json location (default
            data/processed/verification/calibration.json); an existing file is
            merged, not overwritten.

    Returns:
        the schema-valid calibration document that was written.
    """
    target = path or default_calibration_path()

    aggs: Dict[Tuple[str, Tuple[int, int], str], _Agg] = {}

    # 1. Fold in the existing persisted records (exact aggregate merge).
    if target.exists():
        try:
            existing = json.loads(target.read_text())
        except (json.JSONDecodeError, OSError):
            existing = {}
        for record in existing.get("records", []):
            classes = record.get("coverage_classes", {})
            if classes and set(classes) <= {"emulated"}:
                continue
            band = tuple(record.get("lead_band_h", ()))
            if len(band) != 2:
                continue
            key = (record["variable"], (int(band[0]), int(band[1])), record.get("area", area))
            agg = aggs.setdefault(key, _Agg())
            spread = record.get("spread")
            agg.merge_aggregate(
                int(record.get("n_pairs", 0)),
                record.get("bias"),
                None if spread is None else float(spread) ** 2,
            )
            agg.add_classes(record.get("coverage_classes", {}))

    # 2. Fold in the new pairs.
    skipped = 0
    for doc in verification_docs:
        if doc.get("observation_source") == "emulated":
            skipped += len(doc.get("pairs", []))
            continue
        for pair in doc.get("pairs", []):
            lead_h = pair.get("lead_h")
            error = pair.get("error")
            if lead_h is None or error is None:
                skipped += 1
                continue
            band = _band_for(float(lead_h))
            if band is None:
                skipped += 1
                continue
            cls = pair.get("coverage_class", "not_independently_observed")
            if cls == "emulated":
                skipped += 1
                continue
            key = (pair.get("variable", "wind_kt"), band, area)
            agg = aggs.setdefault(key, _Agg())
            agg.add_value(float(error))
            agg.add_classes({cls: 1})

    records: List[Dict[str, Any]] = []
    for (variable, band, rec_area), agg in sorted(
        aggs.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])
    ):
        records.append(
            {
                "variable": variable,
                "lead_band_h": [band[0], band[1]],
                "area": rec_area,
                "n_pairs": agg.n,
                "coverage_classes": agg.classes,
                "bias": round(agg.mean, _ROUND) if agg.n else None,
                "spread": round(math.sqrt(agg.var), _ROUND) if agg.n else None,
            }
        )

    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "records": records,
    }
    _validate(doc)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(doc, indent=2) + "\n")
    if skipped:
        doc = {**doc, "skipped_pairs": skipped}  # returned, not persisted (not in contract)
    return doc


__all__ = ["LEAD_BANDS", "DEFAULT_AREA", "accumulate_calibration", "default_calibration_path"]
