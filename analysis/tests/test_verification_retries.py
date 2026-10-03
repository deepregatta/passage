"""Retry/replacement witnesses through the real matcher and accumulator."""

import copy
import json

import pytest

from deepweather_analysis.verification.calibration import accumulate_calibration
from deepweather_analysis.verification.match import match_snapshot


def case(snapshot_id="case-a", observed=16):
    findings = {
        "snapshot_id": snapshot_id,
        "generated_at": "2026-07-12T08:00:00Z",
        "inputs": {"forecast_tiles": [{"layer": "weather", "cycle": "2026-07-12T00:00:00Z"}]},
        "legs": [
            {
                "leg_id": "L1",
                "sample_point": {"lat": 50, "lon": -2},
                "hours": [{"valid_time": "2026-07-12T12:00:00Z", "wind_kt": 18}],
            }
        ],
    }
    observations = {
        "source": {"name": "test-station", "mode": "fixture"},
        "stations": [
            {
                "station_id": "test",
                "lat": 50,
                "lon": -2,
                "records": [{"time": "2026-07-12T12:00:00Z", "wind_kt": observed}],
            }
        ],
    }
    return match_snapshot(findings, observations)


def test_retry_is_identical_even_after_a_new_verification_clock(tmp_path):
    path = tmp_path / "calibration.json"
    first = accumulate_calibration([case()], path=path)
    original_bytes = path.read_bytes()
    retry = case()
    retry["generated_at"] = "2026-07-15T00:00:00Z"
    second = accumulate_calibration([retry], path=path)
    assert second == first
    assert path.read_bytes() == original_bytes
    assert second["records"][0]["n_pairs"] == 1


def test_corrected_observations_replace_then_empty_case_removes_contribution(tmp_path):
    path = tmp_path / "calibration.json"
    accumulate_calibration([case()], path=path)
    corrected = accumulate_calibration([case(observed=12)], path=path)
    assert corrected["records"][0]["n_pairs"] == 1
    assert corrected["records"][0]["bias"] == 6
    assert corrected["records"][0]["spread"] == 0
    empty = case()
    empty["pairs"] = []
    empty["coverage_summary"] = {"not_independently_observed": 1}
    empty["not_independently_observed"] = ["L1"]
    # Revision is assigned by the producer; regenerate it for the correction.
    from deepweather_analysis.verification.match import case_revision

    empty["case_revision"] = case_revision(empty)
    assert accumulate_calibration([empty], path=path)["records"] == []


def test_distinct_case_order_and_pair_order_do_not_change_statistics(tmp_path):
    docs = [case("a", 16), case("b", 12), case("c", 17)]
    forward = accumulate_calibration(docs, path=tmp_path / "forward.json")
    backward = accumulate_calibration(reversed(docs), path=tmp_path / "backward.json")
    assert forward["records"] == backward["records"]
    assert forward["contributions"] == backward["contributions"]
    assert forward["records"][0]["n_pairs"] == 3
    from deepweather_analysis.verification.match import case_revision

    multi = case()
    multi["pairs"] += case("b", 12)["pairs"]
    multi["case_revision"] = case_revision(multi)
    first = accumulate_calibration([multi], path=tmp_path / "pairs.json")
    multi["pairs"].reverse()
    assert accumulate_calibration([multi], path=tmp_path / "pairs.json") == first


def test_legacy_totals_preserved_separately_and_never_merged(tmp_path):
    path = tmp_path / "calibration.json"
    legacy = {
        "schema_version": 1,
        "generated_at": "2026-01-01T00:00:00Z",
        "records": [
            {
                "variable": "wind_kt",
                "lead_band_h": [0, 12],
                "area": "channel",
                "n_pairs": 41,
                "bias": 3,
                "spread": 2,
                "coverage_classes": {"verified_near_observation": 41},
            }
        ],
    }
    path.write_text(json.dumps(legacy))
    result = accumulate_calibration([case()], path=path)
    assert result["legacy_evidence"] == legacy
    assert result["records"][0]["n_pairs"] == 1
    assert accumulate_calibration([case()], path=path)["legacy_evidence"] == legacy


def test_corrupt_existing_aggregate_is_not_silently_cleared(tmp_path):
    path = tmp_path / "calibration.json"
    path.write_text("{broken")
    with pytest.raises(ValueError):
        accumulate_calibration([case()], path=path)
    assert path.read_text() == "{broken"


def test_conflicting_revisions_in_one_batch_are_rejected_without_writing(tmp_path):
    path = tmp_path / "calibration.json"
    with pytest.raises(ValueError, match="conflicting"):
        accumulate_calibration([case(), case(observed=12)], path=path)
    assert not path.exists()


def test_producer_separates_check_and_model_lead_with_source_and_contract():
    import jsonschema
    from deepweather_analysis.paths import contracts_dir

    doc = case()
    assert doc["observation_source"] == "test-station"
    assert doc["observation_provenance"] == {"name": "test-station", "mode": "fixture"}
    pair = doc["pairs"][0]
    assert pair["check_lead_h"] == 4
    assert pair["model_lead_h"] == 12
    assert pair["model_cycle"] == "2026-07-12T00:00:00Z"
    schema = json.loads((contracts_dir() / "verification-case.schema.json").read_text())
    jsonschema.validate(doc, schema, format_checker=jsonschema.FormatChecker())
    modified = copy.deepcopy(doc)
    modified["pairs"][0]["observed"] = "missing"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(modified, schema)


def test_python_generated_fixture_and_legacy_demo_share_the_declared_contract():
    import jsonschema
    from deepweather_analysis.paths import REPO_ROOT, contracts_dir

    schema = json.loads((contracts_dir() / "verification-case.schema.json").read_text())
    fixture = json.loads((REPO_ROOT / "viewer/test/fixtures/verification-case-v2.json").read_text())
    generated = case(fixture["snapshot_id"])
    fixture.pop("generated_at")
    generated.pop("generated_at")
    assert fixture == generated
    for path in [
        REPO_ROOT / "viewer/test/fixtures/verification-case-v2.json",
        *(REPO_ROOT / "viewer/test/fixtures/demo/verification/cases").glob("*.json"),
    ]:
        if path.name == "index.json":
            continue
        jsonschema.validate(
            json.loads(path.read_text()), schema, format_checker=jsonschema.FormatChecker()
        )
    calibration_schema = json.loads((contracts_dir() / "calibration.schema.json").read_text())
    assert calibration_schema["$defs"]["case"] == {
        k: v for k, v in schema.items() if k not in {"$schema", "$id", "title"}
    }


def test_missing_or_ambiguous_model_cycle_is_not_invented():
    base = {
        "snapshot_id": "unknown",
        "generated_at": "2026-07-12T08:00:00Z",
        "legs": [
            {
                "leg_id": "L1",
                "sample_point": {"lat": 50, "lon": -2},
                "hours": [{"valid_time": "2026-07-12T12:00:00Z", "wind_kt": 18}],
            }
        ],
    }
    obs = {
        "source": {"name": "test", "mode": "fixture"},
        "stations": [
            {
                "station_id": "s",
                "lat": 50,
                "lon": -2,
                "records": [{"time": "2026-07-12T12:00:00Z", "wind_kt": 10}],
            }
        ],
    }
    for cycles in [[], ["scenario"], ["2026-07-12T00:00:00Z", "2026-07-12T06:00:00Z"]]:
        base["inputs"] = {"forecast_tiles": [{"layer": "weather", "cycle": c} for c in cycles]}
        pair = match_snapshot(base, obs)["pairs"][0]
        assert pair["check_lead_h"] == pair["lead_h"] == 4
        assert pair["model_lead_h"] is None
        assert pair["model_cycle"] is None
    base.pop("generated_at")
    base["departure_utc"] = "2026-07-12T06:00:00Z"
    pair = match_snapshot(base, obs)["pairs"][0]
    assert pair["check_lead_h"] is None
    assert pair["lead_h"] is None


def test_emulated_correction_removes_old_real_contribution(tmp_path):
    from deepweather_analysis.verification.match import case_revision

    path = tmp_path / "calibration.json"
    accumulate_calibration([case()], path=path)
    doc = case()
    doc.update(
        observation_source="emulated",
        source_mode="synthetic",
        observation_provenance={"name": "test", "mode": "synthetic"},
    )
    doc["pairs"][0]["coverage_class"] = "emulated"
    doc["case_revision"] = case_revision(doc)
    out = accumulate_calibration([doc], path=path)
    assert out["records"] == []
    assert out["skipped_pairs"] == 1
