"""M13 tests: corpus expectation evaluator (pure, synthetic detection results)
and the corpus case files themselves. No network.
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from deepweather_analysis.verification.corpus import (
    CASES_DIR,
    evaluate_expectations,
    load_cases,
)

# =============================================================================
# Synthetic detection-result builders
# =============================================================================


def low(lat: float, lon: float, center_hpa: float) -> dict:
    return {"kind": "low", "lat": lat, "lon": lon, "center_hpa": center_hpa, "closed_contour": True}


def high(lat: float, lon: float, center_hpa: float) -> dict:
    return {
        "kind": "high",
        "lat": lat,
        "lon": lon,
        "center_hpa": center_hpa,
        "closed_contour": True,
    }


def storm_case(**expectations) -> dict:
    return {
        "case_id": "test-storm",
        "window": {"start": "2023-11-01T00:00:00Z", "end": "2023-11-02T21:00:00Z"},
        "bounds": {"min_lat": 35, "max_lat": 65, "min_lon": -35, "max_lon": 10},
        "expectations": {"kind": "storm", "expect_systems": True, **expectations},
    }


# =============================================================================
# evaluate_expectations
# =============================================================================


class TestStormExpectations:
    def test_deep_low_near_target_passes(self):
        case = storm_case(
            min_center_hpa_below=968, expect_low_near={"lat": 50.0, "lon": 0.0, "tol_deg": 4.0}
        )
        detections = {
            "per_step": [[low(49.0, -3.0, 965.0)], [low(50.5, 0.5, 955.0)]],
            "step_hours": [0, 3],
        }
        result = evaluate_expectations(case, detections)
        assert result["status"] == "pass"
        assert all(c["passed"] for c in result["checks"])
        assert result["deepest_low"]["center_hpa"] == 955.0
        assert result["position_error_deg"] is not None
        assert result["position_error_deg"] <= 4.0

    def test_too_shallow_low_fails_depth_check(self):
        case = storm_case(min_center_hpa_below=968)
        detections = {"per_step": [[low(50.0, 0.0, 980.0)]], "step_hours": [0]}
        result = evaluate_expectations(case, detections)
        assert result["status"] == "fail"
        failed = {c["name"] for c in result["checks"] if not c["passed"]}
        assert failed == {"min_center_hpa_below"}

    def test_low_too_far_fails_position_check(self):
        case = storm_case(
            min_center_hpa_below=968, expect_low_near={"lat": 50.0, "lon": 0.0, "tol_deg": 4.0}
        )
        detections = {"per_step": [[low(62.0, -30.0, 950.0)]], "step_hours": [0]}
        result = evaluate_expectations(case, detections)
        assert result["status"] == "fail"
        failed = {c["name"] for c in result["checks"] if not c["passed"]}
        assert failed == {"expect_low_near"}

    def test_shallow_nearby_low_cannot_stand_in_for_the_storm(self):
        """Position is judged on lows meeting the depth criterion."""
        case = storm_case(
            min_center_hpa_below=968, expect_low_near={"lat": 50.0, "lon": 0.0, "tol_deg": 4.0}
        )
        detections = {
            "per_step": [[low(50.0, 0.0, 1000.0), low(62.0, -30.0, 950.0)]],
            "step_hours": [0],
        }
        result = evaluate_expectations(case, detections)
        position = next(c for c in result["checks"] if c["name"] == "expect_low_near")
        assert not position["passed"]

    def test_no_systems_at_all_fails_expect_systems(self):
        case = storm_case()
        result = evaluate_expectations(case, {"per_step": [[], []], "step_hours": [0, 3]})
        assert result["status"] == "fail"
        assert result["deepest_low"] is None


class TestNegativeExpectations:
    def negative_case(self, threshold: float = 1005) -> dict:
        return {
            "case_id": "test-negative",
            "window": {"start": "2023-06-12T00:00:00Z", "end": "2023-06-12T21:00:00Z"},
            "bounds": {"min_lat": 43, "max_lat": 58, "min_lon": -15, "max_lon": 5},
            "expectations": {"kind": "negative", "no_deep_low_below_hpa": threshold},
        }

    def test_quiet_ridge_passes(self):
        # A high and a SHALLOW low: highs count as systems and must not fail
        # the negative; a 1008 low is above the 1005 threshold.
        detections = {
            "per_step": [[high(50.0, -5.0, 1028.0), low(55.0, -12.0, 1008.0)]],
            "step_hours": [0],
        }
        result = evaluate_expectations(self.negative_case(), detections)
        assert result["status"] == "pass"

    def test_1002_low_flags_false_positive(self):
        detections = {"per_step": [[low(50.0, -5.0, 1002.0)]], "step_hours": [0]}
        result = evaluate_expectations(self.negative_case(), detections)
        assert result["status"] == "fail"
        check = next(c for c in result["checks"] if c["name"] == "no_deep_low")
        assert not check["passed"]
        assert "FALSE POSITIVE" in check["detail"]
        assert "1002" in check["detail"]


class TestRegimeExpectations:
    def regime_case(self) -> dict:
        return {
            "case_id": "test-regime",
            "window": {"start": "2023-08-04T00:00:00Z", "end": "2023-08-04T21:00:00Z"},
            "bounds": {"min_lat": 38, "max_lat": 48, "min_lon": -5, "max_lon": 15},
            "expectations": {"kind": "regime", "expect_systems": True, "expect_regime": "mistral"},
        }

    def test_mistral_detected_passes(self):
        detections = {
            "per_step": [[low(44.0, 9.0, 1008.0)], [low(44.0, 9.5, 1007.0)]],
            "step_hours": [0, 3],
            "regimes": [None, {"regime_id": "mistral", "rule_id": "R-MISTRAL-01"}],
        }
        result = evaluate_expectations(self.regime_case(), detections)
        assert result["status"] == "pass"

    def test_tramontane_satisfies_mistral_expectation(self):
        detections = {
            "per_step": [[low(44.0, 9.0, 1008.0)]],
            "step_hours": [0],
            "regimes": [{"regime_id": "tramontane", "rule_id": "R-MISTRAL-01"}],
        }
        result = evaluate_expectations(self.regime_case(), detections)
        regime = next(c for c in result["checks"] if c["name"] == "expect_regime")
        assert regime["passed"]

    def test_no_regime_detected_fails(self):
        detections = {
            "per_step": [[low(44.0, 9.0, 1008.0)]],
            "step_hours": [0],
            "regimes": [None],
        }
        result = evaluate_expectations(self.regime_case(), detections)
        assert result["status"] == "fail"


# =============================================================================
# Corpus case files
# =============================================================================

VALID_KINDS = {"storm", "negative", "regime"}


class TestCorpusCaseFiles:
    def test_at_least_ten_cases(self):
        assert len(load_cases()) >= 10

    def test_case_files_well_formed(self):
        for case in load_cases():
            assert case["case_id"], "case_id required"
            assert case["title"]
            start = datetime.fromisoformat(case["window"]["start"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(case["window"]["end"].replace("Z", "+00:00"))
            assert start < end, case["case_id"]
            b = case["bounds"]
            assert b["min_lat"] < b["max_lat"] and b["min_lon"] < b["max_lon"], case["case_id"]
            assert case["expectations"]["kind"] in VALID_KINDS, case["case_id"]
            assert case["notes"], f"{case['case_id']}: §9 wants the provenance/confidence noted"

    def test_case_ids_match_filenames(self):
        for path in sorted(CASES_DIR.glob("*.json")):
            case = json.loads(path.read_text())
            assert case["case_id"] == path.stem

    def test_corpus_composition(self):
        cases = load_cases()
        kinds = [c["expectations"]["kind"] for c in cases]
        assert kinds.count("negative") >= 3
        assert kinds.count("regime") >= 1
        assert kinds.count("storm") >= 6

    def test_negatives_use_no_deep_low_not_no_systems(self):
        """Highs count as systems — negatives must assert 'no deep low'."""
        for case in load_cases():
            e = case["expectations"]
            if e["kind"] == "negative":
                assert "no_deep_low_below_hpa" in e, case["case_id"]
                assert e.get("expect_systems") is not False, case["case_id"]

    def test_load_cases_subset_and_unknown(self):
        subset = load_cases(["ciaran-2023-11"])
        assert [c["case_id"] for c in subset] == ["ciaran-2023-11"]
        with pytest.raises(KeyError):
            load_cases(["no-such-case"])

    def test_ciaran_expectations(self):
        (ciaran,) = load_cases(["ciaran-2023-11"])
        e = ciaran["expectations"]
        assert e["kind"] == "storm"
        assert e["min_center_hpa_below"] == 968
        assert e["expect_low_near"]["tol_deg"] == 4.0


@pytest.mark.parametrize(
    "start,expected",
    [
        ("2023-11-01T00:00:00Z", [0, 3, 6, 9]),
        ("2023-11-01T00:30:00Z", [2.5, 5.5, 8.5]),
        ("2023-11-01T01:00:00Z", [2, 5, 8]),
        ("2023-11-01T02:30:00+02:00", [2.5, 5.5, 8.5]),
    ],
)
def test_replay_uses_utc_analysis_cadence_for_off_hour_windows(monkeypatch, start, expected):
    import numpy as np
    import xarray as xr
    from deepweather_analysis.verification import corpus

    times = np.arange("2023-11-01T00", "2023-11-01T12", dtype="datetime64[h]")
    ds = xr.Dataset(
        {"msl": (("time", "latitude", "longitude"), np.full((12, 2, 2), 99000.0))},
        coords={
            "time": times.astype("datetime64[ns]"),
            "latitude": [49.0, 50.0],
            "longitude": [-5.0, -4.0],
        },
    )
    monkeypatch.setattr(corpus, "detect_systems", lambda *args: [low(49.0, -5.0, 990.0)])
    case = storm_case()
    case["window"] = {"start": start, "end": "2023-11-01T09:30:00Z"}
    result = corpus._detect_on_dataset(case, ds)
    assert result["step_hours"] == expected
    assert len(result["per_step"]) == len(expected)
    assert [p["step_h"] for p in result["tracks"][0]["track"]] == expected
    evaluation = corpus.evaluate_expectations(case, result)
    assert evaluation["deepest_low"]["step_h"] == expected[0]
