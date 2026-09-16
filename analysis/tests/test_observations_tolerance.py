"""Malformed source values must not replace usable observations with synthetic data."""

import json
from unittest.mock import Mock

import numpy as np
import pytest
import requests
import xarray as xr

from deepweather_analysis import observations as obs
from deepweather_analysis.providers import Mode

START = "2026-07-17T00:00:00Z"
END = "2026-07-17T02:00:00Z"


def test_ndbc_partial_values_remain_live(monkeypatch, caplog):
    raw = "\n".join(
        [
            "2026 07 17 02 00 240 5.0 7.0 1.2 MM MM MM 1012",
            "2026 07 17 01 00 230 broken NaN 1.1 MM MM MM inf",
            "2026 99 17 00 00 230 4.0 6.0 1.0 MM MM MM 1010",
            "2026 07 17 00 00 220 4.0 6.0 1.0 MM MM MM 1010",
        ]
    )
    monkeypatch.setattr(obs, "provider_mode", lambda _: Mode.LIVE)
    monkeypatch.setattr("requests.get", Mock(return_value=Mock(text=raw)))
    doc = obs.fetch_observations(START, END)
    assert doc["source"]["mode"] == "live"
    records = doc["stations"][0]["records"]
    assert [r["time"] for r in records] == [START, "2026-07-17T01:00:00Z", END]
    assert records[1] == {
        "time": "2026-07-17T01:00:00Z",
        "wind_kt": None,
        "gust_kt": None,
        "wind_dir_deg": 230,
        "pressure_hpa": None,
        "hs_m": 1.1,
    }
    assert records[0]["wind_kt"] == 7.8
    assert records[2]["wind_kt"] == 9.7
    json.dumps(doc, allow_nan=False)
    assert "broken" in caplog.text and "NDBC" in caplog.text


def test_partial_station_failure_and_total_degradation_are_logged(monkeypatch, caplog):
    raw = "2026 07 17 00 00 220 4.0 6.0 1.0 MM MM MM 1010"
    monkeypatch.setattr(obs, "provider_mode", lambda _: Mode.LIVE)
    get = Mock(side_effect=[requests.ConnectionError("offline"), Mock(text=raw)])
    monkeypatch.setattr("requests.get", get)
    doc = obs.fetch_observations(START, END)
    assert doc["source"]["mode"] == "live"
    assert len(doc["stations"]) == 1
    assert "62103" in caplog.text and "offline" in caplog.text
    caplog.clear()
    get.side_effect = requests.ConnectionError("total outage")
    doc = obs.fetch_observations(START, END)
    assert doc["source"]["mode"] == "synthetic"
    assert "degrading to synthetic" in caplog.text and "total outage" in caplog.text


@pytest.mark.parametrize("layout", ["one_dimensional", "depth_first", "time_first"])
def test_insitu_named_dimensions_and_qc(tmp_path, layout):
    dims, values = {
        "one_dimensional": (("TIME",), [2.0, 4.0, 6.0]),
        "depth_first": (("DEPTH", "TIME"), [[2.0, 4.0, 6.0], [3.0, 5.0, 7.0]]),
        "time_first": (("TIME", "DEPTH"), [[2.0, 3.0], [4.0, 5.0], [6.0, 7.0]]),
    }[layout]
    ds = xr.Dataset(
        {
            "WSPD": (dims, values),
            # A QC flag per time must broadcast over depths, not over time.
            "WSPD_QC": (("TIME",), [1, 4, 2]),
            "VHM0": (("TIME",), [1.0, 1.1, 1.2]),
        },
        coords={
            "TIME": np.array([START[:-1], "2026-07-17T01:00:00", END[:-1]], dtype="datetime64[ns]")
        },
    )
    path = tmp_path / "station.nc"
    ds.to_netcdf(path)
    records = obs.records_from_insitu_nc(path)
    assert len(records) == 3
    assert records[0]["wind_kt"] == 3.9
    assert "wind_kt" not in records[1]
    assert records[2]["wind_kt"] == 11.7
    assert [r["hs_m"] for r in records] == [1.0, 1.1, 1.2]


def test_insitu_bad_variable_and_time_preserve_usable_data(tmp_path, caplog):
    ds = xr.Dataset(
        {
            "WSPD": (("TIME",), [2.0, 4.0, 6.0]),
            "WSPD_QC": (("OTHER",), [1, 1]),  # unrelated QC axes: cannot trust wind
            "GSPD": (("TIME",), ["3", "broken", "5"]),
            "VHM0": (("TIME",), [1.0, 1.1, 1.2]),
        },
        coords={"TIME": np.array([START[:-1], "NaT", END[:-1]], dtype="datetime64[ns]")},
    )
    path = tmp_path / "station.nc"
    ds.to_netcdf(path)
    records = obs.records_from_insitu_nc(path)
    assert [r["time"] for r in records] == [START, END]
    assert [r["hs_m"] for r in records] == [1.0, 1.2]
    assert all("wind_kt" not in r for r in records)
    assert "WSPD" in caplog.text and "TIME" in caplog.text
    json.dumps(records, allow_nan=False)


def test_insitu_partial_files_remain_live_and_log_failed_file(monkeypatch, tmp_path, caplog):
    ds = xr.Dataset(
        {"WSPD": (("TIME",), [2.0, 4.0]), "VHM0": (("TIME",), [1.0, 1.1])},
        coords={"TIME": np.array(["2026-07-17T01:00", "2026-07-17T02:00"], dtype="datetime64[ns]")},
    )
    source = tmp_path / "fixture.nc"
    ds.to_netcdf(source)
    stations = [
        {"station_id": name, "file_prefix": name, "name": name, "lat": 40, "lon": 2}
        for name in ("good", "bad")
    ]
    monkeypatch.setattr(obs, "provider_mode", lambda _: Mode.LIVE)
    monkeypatch.setattr(obs, "data_root", lambda: tmp_path)
    monkeypatch.setattr(obs, "live_stations", lambda _: stations)
    monkeypatch.setattr(
        obs,
        "observations_live_source",
        lambda _: {"kind": "cmems_insitu_nrt", "base_url": "https://example.invalid"},
    )
    monkeypatch.setattr(
        "requests.get",
        Mock(side_effect=[Mock(content=source.read_bytes()), Mock(content=b"broken file")]),
    )
    doc = obs.fetch_observations("2026-07-17T00:40:00Z", END)
    assert doc["source"]["mode"] == "live"
    assert len(doc["stations"][0]["records"]) == 2
    assert doc["stations"][1]["records"] == []
    assert "bad" in caplog.text and "unparseable" in caplog.text
    assert not (tmp_path / "cache/observations/insitu/bad_20260717.nc").exists()
    obs.validate_observations(doc)
