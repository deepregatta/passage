"""Live tide tolerance keeps complete source series and honest provider attribution."""

import json
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
import xarray as xr

from deepweather_analysis import tides
from deepweather_analysis.providers import Mode

START = datetime(2026, 7, 17, tzinfo=timezone.utc)
END = START + timedelta(hours=6)
PORT = {"name": "Test", "lat": 50.0, "lon": 0.0, "z0": 2.0}


def ssh_dataset(monkeypatch, tmp_path, values):
    ds = xr.Dataset(
        {"zos": (("time", "latitude", "longitude"), np.array(values)[:, None, :])},
        coords={
            "time": np.array(
                ["2026-07-17T00:00", "2026-07-17T01:00", "2026-07-17T02:00"], dtype="datetime64[ns]"
            ),
            "latitude": [50.0],
            "longitude": [0.0, 0.1],
        },
    )
    monkeypatch.setattr(tides, "data_root", lambda: tmp_path)
    monkeypatch.setitem(sys.modules, "copernicusmarine", SimpleNamespace(subset=Mock()))
    monkeypatch.setattr(xr, "open_dataset", lambda _: ds)


@pytest.mark.parametrize("missing", [float("nan"), float("inf")])
def test_ssh_chooses_nearest_complete_cell(monkeypatch, tmp_path, missing, caplog):
    ssh_dataset(monkeypatch, tmp_path, [[0, 0], [missing, 1], [0, 0]])
    events = tides._fetch_port_ssh_events("test", PORT, START, END, "fixture")
    assert events == [{"kind": "HW", "time": "2026-07-17T01:00:00Z", "height_m": 3.0}]
    assert "test" in caplog.text and "incomplete" in caplog.text


def test_ssh_without_complete_cell_still_fails(monkeypatch, tmp_path):
    ssh_dataset(monkeypatch, tmp_path, [[0, 0], [np.nan, 1], [0, np.nan]])
    with pytest.raises(RuntimeError, match="complete"):
        tides._fetch_port_ssh_events("test", PORT, START, END, "fixture")


@pytest.mark.parametrize("kind", ["cmems_ssh", "noaa_coops", "qld_msq"])
def test_degradation_names_actual_provider(monkeypatch, tmp_path, kind, caplog):
    monkeypatch.setattr(tides, "processed_dir", lambda _: tmp_path)
    monkeypatch.setattr(tides, "provider_mode", lambda _: Mode.LIVE)
    monkeypatch.setattr(tides, "tides_live_source", lambda _: {"kind": kind})
    monkeypatch.setattr(tides, "_live_doc", Mock(side_effect=RuntimeError("offline")))
    doc = json.loads(tides.prepare_tides("2026-07-17T00:00:00Z", hours=24).read_text())
    assert doc["source"]["mode"] == "synthetic"
    assert kind in doc["source"]["note"]
    assert kind in caplog.text and "offline" in caplog.text
    if kind != "cmems_ssh":
        assert "CMEMS" not in doc["source"]["note"]


def test_coops_requests_inclusive_end_day_and_filters_exact_utc_window(monkeypatch):
    payload = {
        "predictions": [
            {"t": "2026-07-17 00:00", "type": "H", "v": "1"},
            {"t": "2026-07-17 06:00", "type": "L", "v": "0"},
            {"t": "2026-07-17 12:00", "type": "H", "v": "1"},
        ]
    }
    get = Mock(return_value=Mock(json=lambda: payload))
    monkeypatch.setattr("requests.get", get)
    events = tides._fetch_port_coops_events({"coops_station": "8452660"}, START, END)
    assert [e["time"] for e in events] == ["2026-07-17T00:00:00Z", "2026-07-17T06:00:00Z"]
    assert get.call_args.kwargs["params"]["end_date"] == "20260717"


def test_source_configuration_error_keeps_explicit_synthetic_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(tides, "processed_dir", lambda _: tmp_path)
    monkeypatch.setattr(tides, "provider_mode", lambda _: Mode.LIVE)
    monkeypatch.setattr(tides, "tides_live_source", Mock(side_effect=ValueError("invalid source")))
    doc = json.loads(tides.prepare_tides("2026-07-17T00:00:00Z", hours=24).read_text())
    assert doc["source"]["mode"] == "synthetic"
    assert "invalid source" in doc["source"]["note"]
