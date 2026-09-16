"""MSQ predicted high/low CSV parsing, on the real Brisbane Bar 2026 dataset
(first days of January; times are AEST and must shift 10 h back to UTC)."""

from datetime import datetime, timezone
from pathlib import Path

from deepweather_analysis.tides import _qld_events_from_csv

CSV = (Path(__file__).parent / "fixtures" / "qld-msq-brisbane-bar-hilo-2026.csv").read_text()


def test_parse_real_predictions_converts_aest_to_utc():
    start = datetime(2025, 12, 31, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 1, 2, 0, 0, tzinfo=timezone.utc)
    events = _qld_events_from_csv(CSV, start, end, 10)
    # 01/01/2026 01:00 AEST LW 0.400 -> 2025-12-31T15:00Z
    assert events[0] == {"kind": "LW", "time": "2025-12-31T15:00:00Z", "height_m": 0.4}
    # 01/01/2026 07:41 AEST HW 2.500 -> 2025-12-31T21:41Z
    assert events[1] == {"kind": "HW", "time": "2025-12-31T21:41:00Z", "height_m": 2.5}
    # HW/LW strictly alternate and stay chronological
    kinds = [e["kind"] for e in events]
    assert all(a != b for a, b in zip(kinds, kinds[1:]))
    times = [e["time"] for e in events]
    assert times == sorted(times)
    assert 5 <= len(events) <= 7


def test_window_filter_is_inclusive_and_utc():
    start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    events = _qld_events_from_csv(CSV, start, end, 10)
    assert all(e["time"].startswith("2026-01-01") for e in events)
    assert all(e["time"] <= "2026-01-01T12:00:00Z" for e in events)
    assert len(events) >= 2


def test_offset_zero_keeps_local_times():
    start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc)
    events = _qld_events_from_csv(CSV, start, end, 0)
    assert events[0]["time"] == "2026-01-01T01:00:00Z"


def _mock_qld(monkeypatch, tmp_path):
    from unittest.mock import Mock

    from deepweather_analysis import tides

    monkeypatch.setattr(tides, "data_root", lambda: tmp_path)
    package = {
        "result": {"resources": [{"format": "CSV", "name": "2026 predictions", "id": "year-2026"}]}
    }
    dump = Mock(return_value=Mock(text=CSV))

    def get(url, **kwargs):
        if url.endswith("package_show"):
            return Mock(json=lambda: package)
        return dump(url, **kwargs)

    monkeypatch.setattr("requests.get", get)
    return tides, dump, package


def test_qld_year_dump_cached_across_calls_with_window_refilter(monkeypatch, tmp_path):
    tides, dump, _ = _mock_qld(monkeypatch, tmp_path)
    port = {"qld_package": "test-port"}
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    middle = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    end = datetime(2026, 1, 2, tzinfo=timezone.utc)
    first = tides._fetch_port_qld_events(port, start, middle, {})
    second = tides._fetch_port_qld_events(port, middle, end, {})
    assert first and second and first != second
    assert first == _qld_events_from_csv(CSV, start, middle, 10)
    assert second == _qld_events_from_csv(CSV, middle, end, 10)
    assert dump.call_count == 1
    assert list(tmp_path.rglob("*.json"))  # persistent, usable by later CLI calls
    tides._fetch_port_qld_events(port, start, middle, {"base_url": "https://another.invalid"})
    assert dump.call_count == 2  # cache must be source-specific


def test_qld_cache_corruption_expiry_and_resource_change_refetch(monkeypatch, tmp_path):
    import json

    tides, dump, package = _mock_qld(monkeypatch, tmp_path)
    port = {"qld_package": "test-port"}
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = datetime(2026, 1, 2, tzinfo=timezone.utc)
    expected = tides._fetch_port_qld_events(port, start, end, {})
    cache = next(tmp_path.rglob("*.json"))
    cache.write_text("broken")
    assert tides._fetch_port_qld_events(port, start, end, {}) == expected
    assert dump.call_count == 2
    entry = json.loads(cache.read_text())
    entry["fetched_at"] = 0
    cache.write_text(json.dumps(entry))
    assert tides._fetch_port_qld_events(port, start, end, {}) == expected
    assert dump.call_count == 3
    package["result"]["resources"][0]["id"] = "revision-2"
    assert tides._fetch_port_qld_events(port, start, end, {}) == expected
    assert dump.call_count == 4


def test_qld_expired_cache_does_not_hide_network_failure(monkeypatch, tmp_path):
    import json

    import pytest
    import requests

    tides, dump, _ = _mock_qld(monkeypatch, tmp_path)
    port = {"qld_package": "test-port"}
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = datetime(2026, 1, 2, tzinfo=timezone.utc)
    tides._fetch_port_qld_events(port, start, end, {})
    cache = next(tmp_path.rglob("*.json"))
    entry = json.loads(cache.read_text())
    entry["fetched_at"] = 0
    cache.write_text(json.dumps(entry))
    dump.side_effect = requests.ConnectionError("offline")
    with pytest.raises(requests.ConnectionError, match="offline"):
        tides._fetch_port_qld_events(port, start, end, {})


def test_qld_invalid_dump_is_not_cached_and_cache_write_failure_keeps_live(monkeypatch, tmp_path):
    import pytest

    tides, dump, _ = _mock_qld(monkeypatch, tmp_path)
    port = {"qld_package": "test-port"}
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = datetime(2026, 1, 2, tzinfo=timezone.utc)
    dump.return_value.text = "<html>not CSV</html>"
    with pytest.raises(ValueError, match="CSV"):
        tides._fetch_port_qld_events(port, start, end, {})
    assert not list(tmp_path.rglob("*.json"))
    dump.return_value.text = CSV
    monkeypatch.setattr("os.replace", lambda *args: (_ for _ in ()).throw(OSError("full")))
    assert tides._fetch_port_qld_events(port, start, end, {}) == _qld_events_from_csv(
        CSV, start, end, 10
    )
    assert not [p for p in tmp_path.rglob("*") if p.is_file()]


def test_qld_cache_validates_rows_outside_requested_window(monkeypatch, tmp_path):
    import pytest

    tides, dump, _ = _mock_qld(monkeypatch, tmp_path)
    dump.return_value.text = (
        "Date,Time,Ind,Reading\n01/01/2026,12:00,1,2.5\n02/01/2026,12:00,1,nan\n"
    )
    with pytest.raises(ValueError, match="CSV row"):
        tides._fetch_port_qld_events(
            {"qld_package": "test-port"},
            datetime(2026, 1, 1, tzinfo=timezone.utc),
            datetime(2026, 1, 1, 12, tzinfo=timezone.utc),
            {},
        )
    assert not list(tmp_path.rglob("*.json"))


def test_qld_new_year_fetches_local_years_and_reuses_each_cache(monkeypatch, tmp_path):
    from unittest.mock import Mock

    tides, dump, package = _mock_qld(monkeypatch, tmp_path)
    package["result"]["resources"].insert(
        0, {"format": "CSV", "name": "2025 predictions", "id": "year-2025"}
    )
    dump.side_effect = lambda url, **kwargs: Mock(
        text="Date,Time,Ind,Reading\n31/12/2025,23:00,1,2.0\n" if url.endswith("2025") else CSV
    )
    start = datetime(2025, 12, 31, 12, tzinfo=timezone.utc)
    end = datetime(2025, 12, 31, 22, tzinfo=timezone.utc)
    first = tides._fetch_port_qld_events({"qld_package": "test-port"}, start, end, {})
    assert len(first) == 3
    assert dump.call_count == 2
    assert tides._fetch_port_qld_events({"qld_package": "test-port"}, start, end, {}) == first
    assert dump.call_count == 2
