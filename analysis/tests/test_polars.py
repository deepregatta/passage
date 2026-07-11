"""M11 polar tests: vendored normalization/matching survive the port, and
extract_polar publishes schema-valid artifacts with a maintained index."""

import json

import pytest
from jsonschema import Draft202012Validator

from deepweather_analysis.paths import contracts_dir
from deepweather_analysis.polars import (
    DEFAULT_POLARS,
    default_polars_file,
    extract_polar,
    get_default_polars,
    load_orc_polars,
    match_polar,
    normalize_model,
    normalize_text,
    polar_table_to_axes,
    search_orc,
)


@pytest.fixture(scope="module")
def orc_index():
    index = load_orc_polars(default_polars_file())
    assert index["by_model"], "vendored ORC db should be present at data/raw/polars"
    return index


# --- normalization: special cases survive the port -------------------------


def test_normalize_text_examples():
    assert normalize_text("SUN FAST 3200") == "SUNFAST3200"
    assert normalize_text("J-99") == "J99"
    assert normalize_text("First 36.7") == "FIRST367"


def test_normalize_model_special_cases():
    # FIGARO II Roman-numeral special case
    assert normalize_model("FIGARO II") == "FIGARO2"
    # SIGMA 38 OOD one-design designation stripped
    assert normalize_model("SIGMA 38 OOD") == "SIGMA38"
    # Version/draft suffixes stripped
    assert normalize_model("SUN FAST 3200 R2 1.90") == "SUNFAST3200"
    assert normalize_model("JPK 10.10 1.98 T") == "JPK1010"


# --- matching ladder --------------------------------------------------------


def test_exact_model_beats_fuzzy(orc_index):
    # 'sunfast3200' normalizes to the exact model key, so the exact-model tier
    # fires before the fuzzy tier ever runs.
    result = match_polar("", "sunfast3200", orc_index)
    assert result.match_type == "model"
    assert normalize_model(result.orc_boat_type) == "SUNFAST3200"
    assert result.polars is not None


def test_fuzzy_finds_sun_fast_3200(orc_index):
    # A query that does not normalize to an exact key drops to the fuzzy
    # nearest-model tier and still lands on Sun Fast 3200.
    result = match_polar("", "Sun Fast 3200 XY", orc_index)
    assert result.match_type == "nearest_model"
    assert normalize_model(result.orc_boat_type) == "SUNFAST3200"
    assert result.polars is not None


def test_nonsense_query_falls_back_to_generic(orc_index):
    result = match_polar("", "Blorptron Qzx 9999", orc_index)
    assert result.match_type == "generic"
    assert result.polar_source == "generic"
    assert result.polars == DEFAULT_POLARS


# --- axes/matrix transform --------------------------------------------------


def test_polar_table_to_axes_interpolates_missing_twa():
    table = {
        10.0: {60.0: 6.0, 90.0: 8.0, 120.0: 7.0},
        14.0: {60.0: 7.0, 120.0: 9.0},  # 90 missing -> interpolated
    }
    tws, twa, speeds = polar_table_to_axes(table)
    assert tws == [10.0, 14.0]
    assert twa == [60.0, 90.0, 120.0]
    # midpoint of 7.0 and 9.0
    assert speeds[1][1] == pytest.approx(8.0)
    # known values pass through
    assert speeds[0] == [6.0, 8.0, 7.0]


# --- extract_polar ----------------------------------------------------------


def _polar_schema():
    return json.loads((contracts_dir() / "polar.schema.json").read_text())


def test_extract_polar_schema_valid_and_plausible(tmp_path, orc_index):
    path = extract_polar("Sun Fast 3200", out_dir=tmp_path)
    artifact = json.loads(path.read_text())
    Draft202012Validator(_polar_schema()).validate(artifact)

    assert artifact["source"]["kind"] == "orc_vpp"
    assert artifact["source"]["match_type"] == "model"

    tws = artifact["tws_kt"]
    twa = artifact["twa_deg"]
    assert tws == sorted(tws) and len(set(tws)) == len(tws)
    assert twa == sorted(twa) and len(set(twa)) == len(twa)
    assert len(artifact["speeds_kt"]) == len(tws)
    assert all(len(row) == len(twa) for row in artifact["speeds_kt"])

    # Plausible speed for a 32-ft boat: >4 kt at 12 kt TWS / 90 deg TWA
    speed = artifact["speeds_kt"][tws.index(12.0)][twa.index(90.0)]
    assert speed > 4.0


def test_extract_polar_generic_fallback(tmp_path):
    path = extract_polar("Blorptron Qzx 9999", out_dir=tmp_path)
    artifact = json.loads(path.read_text())
    Draft202012Validator(_polar_schema()).validate(artifact)
    assert artifact["source"]["kind"] == "generic"
    assert artifact["source"]["match_type"] == "generic"
    # generic table carried through: 4 TWS rows
    assert len(artifact["tws_kt"]) == 4
    assert get_default_polars() == DEFAULT_POLARS


def test_extract_polar_updates_index_without_duplicates(tmp_path):
    extract_polar("Sun Fast 3200", out_dir=tmp_path)
    extract_polar("Sigma 38", out_dir=tmp_path)
    # re-extract must not duplicate
    extract_polar("Sun Fast 3200", out_dir=tmp_path)

    index = json.loads((tmp_path / "index.json").read_text())
    ids = [entry["polar_id"] for entry in index["polars"]]
    assert len(ids) == len(set(ids))
    assert "sun-fast-3200" in ids
    assert "sigma-38" in ids
    for entry in index["polars"]:
        assert set(entry) == {"polar_id", "label", "source_kind"}
        assert entry["source_kind"] in {"orc_vpp", "generic"}


# --- search_orc -------------------------------------------------------------


def test_search_orc_returns_candidates(orc_index):
    results = search_orc("sun fast 3200", limit=8, orc_index=orc_index)
    assert 0 < len(results) <= 8
    assert all(set(item) == {"name", "type"} for item in results)
    assert any(normalize_model(item["type"]) == "SUNFAST3200" for item in results)
