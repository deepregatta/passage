"""Characterize shared factory behavior at its existing caller boundaries, offline."""

import builtins
import hashlib
import importlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest
import xarray as xr

from deepweather_analysis import (
    ecmwf_open_data,
    environment_fetcher,
    environment_grid,
    grids_prep,
    observations,
    polars,
    synoptic_prep,
    tides,
    warnings_au,
    warnings_mf,
    warnings_us,
)
from deepweather_analysis.synoptic import regimes, track
from deepweather_analysis.verification import corpus, era5, match
from deepweather_analysis.http import USER_AGENT
from deepweather_analysis.units import mslp_hpa


@pytest.mark.parametrize("size", [0, 8193, (1 << 20) + 17])
def test_checksum_bytes_and_missing_file(tmp_path, size):
    path = tmp_path / "fields.nc"
    payload = (bytes(range(256)) * ((size + 255) // 256))[:size]
    path.write_bytes(payload)
    expected = "sha256:" + hashlib.sha256(payload).hexdigest()
    for module in (ecmwf_open_data, environment_fetcher, era5):
        assert module.compute_file_checksum(path) == expected
        with pytest.raises(FileNotFoundError):
            module.compute_file_checksum(tmp_path / "missing.nc")


@pytest.mark.parametrize("module", [environment_fetcher, environment_grid, era5])
@pytest.mark.parametrize("failures", [0, 1, 2])
def test_netcdf_engine_order_and_last_error(monkeypatch, tmp_path, module, failures):
    errors = [ValueError("netcdf4 unavailable"), OSError("bad h5netcdf file")]
    dataset = object()
    opener = Mock(side_effect=[*errors[:failures], dataset])
    monkeypatch.setattr(xr, "open_dataset", opener)
    path = tmp_path / "fields.nc"
    if failures == 2:
        with pytest.raises(OSError) as caught:
            module._open_nc_robust(path)
        assert caught.value is errors[-1]
    else:
        assert module._open_nc_robust(path) is dataset
    assert [call.kwargs["engine"] for call in opener.call_args_list] == ["netcdf4", "h5netcdf"][
        : min(failures + 1, 2)
    ]
    assert all(call.args == (path,) for call in opener.call_args_list)


def test_optional_xarray_import(monkeypatch):
    assert environment_fetcher._check_xarray()
    assert environment_grid._check_xarray()
    original_import = builtins.__import__

    def without_xarray(name, *args, **kwargs):
        if name == "xarray":
            raise ImportError("not installed")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_xarray)
    assert not environment_fetcher._check_xarray()
    assert not environment_grid._check_xarray()


@pytest.mark.parametrize("offset", [-7, 0, 2])
def test_utc_formatter_rollover_and_fractional_seconds(offset):
    dt = datetime(2026, 1, 1, 0, 30, 15, 987654, tzinfo=timezone(timedelta(hours=offset)))
    expected = {-7: "2026-01-01T07:30:15Z", 0: "2026-01-01T00:30:15Z", 2: "2025-12-31T22:30:15Z"}[
        offset
    ]
    for module in (ecmwf_open_data, grids_prep, observations, synoptic_prep, match):
        assert module._iso_z(dt) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        ("  Gale / Storm Warning! ", "gale-storm-warning"),
        ("Élan 31.7", "lan-31-7"),
        ("A__B--C", "a-b-c"),
        ("💨 / É", ""),
        ("", ""),
    ],
)
def test_slug_identifiers_and_polar_fallback(text, expected):
    assert warnings_us._event_slug(text) == expected
    assert warnings_au._slug(text) == expected
    assert polars._slugify(text) == (expected or "polar")


def test_wind_conversion_precision_and_geo_conventions():
    assert [
        synoptic_prep.MS_TO_KNOTS,
        grids_prep.MS_TO_KNOTS,
        regimes.MS_TO_KNOTS,
        observations.KT_PER_MS,
    ] == [1.9438445] * 4
    assert match.haversine_km(0, 0, 0, 1) == 111.19492664455873
    assert match.haversine_km(50, -3, 50, -3) == 0
    # The track/corpus gate is a local degree approximation, with raw longitude
    # differences. Preserve it even at the date line; it is not haversine.
    for points, expected in [((0, 0, 0, 1), 1.0), ((0, 179, 0, -179), 358.0)]:
        lat1, lon1, lat2, lon2 = points
        assert corpus._sep_deg(*points) == expected
        assert track._sep_deg({"lat": lat1, "lon": lon1}, {"lat": lat2, "lon": lon2}) == expected


@pytest.mark.parametrize(
    "values, expected",
    [
        ([10000, 10000], [10000, 10000]),
        ([10001, 10001], [100.01, 100.01]),
        ([101000, float("nan")], [1010, float("nan")]),
        ([1010, 990], [1010, 990]),
    ],
)
def test_pressure_tolerance_threshold_and_input_isolation(values, expected):
    source = np.array(values)
    saved = source.copy()
    result = synoptic_prep._mslp_hpa(source)
    np.testing.assert_array_equal(result, expected)
    np.testing.assert_array_equal(source, saved)
    assert result.dtype == np.float64


FEEDS = [
    ("uk", "fetch_uk_gale_bulletins", "UK", "Met Office shipping forecast"),
    ("us", "fetch_us_bulletins", "US", "NWS active alerts"),
    ("meteoalarm", "fetch_meteoalarm_bulletins", "Meteoalarm", "Meteoalarm CAP"),
    ("au", "fetch_au_bulletins", "AU", "BOM marine wind warnings"),
]


@pytest.mark.parametrize("failed_feed", [None, "uk", "us", "meteoalarm", "au"])
def test_warning_merges_order_failure_continuation_and_uk_note(monkeypatch, failed_feed):
    placeholder = "UK shipping-forecast zones modeled but not fetched."
    doc = {
        "bulletins": [{"id": "fr"}],
        "source": {"name": "FR", "mode": "live"},
        "coverage_note": "Base. " + placeholder,
        "feed_status": "ok",
    }
    zones = {kind + "_zones": [{"zone_id": kind}] for kind, *_ in FEEDS}
    monkeypatch.setattr(warnings_mf, "_route_zones", zones.__getitem__)
    expected_names, expected_notes = ["FR"], ["Base."]
    if failed_feed == "uk":
        expected_notes.append(placeholder)
    for kind, fetch_name, label, source_name in FEEDS:
        fetch = Mock(return_value=([{"id": kind}], kind + " note."))
        if kind == failed_feed:
            fetch.side_effect = RuntimeError("offline")
            expected_notes.append(label + " feed unavailable: offline")
        else:
            expected_names.append(source_name)
            expected_notes.append(kind + " note.")
        module = importlib.import_module("deepweather_analysis.warnings_" + kind)
        monkeypatch.setattr(module, fetch_name, fetch)
        assert getattr(warnings_mf, "_merge_" + kind + "_warnings")(doc) is doc
        fetch.assert_called_once_with(zones[kind + "_zones"])
    assert doc == {
        "bulletins": [
            {"id": kind} for kind in ["fr", "uk", "us", "meteoalarm", "au"] if kind != failed_feed
        ],
        "source": {"name": " + ".join(expected_names), "mode": "live"},
        "coverage_note": " ".join(expected_notes),
        "feed_status": "parse-degraded" if failed_feed else "ok",
    }


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("scale", [1, 100])
def test_pressure_preserves_xarray_coordinates_dtype_and_input(dtype, scale):
    field = xr.DataArray(
        np.array([[1010, 990]], dtype=dtype) * scale,
        dims=("latitude", "longitude"),
        coords={"latitude": [50.0], "longitude": [-2.0, -1.0]},
        name="msl",
        attrs={"units": "Pa" if scale == 100 else "hPa"},
    )
    original = field.copy(deep=True)
    result = mslp_hpa(field)
    assert result.dtype == dtype
    assert result.dims == field.dims
    assert result.coords.equals(field.coords)
    assert result.name == "msl"
    np.testing.assert_array_equal(result.values, [[1010, 990]])
    xr.testing.assert_identical(field, original)
    if scale == 1:
        assert result is field


def test_identifying_user_agent_reaches_all_three_provider_paths(monkeypatch):
    import requests

    fixtures = Path(__file__).parent / "fixtures"
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        response = Mock()
        if url == warnings_us.NWS_ALERTS_URL:
            response.json.return_value = {"features": []}
        elif url.endswith("datastore_search"):
            response.json.return_value = json.loads(
                (fixtures / "qld-waves-mooloolaba-2026-07-17.json").read_text()
            )
        elif url.endswith("package_show"):
            response.json.return_value = {
                "result": {
                    "resources": [{"format": "CSV", "name": "2026 predictions", "id": "year-2026"}]
                }
            }
        elif url.endswith("datastore/dump/year-2026"):
            response.text = (fixtures / "qld-msq-brisbane-bar-hilo-2026.csv").read_text()
        else:
            raise AssertionError(url)
        return response

    monkeypatch.setattr(requests, "get", get)
    warnings_us.fetch_us_bulletins([{"nws_zone": "ANZ237", "zone_id": "block-island"}])
    observations.fetch_live_qld_waves(
        "2026-07-17T00:00:00Z", "2026-07-18T00:00:00Z", route_id="brisbane-gladstone-v1"
    )
    tides._fetch_port_qld_events(
        {"qld_package": "brisbane-bar"},
        datetime(2026, 1, 1, tzinfo=timezone.utc),
        datetime(2026, 1, 2, tzinfo=timezone.utc),
        {},
    )
    assert len(calls) == 8  # NWS, five QLD buoys, tide metadata and CSV.
    assert USER_AGENT == "passage-deepregatta (+https://passage.deepregatta.com)"
    assert all(kwargs["headers"]["User-Agent"] == USER_AGENT for _, kwargs in calls)
    assert calls[0][1]["headers"]["Accept"] == "application/geo+json"
