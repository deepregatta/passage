"""Daily cache retention through the real fetch/parser, with synthetic NetCDFs."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest
import requests
import xarray as xr

from deepweather_analysis import observations as obs

TODAY = datetime(2026, 7, 17, 12, tzinfo=timezone.utc).date()
PREFIX = "IR_TS_MO_6100430"


@pytest.fixture
def cache(monkeypatch, tmp_path):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 17, 12, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(obs, "datetime", Clock)
    monkeypatch.setattr(obs, "data_root", lambda: tmp_path)
    monkeypatch.setattr(
        obs,
        "live_stations",
        lambda _: [
            {"station_id": "6100430", "file_prefix": PREFIX, "name": "Buoy", "lat": 40, "lon": 2}
        ],
    )
    monkeypatch.setattr(
        obs, "observations_live_source", lambda _: {"base_url": "https://example.invalid"}
    )
    get = Mock(side_effect=requests.ConnectionError("offline"))
    monkeypatch.setattr(requests, "get", get)
    directory = tmp_path / "cache/observations/insitu"
    directory.mkdir(parents=True)
    return directory, get


def seed(directory, day, *, prefix=PREFIX, wind=2.0, hour="12:00"):
    path = directory / f"{prefix}_{day:%Y%m%d}.nc"
    xr.Dataset(
        {"WSPD": (("TIME",), [wind])},
        coords={"TIME": np.array([f"{day}T{hour}"], dtype="datetime64[ns]")},
    ).to_netcdf(path)
    return path


def fetch(day, end_day=None):
    return obs.fetch_live_insitu(f"{day}T00:40:00Z", f"{end_day or day}T23:19:00Z")


def test_prunes_by_file_date_across_stations_and_keeps_exact_31_day_boundary(cache):
    directory, get = cache
    recent = []
    old = []
    for prefix in (PREFIX, "IR_TS_MO_OTHER"):
        for age in range(1, 95):
            path = seed(directory, TODAY - timedelta(days=age), prefix=prefix)
            (recent if age <= 30 else old).append(path)
    doc = fetch(TODAY - timedelta(days=1))
    assert doc["source"]["mode"] == "live"
    assert len(doc["stations"][0]["records"]) == 1
    get.assert_not_called()
    assert all(p.exists() for p in recent)
    assert not any(p.exists() for p in old)  # freshly written mtime must not matter


def test_historical_window_and_slack_survive_then_are_pruned_on_next_request(cache):
    directory, get = cache
    day = TODAY - timedelta(days=100)
    active = [seed(directory, day + timedelta(days=i)) for i in range(-1, 42)]
    seed(directory, day - timedelta(days=1), hour="23:30")
    seed(directory, day + timedelta(days=41), hour="00:30")
    old = seed(directory, day - timedelta(days=2))
    doc = obs.fetch_live_insitu(f"{day}T00:00:00Z", f"{day + timedelta(days=40)}T23:59:00Z")
    assert len(doc["stations"][0]["records"]) == 43
    assert all(p.exists() for p in active)
    assert not old.exists()
    get.assert_not_called()
    seed(directory, TODAY - timedelta(days=1))
    fetch(TODAY - timedelta(days=1))
    assert not any(p.exists() for p in active)


def test_old_requested_download_survives_and_today_is_refetched_every_time(cache, tmp_path):
    directory, get = cache
    day = TODAY - timedelta(days=100)
    get.side_effect = None
    get.return_value = Mock(content=seed(tmp_path, day).read_bytes())
    assert len(fetch(day)["stations"][0]["records"]) == 1
    assert (directory / f"{PREFIX}_{day:%Y%m%d}.nc").exists()
    fetch(day)
    assert get.call_count == 1  # cached historical file is reused

    seed(directory, TODAY, wind=1.0)
    for wind in (5.0, 8.0):
        get.return_value = Mock(content=seed(tmp_path, TODAY, wind=wind).read_bytes())
        doc = fetch(TODAY)
        assert doc["stations"][0]["records"][0]["wind_kt"] == round(wind * obs.KT_PER_MS, 1)
    assert get.call_count == 3
    assert get.call_args.args[0] == f"https://example.invalid/20260717/{PREFIX}_20260717.nc"
    assert get.call_args.kwargs == {"timeout": 60}
    assert not (directory / f"{PREFIX}_{day:%Y%m%d}.nc").exists()


def test_failed_today_refresh_does_not_use_cached_stale_observations(cache):
    directory, get = cache
    seed(directory, TODAY)
    old = seed(directory, TODAY - timedelta(days=100))
    with pytest.raises(RuntimeError, match="no In Situ TAC file retrievable"):
        fetch(TODAY)
    get.assert_called_once()
    assert not old.exists()


def test_future_window_stays_empty_and_still_prunes(cache):
    directory, get = cache
    old = seed(directory, TODAY - timedelta(days=100))
    doc = fetch(TODAY + timedelta(days=2))
    assert doc["source"]["mode"] == "live"
    assert doc["stations"][0]["records"] == []
    get.assert_not_called()
    assert not old.exists()


def test_cleanup_leaves_unknown_names_directories_and_symlinks(cache, tmp_path):
    directory, _ = cache
    preserved = []
    for name in (
        "notes.nc",
        "buoy_20260230.nc",
        "buoy_2026111.nc",
        "buoy_2026W011.nc",
        "buoy_20200101.nc.tmp",
    ):
        path = directory / name
        path.write_bytes(b"unrelated")
        preserved.append(path)
    folder = directory / "folder_20200101.nc"
    folder.mkdir()
    target = tmp_path / "outside.nc"
    target.write_bytes(b"outside")
    link = directory / "linked_20200101.nc"
    link.symlink_to(target)
    seed(directory, TODAY - timedelta(days=1))
    old = seed(directory, TODAY - timedelta(days=100))
    fetch(TODAY - timedelta(days=1))
    assert all(p.read_bytes() == b"unrelated" for p in preserved)
    assert folder.is_dir() and link.is_symlink() and target.read_bytes() == b"outside"
    assert not old.exists()


def test_cleanup_failure_is_logged_without_losing_live_records(cache, monkeypatch, caplog):
    directory, _ = cache
    old = seed(directory, TODAY - timedelta(days=100))
    other = seed(directory, TODAY - timedelta(days=101))
    seed(directory, TODAY - timedelta(days=1))
    unlink = Path.unlink

    def denied(path, *args, **kwargs):
        if path == old:
            raise PermissionError("read only cache entry")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    assert len(fetch(TODAY - timedelta(days=1))["stations"][0]["records"]) == 1
    assert old.exists() and not other.exists()
    assert old.name in caplog.text and "read only cache entry" in caplog.text


def test_cleanup_scan_failure_does_not_prevent_reading_cached_observations(
    cache, monkeypatch, caplog
):
    directory, get = cache
    seed(directory, TODAY - timedelta(days=1))
    iterdir = Path.iterdir

    def denied(path):
        if path == directory:
            raise PermissionError("cannot list cache")
        return iterdir(path)

    monkeypatch.setattr(Path, "iterdir", denied)
    assert len(fetch(TODAY - timedelta(days=1))["stations"][0]["records"]) == 1
    get.assert_not_called()
    assert "In Situ cache scan failed" in caplog.text and "cannot list cache" in caplog.text


def test_utc_window_crosses_year_without_losing_matching_slack(cache):
    directory, get = cache
    for day, hour in (("2025-12-31", "23:30"), ("2026-01-01", "00:30")):
        seed(directory, datetime.fromisoformat(day).date(), hour=hour)
    old = seed(directory, datetime(2025, 12, 30).date())
    doc = obs.fetch_live_insitu("2026-01-01T02:00:00+02:00", "2026-01-01T02:00:00+02:00")
    assert [r["time"] for r in doc["stations"][0]["records"]] == [
        "2025-12-31T23:30:00Z",
        "2026-01-01T00:30:00Z",
    ]
    get.assert_not_called()
    assert not old.exists()
