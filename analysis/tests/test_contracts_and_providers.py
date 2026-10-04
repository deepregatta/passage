"""Repository contracts, configuration, and provider-mode validation."""

import json

import pytest
from jsonschema import Draft202012Validator

from deepweather_analysis.paths import config_dir, contracts_dir
from deepweather_analysis.providers import Mode, load_providers, provider_mode


def _load(path):
    return json.loads(path.read_text())


def test_all_contract_schemas_are_valid_2020_12():
    schemas = sorted(contracts_dir().glob("*.schema.json"))
    assert len(schemas) >= 13
    for schema_path in schemas:
        Draft202012Validator.check_schema(_load(schema_path))


def test_canonical_route_validates():
    schema = _load(contracts_dir() / "route.schema.json")
    route = _load(config_dir() / "routes" / "cherbourg-plymouth.json")
    Draft202012Validator(schema).validate(route)


def test_browser_routed_timing_contract():
    # Actual TS router output: the Python consumer accepts the additive contract.
    route_path = contracts_dir().parent / "engine/test/fixtures/routes/routed-current.json"
    route = _load(route_path)
    Draft202012Validator(_load(contracts_dir() / "route.schema.json")).validate(route)
    assert route["timing"]["basis"] == "routed"
    assert route["speeds_kt"]["nominal"] == pytest.approx(5)
    assert route["timing"]["legs"][0]["speed_over_ground_kt"] == pytest.approx(7, abs=0.01)


def test_default_limits_profile_validates():
    schema = _load(contracts_dir() / "limits-profile.schema.json")
    profile = _load(config_dir() / "profiles" / "default-limits.json")
    Draft202012Validator(schema).validate(profile)


def test_providers_load_with_valid_modes():
    providers = load_providers()
    expected = {
        "forecast_tiles",
        "ecmwf_open_data",
        "cmems_currents",
        "era5",
        "warnings_fr",
        "warnings_uk",
        "tides",
        "observations",
    }
    assert expected <= set(providers)
    assert not any(name.startswith("openmeteo_") for name in providers)
    assert provider_mode("tides", providers) is Mode.LIVE
    assert provider_mode("forecast_tiles", providers) is Mode.LIVE
    assert provider_mode("observations", providers) is Mode.LIVE


def test_unknown_provider_raises():
    with pytest.raises(KeyError):
        provider_mode("nonexistent", load_providers())


def test_saved_identity_contract_accepts_engine_v2_and_preserves_legacy():
    repo = contracts_dir().parent
    for name in ["snapshot", "route"]:
        schema = _load(contracts_dir() / f"{name}.schema.json")
        doc = _load(repo / f"engine/test/fixtures/identity-v2/{name}.json")
        Draft202012Validator(schema).validate(doc)
        assert doc["passage_id"] == "contract-intent"
        if name == "snapshot":
            assert doc["identity_version"] == 2
            assert "decision_inputs" in doc["artifacts"]
            for field in ["route_revision", "decision_hash", "passage_id", "check_sequence"]:
                broken = dict(doc)
                del broken[field]
                assert not Draft202012Validator(schema).is_valid(broken)
    findings = _load(repo / "engine/test/golden/findings-cherbourg-plymouth.json")
    Draft202012Validator(_load(contracts_dir() / "findings.schema.json")).validate(findings)
    assert findings["identity_version"] == 2
    for root in ["viewer/test/fixtures/demo/snapshots", "viewer/test/fixtures/compatibility"]:
        for directory in (repo / root).iterdir():
            if not directory.is_dir():
                continue
            for name in ["snapshot", "route", "findings"]:
                path = directory / f"{name}.json"
                if path.exists():
                    before = path.read_bytes()
                    Draft202012Validator(_load(contracts_dir() / f"{name}.schema.json")).validate(
                        _load(path)
                    )
                    assert path.read_bytes() == before


def test_decision_message_writer_and_tolerant_reader_contracts():
    repo = contracts_dir().parent
    writer = Draft202012Validator(_load(contracts_dir() / "briefing.schema.json"))
    reader = Draft202012Validator(_load(contracts_dir() / "briefing-reader.schema.json"))
    produced = _load(repo / "engine/test/fixtures/decision-messages.json")
    assert produced["source_kind"] == "emulated"
    for case in produced["cases"]:
        doc = case["briefing"]
        writer.validate(doc)
        reader.validate(doc)
        section = doc["sections"][0]
        assert section["messages"]["plain"]
        assert section["messages"]["pro"]
    for root in [
        "engine/test/golden",
        "viewer/test/fixtures/demo",
        "viewer/test/fixtures/compatibility",
    ]:
        for path in (repo / root).rglob("*.json"):
            if path.name != "briefing.json" and not path.name.startswith("briefing-"):
                continue
            before = path.read_bytes()
            writer.validate(_load(path))
            reader.validate(_load(path))
            assert path.read_bytes() == before
    future = json.loads(json.dumps(produced["cases"][5]["briefing"]))
    future["sections"][0]["messages"]["plain"].append(
        {"message_id": "briefing.decision.future.v9", "params": {"future": True}}
    )
    assert not writer.is_valid(future)
    reader.validate(future)
    future["schema_version"] = 99
    assert not reader.is_valid(future)
    for bad in [{"units": "mph"}, {"valid_time": "tomorrow"}, {"value": "28"}]:
        doc = json.loads(json.dumps(produced["cases"][5]["briefing"]))
        doc["sections"][0]["messages"]["plain"][1]["params"].update(bad)
        assert not writer.is_valid(doc)
