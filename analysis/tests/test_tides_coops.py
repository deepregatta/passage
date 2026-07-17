"""NOAA CO-OPS predictions parsing, on the real 2026-07-17 Newport response."""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from deepweather_analysis.tides import _coops_events_from_json

COOPS = json.loads(
    (Path(__file__).parent / "fixtures" / "coops-newport-hilo-2026-07-17.json").read_text()
)


def test_parse_real_predictions():
    start = datetime(2026, 7, 17, tzinfo=timezone.utc)
    end = datetime(2026, 7, 21, tzinfo=timezone.utc)
    events = _coops_events_from_json(COOPS, start, end)
    assert events[0] == {"kind": "HW", "time": "2026-07-17T02:24:00Z", "height_m": 1.38}
    assert events[1] == {"kind": "LW", "time": "2026-07-17T08:29:00Z", "height_m": -0.03}
    # HW/LW strictly alternate and stay chronological
    kinds = [e["kind"] for e in events]
    assert all(a != b for a, b in zip(kinds, kinds[1:]))
    times = [e["time"] for e in events]
    assert times == sorted(times)
    # ~2 tides/day over 4 days
    assert 12 <= len(events) <= 18


def test_window_filter():
    start = datetime(2026, 7, 18, tzinfo=timezone.utc)
    end = datetime(2026, 7, 19, tzinfo=timezone.utc)
    events = _coops_events_from_json(COOPS, start, end)
    assert all(start.strftime("%Y-%m-%d") <= e["time"][:10] <= end.strftime("%Y-%m-%d") for e in events)
    assert 3 <= len(events) <= 5


def test_error_payload_raises():
    with pytest.raises(RuntimeError, match="no predictions"):
        _coops_events_from_json(
            {"error": {"message": "No Predictions data was found."}},
            datetime(2026, 7, 17, tzinfo=timezone.utc),
            datetime(2026, 7, 18, tzinfo=timezone.utc),
        )
