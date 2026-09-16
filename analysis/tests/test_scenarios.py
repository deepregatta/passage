"""Synthetic harness points and warnings follow the selected route configuration."""

import json

import pytest
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

from deepweather_analysis import scenarios
from deepweather_analysis.paths import config_dir, contracts_dir


@pytest.mark.parametrize(
    "route_id",
    ["cherbourg-plymouth-v1", "newport-newyork-v1", "palma-barcelona-v1", "brisbane-gladstone-v1"],
)
def test_scenario_uses_route_points_and_zones(tmp_path, monkeypatch, route_id):
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))
    route = next(
        doc
        for path in (config_dir() / "routes").glob("*.json")
        if (doc := json.loads(path.read_text()))["route_id"] == route_id
    )
    zones = json.loads((config_dir() / "route-zones.json").read_text())["routes"][route_id]
    zone_ids = {z["zone_id"] for group in zones.values() for z in group}
    output = scenarios.generate_scenario("warning", route_id=route_id)
    for name in ("forecast", "ensemble", "marine", "multimodel"):
        points = json.loads((output / f"{name}.json").read_text())
        assert len(points) == len(route["waypoints"]) - 1
        for point, a, b in zip(points, route["waypoints"], route["waypoints"][1:]):
            assert point["latitude"] == pytest.approx((a["lat"] + b["lat"]) / 2)
            assert point["longitude"] == pytest.approx((a["lon"] + b["lon"]) / 2)
    doc = json.loads((output / "warnings.json").read_text())
    schema = json.loads((contracts_dir() / "warnings.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(doc)
    assert doc["source"]["mode"] == "synthetic"
    assert {b["zone_id"] for b in doc["bulletins"]} == zone_ids
    assert json.loads((output / "scenario.json").read_text())["route_id"] == route_id


def test_warnings_are_validated_before_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path / "data"))
    contracts = tmp_path / "contracts"
    contracts.mkdir()
    (contracts / "warnings.schema.json").write_text(json.dumps({"type": "object", "not": {}}))
    monkeypatch.setattr(scenarios, "contracts_dir", lambda: contracts, raising=False)
    with pytest.raises(ValidationError):
        scenarios.generate_scenario("warning")
    assert not list((tmp_path / "data").rglob("warnings.json"))


def test_unknown_route_fails_before_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="route"):
        scenarios.generate_scenario("warning", route_id="unknown")
    assert list(tmp_path.iterdir()) == []


def test_cli_passes_route_to_all_scenarios(tmp_path, monkeypatch):
    from deepweather_analysis.cli import main

    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))
    assert main(["scenario", "all", "--route", "newport-newyork-v1"]) == 0
    for name in scenarios.SCENARIOS:
        metadata = json.loads(next(tmp_path.rglob(f"{name}/scenario.json")).read_text())
        assert metadata["route_id"] == "newport-newyork-v1"


def test_route_outputs_are_isolated_and_naive_departure_is_valid_utc(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))
    default = scenarios.generate_scenario("warning", "2026-07-20T06:00:00")
    before = (default / "warnings.json").read_bytes()
    other = scenarios.generate_scenario("warning", route_id="palma-barcelona-v1")
    assert default == tmp_path / "scenarios" / "warning"
    assert default != other
    assert (default / "warnings.json").read_bytes() == before
    assert json.loads(before)["fetched_at"] == "2026-07-20T06:00:00+00:00"
