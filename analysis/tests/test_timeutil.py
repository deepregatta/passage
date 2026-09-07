"""ISO inputs mean UTC even on hosts observing daylight saving time."""

import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from deepweather_analysis import scenarios, tides, warnings_meteoalarm, warnings_us
from deepweather_analysis.providers import Mode


@pytest.fixture(autouse=True)
def paris_timezone(monkeypatch):
    with monkeypatch.context() as context:
        context.setenv("TZ", "Europe/Paris")
        time.tzset()
        yield
    time.tzset()


@pytest.mark.parametrize("month", [1, 7])
@pytest.mark.parametrize("module", [warnings_us, warnings_meteoalarm])
def test_warning_naive_time_is_utc(module, month):
    value = f"2026-{month:02d}-15T10:00:00"
    assert module._iso_utc(value) == value + "Z"
    assert module._iso_utc(None) is None
    assert module._iso_utc("") is None


def test_scenario_naive_departure_is_utc(tmp_path, monkeypatch):
    monkeypatch.setattr(scenarios, "data_root", lambda: tmp_path)
    output = scenarios.generate_scenario("calm", "2026-07-20T06:00:00")
    forecast = json.loads((output / "forecast.json").read_text())
    assert forecast[0]["hourly"]["time"][0] == "2026-07-20T00:00"


def test_tides_naive_start_is_utc(tmp_path, monkeypatch):
    starts = []
    original = tides._synthetic_doc

    def capture(start, end, ports):
        starts.append(start)
        return original(start, end, ports)

    monkeypatch.setattr(tides, "_synthetic_doc", capture)
    monkeypatch.setattr(tides, "provider_mode", lambda _: Mode.SYNTHETIC)
    monkeypatch.setattr(tides, "processed_dir", lambda _: tmp_path)
    tides.prepare_tides("2026-07-20T06:00:00", hours=24)
    assert starts == [datetime(2026, 7, 20, 6, tzinfo=timezone.utc)]


def test_cache_naive_timestamps_match_utc_request():
    from deepweather_analysis.environment_fetcher import _extent_changed
    from deepweather_analysis.verification.era5 import _extent_matches

    bounds = {"min_lat": 49, "max_lat": 50, "min_lon": -2, "max_lon": -1}
    metadata = {
        "bounds": bounds,
        "time_range": {"start": "2026-07-20T06:00:00", "end": "2026-07-21T06:00:00"},
    }
    start = datetime(2026, 7, 20, 6, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    assert not _extent_changed(SimpleNamespace(**metadata), bounds, start, end)
    assert _extent_matches(metadata, bounds, start, end)


@pytest.mark.parametrize(
    "value, expected",
    [
        ("2026-07-20T10:00:00", datetime(2026, 7, 20, 10, tzinfo=timezone.utc)),
        ("2026-01-20T10:00:00", datetime(2026, 1, 20, 10, tzinfo=timezone.utc)),
        ("2026-07-20", datetime(2026, 7, 20, tzinfo=timezone.utc)),
        ("2026-07-20T10:00:00Z", datetime(2026, 7, 20, 10, tzinfo=timezone.utc)),
        ("2026-07-20T10:00:00+02:00", datetime(2026, 7, 20, 8, tzinfo=timezone.utc)),
        ("2026-07-20T23:00:00-04:00", datetime(2026, 7, 21, 3, tzinfo=timezone.utc)),
        ("2026-07-20T10:00:00.123456", datetime(2026, 7, 20, 10, 0, 0, 123456, timezone.utc)),
        (datetime(2026, 7, 20, 10), datetime(2026, 7, 20, 10, tzinfo=timezone.utc)),
        (
            datetime(2026, 7, 20, 10, tzinfo=timezone(timedelta(hours=2))),
            datetime(2026, 7, 20, 8, tzinfo=timezone.utc),
        ),
    ],
)
def test_parse_iso_utc(value, expected):
    from deepweather_analysis.timeutil import parse_iso_utc

    assert parse_iso_utc(value) == expected
    assert parse_iso_utc(value).tzinfo is timezone.utc


@pytest.mark.parametrize("value", ["", "not a time", "2026-02-30T10:00:00"])
def test_invalid_iso_is_rejected(value):
    from deepweather_analysis.timeutil import parse_iso_utc

    with pytest.raises(ValueError):
        parse_iso_utc(value)
