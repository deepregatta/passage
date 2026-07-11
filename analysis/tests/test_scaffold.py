"""M0 scaffold tests: contracts parse, configs validate, provider framework loads."""

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


def test_default_limits_profile_validates():
    schema = _load(contracts_dir() / "limits-profile.schema.json")
    profile = _load(config_dir() / "profiles" / "default-limits.json")
    Draft202012Validator(schema).validate(profile)


def test_providers_load_with_valid_modes():
    providers = load_providers()
    expected = {
        "openmeteo_forecast",
        "openmeteo_ensemble",
        "openmeteo_marine",
        "ecmwf_open_data",
        "cmems_currents",
        "era5",
        "warnings_fr",
        "warnings_uk",
        "tides",
        "observations",
    }
    assert expected <= set(providers)
    assert provider_mode("tides", providers) is Mode.SYNTHETIC
    assert provider_mode("openmeteo_forecast", providers) is Mode.LIVE


def test_unknown_provider_raises():
    with pytest.raises(KeyError):
        provider_mode("nonexistent", load_providers())
