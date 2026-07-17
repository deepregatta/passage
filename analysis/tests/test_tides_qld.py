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
