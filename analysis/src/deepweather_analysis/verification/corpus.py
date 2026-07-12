"""Retrospective corpus (brief §9): replay the PURE synoptic detector on
archived ERA5 fields and score it against per-case expectations.

The corpus validates the DETECTOR, not history trivia — expectations are
deliberately generous (approximate positions, conservative depth thresholds).

§9 caveat (binding, printed on every review sheet): this is
'reanalysis-referenced' validation. ERA5 assimilates observations but is NOT
independent ground truth.

Case files live in analysis/corpus_cases/*.json:
    {case_id, title, window: {start, end}, bounds, expectations, notes}
expectations.kind:
    'storm'    — expect_systems, min_center_hpa_below?, expect_low_near?
    'negative' — no_deep_low_below_hpa (default 1005); highs count as
                 systems, so negatives assert 'no deep low', never 'nothing'
    'regime'   — expect_regime ('mistral')
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from ..paths import REPO_ROOT, processed_dir
from ..synoptic import detect_mistral, detect_systems, track_systems
from .era5 import fetch_era5_case, open_case_dataset

logger = logging.getLogger(__name__)

CASES_DIR = REPO_ROOT / "analysis" / "corpus_cases"
STEP_H = 3
DEFAULT_NO_DEEP_LOW_HPA = 1005.0

REVIEW_CAVEAT = (
    "> **§9 caveat — reanalysis-referenced validation.** These results compare the "
    "detector against ERA5 reanalysis fields. ERA5 assimilates observations and is "
    "stronger than raw model output, but it is NOT independent ground truth; corpus "
    "passes earn structural confidence in the detector, never calibrated probabilities."
)


# =============================================================================
# Case loading
# =============================================================================


def load_cases(case_ids: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
    """Load corpus case files, optionally restricted to case_ids, sorted by id."""
    cases: List[Dict[str, Any]] = []
    for path in sorted(CASES_DIR.glob("*.json")):
        case = json.loads(path.read_text())
        cases.append(case)
    if case_ids is not None:
        wanted = set(case_ids)
        found = {c["case_id"] for c in cases} & wanted
        missing = wanted - found
        if missing:
            raise KeyError(f"Unknown corpus case(s): {sorted(missing)}")
        cases = [c for c in cases if c["case_id"] in wanted]
    return sorted(cases, key=lambda c: c["case_id"])


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# =============================================================================
# Expectation evaluation (PURE — unit-testable without network/files)
# =============================================================================


def _sep_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Separation in degrees, longitude scaled by cos(mean lat) (track.py convention)."""
    dlat = lat1 - lat2
    coslat = math.cos(math.radians(0.5 * (lat1 + lat2)))
    dlon = (lon1 - lon2) * coslat
    return math.hypot(dlat, dlon)


def evaluate_expectations(case: Dict[str, Any], detections: Dict[str, Any]) -> Dict[str, Any]:
    """
    Score one case's expectations against detection results. Pure.

    Args:
        case: corpus case dict (see module docstring)
        detections: {
            'per_step': [[detect_systems dicts, ...] per step],
            'step_hours': [h, ...],
            'regimes': [detect_mistral result or None per step]  (optional)
        }

    Returns:
        {case_id, status: 'pass'|'fail', checks: [{name, passed, detail}],
        deepest_low, position_error_deg, n_steps, n_low_detections}
    """
    expectations = case.get("expectations") or {}
    kind = expectations.get("kind")
    per_step: Sequence[Sequence[Dict[str, Any]]] = detections.get("per_step") or []
    step_hours: Sequence[int] = detections.get("step_hours") or list(range(len(per_step)))
    regimes: Sequence[Optional[Dict[str, Any]]] = detections.get("regimes") or []

    lows: List[Dict[str, Any]] = []
    any_system = False
    for step_idx, dets in enumerate(per_step):
        for det in dets:
            any_system = True
            if det.get("kind") == "low":
                lows.append({**det, "step_h": int(step_hours[step_idx])})

    deepest_low = min(lows, key=lambda d: d["center_hpa"]) if lows else None
    checks: List[Dict[str, Any]] = []
    position_error_deg: Optional[float] = None

    if kind in ("storm", "regime") and "expect_systems" in expectations:
        expect = bool(expectations["expect_systems"])
        passed = any_system if expect else not any_system
        checks.append(
            {
                "name": "expect_systems",
                "passed": passed,
                "detail": f"expected systems={expect}, detected {sum(len(d) for d in per_step)} "
                f"detections over {len(per_step)} steps",
            }
        )

    if "min_center_hpa_below" in expectations:
        threshold = float(expectations["min_center_hpa_below"])
        passed = deepest_low is not None and deepest_low["center_hpa"] < threshold
        detail = (
            f"deepest low {deepest_low['center_hpa']} hPa at "
            f"({deepest_low['lat']:.2f}, {deepest_low['lon']:.2f}) T+{deepest_low['step_h']}h "
            f"vs threshold < {threshold} hPa"
            if deepest_low
            else f"no low detected (threshold < {threshold} hPa)"
        )
        checks.append({"name": "min_center_hpa_below", "passed": passed, "detail": detail})

    if "expect_low_near" in expectations:
        target = expectations["expect_low_near"]
        tol = float(target.get("tol_deg", 4.0))
        # Judge position on lows meeting the depth criterion when one is
        # given, so a shallow nearby low can't stand in for the storm.
        threshold = expectations.get("min_center_hpa_below")
        candidates = (
            [l for l in lows if threshold is None or l["center_hpa"] < float(threshold)] or lows
        )
        if candidates:
            position_error_deg = round(
                min(
                    _sep_deg(l["lat"], l["lon"], float(target["lat"]), float(target["lon"]))
                    for l in candidates
                ),
                2,
            )
            passed = position_error_deg <= tol
            detail = (
                f"min separation {position_error_deg} deg from "
                f"({target['lat']}, {target['lon']}) vs tol {tol} deg"
            )
        else:
            passed = False
            detail = f"no candidate low to place near ({target['lat']}, {target['lon']})"
        checks.append({"name": "expect_low_near", "passed": passed, "detail": detail})

    if kind == "negative":
        threshold = float(expectations.get("no_deep_low_below_hpa", DEFAULT_NO_DEEP_LOW_HPA))
        offenders = [l for l in lows if l["center_hpa"] < threshold]
        passed = not offenders
        if offenders:
            worst = min(offenders, key=lambda d: d["center_hpa"])
            detail = (
                f"FALSE POSITIVE flagged: low {worst['center_hpa']} hPa at "
                f"({worst['lat']:.2f}, {worst['lon']:.2f}) T+{worst['step_h']}h "
                f"below the {threshold} hPa negative threshold"
            )
        else:
            detail = f"no low below {threshold} hPa (deepest: " + (
                f"{deepest_low['center_hpa']} hPa)" if deepest_low else "none)"
            )
        checks.append({"name": "no_deep_low", "passed": passed, "detail": detail})

    if "expect_regime" in expectations:
        expected = str(expectations["expect_regime"])
        detected_ids = sorted({r["regime_id"] for r in regimes if r})
        # detect_mistral is a combined Mistral/Tramontane rule; tramontane is
        # the same pattern channelling west of the Rhone, so it satisfies a
        # 'mistral' expectation (noted in the detail).
        family = {"mistral", "tramontane"} if expected == "mistral" else {expected}
        passed = bool(set(detected_ids) & family)
        checks.append(
            {
                "name": "expect_regime",
                "passed": passed,
                "detail": f"expected '{expected}', detected {detected_ids or 'none'} "
                f"over {len(regimes)} steps",
            }
        )

    if not checks:
        checks.append(
            {"name": "no_expectations", "passed": False, "detail": f"unrecognised kind '{kind}'"}
        )

    return {
        "case_id": case.get("case_id"),
        "kind": kind,
        "status": "pass" if all(c["passed"] for c in checks) else "fail",
        "checks": checks,
        "deepest_low": deepest_low,
        "position_error_deg": position_error_deg,
        "n_steps": len(per_step),
        "n_low_detections": len(lows),
    }


# =============================================================================
# Replay on ERA5
# =============================================================================


def _detect_on_dataset(case: Dict[str, Any], ds: Any) -> Dict[str, Any]:
    """Run detect/track (and regimes when expected) per 3 h step in the window."""
    start = _parse_iso(case["window"]["start"])
    end = _parse_iso(case["window"]["end"])

    lats = np.asarray(ds["latitude"].values, dtype=float).reshape(-1)
    lons = np.asarray(ds["longitude"].values, dtype=float).reshape(-1)
    times = ds["time"].values
    wants_regime = "expect_regime" in (case.get("expectations") or {})

    per_step: List[List[Dict[str, Any]]] = []
    regimes: List[Optional[Dict[str, Any]]] = []
    step_hours: List[int] = []

    for t_idx in range(times.size):
        t = datetime.fromtimestamp(
            (times[t_idx] - np.datetime64("1970-01-01T00:00:00")) / np.timedelta64(1, "s"),
            tz=timezone.utc,
        )
        if t < start or t > end:
            continue
        hours_from_start = (t - start).total_seconds() / 3600.0
        if hours_from_start % STEP_H != 0:
            continue

        msl = np.asarray(ds["msl"].isel(time=t_idx).values, dtype=float)
        if np.nanmean(msl) > 10000.0:  # tolerate Pa (synoptic_prep convention)
            msl = msl / 100.0
        per_step.append(detect_systems(msl, lats, lons))
        step_hours.append(int(hours_from_start))
        if wants_regime:
            regimes.append(
                detect_mistral(
                    msl,
                    np.asarray(ds["u10"].isel(time=t_idx).values, dtype=float),
                    np.asarray(ds["v10"].isel(time=t_idx).values, dtype=float),
                    lats,
                    lons,
                )
            )

    tracks = track_systems(per_step, step_hours) if per_step else []
    return {"per_step": per_step, "step_hours": step_hours, "regimes": regimes, "tracks": tracks}


def _route_conditions_note(case: Dict[str, Any]) -> Dict[str, Any]:
    """Record whether the Open-Meteo historical-forecast archive covers the
    case window at the bounds centre. Non-fatal by design."""
    from ..openmeteo_history import fetch_route_history

    bounds = case["bounds"]
    center = (
        0.5 * (bounds["min_lat"] + bounds["max_lat"]),
        0.5 * (bounds["min_lon"] + bounds["max_lon"]),
    )
    start = _parse_iso(case["window"]["start"]).strftime("%Y-%m-%d")
    end = _parse_iso(case["window"]["end"]).strftime("%Y-%m-%d")
    try:
        history = fetch_route_history([center], start, end)
        return {
            "route_conditions_available": history["route_conditions_available"],
            "route_conditions_model": history["model"],
        }
    except Exception as exc:  # never let the route note sink a corpus run
        logger.info("route-history note failed for %s: %s", case.get("case_id"), exc)
        return {"route_conditions_available": False, "route_conditions_error": str(exc)[:200]}


def run_case(case: Dict[str, Any], *, fetch: bool = True) -> Dict[str, Any]:
    """
    Run one corpus case end-to-end: ERA5 (fetch or cache) -> detection replay
    -> expectation evaluation -> route-conditions note.

    Returns evaluate_expectations output extended with {era5, route note};
    when the fields are not available the case comes back status 'pending'.
    """
    case_id = case["case_id"]
    start = _parse_iso(case["window"]["start"])
    end = _parse_iso(case["window"]["end"])

    if fetch:
        meta = fetch_era5_case(case_id, case["bounds"], start, end)
    else:
        from .era5 import _load_case_metadata

        meta = _load_case_metadata(case_id) or {
            "status": "pending",
            "error": "fetch disabled and no cache",
        }

    if meta.get("status") != "ok":
        return {
            "case_id": case_id,
            "kind": (case.get("expectations") or {}).get("kind"),
            "status": "pending",
            "checks": [],
            "deepest_low": None,
            "position_error_deg": None,
            "era5": {k: meta.get(k) for k in ("status", "source", "tier", "error")},
            "observation_source": "era5",
        }

    ds, meta = open_case_dataset(case_id)
    try:
        detections = _detect_on_dataset(case, ds)
    finally:
        ds.close()

    result = evaluate_expectations(case, detections)
    result["era5"] = {k: meta.get(k) for k in ("status", "source", "tier", "checksum")}
    result["observation_source"] = "era5"
    result.update(_route_conditions_note(case) if fetch else {"route_conditions_available": False})
    return result


# =============================================================================
# Review sheet
# =============================================================================


def _expected_summary(case: Dict[str, Any]) -> str:
    e = case.get("expectations") or {}
    parts: List[str] = []
    if e.get("expect_systems"):
        parts.append("systems present")
    if "min_center_hpa_below" in e:
        parts.append(f"low < {e['min_center_hpa_below']} hPa")
    if "expect_low_near" in e:
        t = e["expect_low_near"]
        parts.append(f"near ({t['lat']}, {t['lon']}) ±{t.get('tol_deg', 4)}°")
    if e.get("kind") == "negative":
        parts.append(f"no low < {e.get('no_deep_low_below_hpa', DEFAULT_NO_DEEP_LOW_HPA)} hPa")
    if "expect_regime" in e:
        parts.append(f"regime '{e['expect_regime']}'")
    return "; ".join(parts) or "(none)"


def _detected_summary(result: Dict[str, Any]) -> str:
    if result["status"] == "pending":
        era5 = result.get("era5") or {}
        return f"pending fetch ({era5.get('error') or 'no ERA5 cache yet'})"
    deepest = result.get("deepest_low")
    parts = [
        f"deepest low {deepest['center_hpa']} hPa at ({deepest['lat']:.1f}, {deepest['lon']:.1f}) "
        f"T+{deepest['step_h']}h"
        if deepest
        else "no low detected"
    ]
    if result.get("position_error_deg") is not None:
        parts.append(f"position error {result['position_error_deg']}°")
    regime_check = next(
        (c for c in result.get("checks", []) if c["name"] == "expect_regime"), None
    )
    if regime_check:
        parts.append(regime_check["detail"])
    return "; ".join(parts)


def _false_pos_neg_summary(results: List[Dict[str, Any]]) -> List[str]:
    lines: List[str] = []
    false_negatives = [
        r for r in results if r.get("kind") in ("storm", "regime") and r["status"] == "fail"
    ]
    false_positives = [r for r in results if r.get("kind") == "negative" and r["status"] == "fail"]
    lines.append(
        f"- **False negatives** (storm/regime cases the detector missed): "
        f"{len(false_negatives)}"
        + (f" — {', '.join(r['case_id'] for r in false_negatives)}" if false_negatives else "")
    )
    lines.append(
        f"- **False positives** (negative cases where a deep low was detected): "
        f"{len(false_positives)}"
        + (f" — {', '.join(r['case_id'] for r in false_positives)}" if false_positives else "")
    )
    pending = [r for r in results if r["status"] == "pending"]
    lines.append(
        f"- **Pending** (no ERA5 fields yet — no claim made): {len(pending)}"
        + (f" — {', '.join(r['case_id'] for r in pending)}" if pending else "")
    )
    return lines


def write_review_sheet(
    cases: List[Dict[str, Any]], results: List[Dict[str, Any]], path: Optional[Path] = None
) -> Path:
    """Emit the markdown review sheet (data/processed/verification/corpus-review.md)."""
    target = path or processed_dir("verification") / "corpus-review.md"
    by_id = {c["case_id"]: c for c in cases}

    lines: List[str] = [
        "# Retrospective corpus review (brief §9)",
        "",
        f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} — "
        f"{len(results)} case(s).",
        "",
        REVIEW_CAVEAT,
        "",
        "| case | window (UTC) | kind | expected | detected | result |",
        "|---|---|---|---|---|---|",
    ]
    for result in results:
        case = by_id[result["case_id"]]
        window = f"{case['window']['start'][:16]} → {case['window']['end'][:16]}"
        status = {"pass": "PASS", "fail": "FAIL", "pending": "pending"}[result["status"]]
        lines.append(
            f"| {result['case_id']} | {window} | {result.get('kind')} | "
            f"{_expected_summary(case)} | {_detected_summary(result)} | {status} |"
        )

    lines += ["", "## Per-case notes", ""]
    for result in results:
        case = by_id[result["case_id"]]
        lines.append(f"### {result['case_id']} — {case.get('title', '')}")
        for check in result.get("checks", []):
            mark = "PASS" if check["passed"] else "FAIL"
            lines.append(f"- [{mark}] {check['name']}: {check['detail']}")
        if result["status"] == "pending":
            lines.append("- pending: ERA5 fields not fetched yet; no claim made.")
        if "route_conditions_available" in result:
            lines.append(
                f"- route-layer archive (Open-Meteo historical forecast): "
                f"{'available' if result['route_conditions_available'] else 'not available for this window'}"
            )
        if case.get("notes"):
            lines.append(f"- case notes: {case['notes']}")
        lines.append("")

    lines += ["## False-positive / false-negative summary", ""]
    lines += _false_pos_neg_summary(results)
    lines += ["", REVIEW_CAVEAT, ""]

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines))
    return target


def run_corpus(
    case_ids: Optional[Sequence[str]] = None,
    fetch: bool = True,
    *,
    review_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Run the corpus (all cases or a subset) and write the review sheet.

    Cases whose ERA5 fields cannot be obtained come back 'pending' and the
    sheet says so — a pending case is never counted as pass OR fail.
    """
    cases = load_cases(case_ids)
    results = [run_case(case, fetch=fetch) for case in cases]
    sheet = write_review_sheet(cases, results, path=review_path)
    summary = {
        "cases": len(results),
        "pass": sum(1 for r in results if r["status"] == "pass"),
        "fail": sum(1 for r in results if r["status"] == "fail"),
        "pending": sum(1 for r in results if r["status"] == "pending"),
        "review_sheet": str(sheet),
        "results": results,
    }
    summary_path = sheet.with_name("corpus.json")
    summary_path.write_text(json.dumps({**summary, "review_sheet": sheet.name}, indent=2) + "\n")
    logger.info(
        "Corpus run: %d pass / %d fail / %d pending -> %s",
        summary["pass"],
        summary["fail"],
        summary["pending"],
        sheet,
    )
    return summary


__all__ = [
    "CASES_DIR",
    "REVIEW_CAVEAT",
    "evaluate_expectations",
    "load_cases",
    "run_case",
    "run_corpus",
    "write_review_sheet",
]
