"""ERA5 request-date partitioning and merged cache, without CDS/network access."""

import itertools
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import xarray as xr

from deepweather_analysis.verification import era5


@pytest.mark.parametrize(
    "start,end",
    [
        ("2023-01-30", "2023-02-02"),
        ("2023-12-31", "2024-01-02"),
        ("2024-02-28", "2024-03-01"),
        ("2023-11-01", "2023-11-02"),
    ],
)
@pytest.mark.parametrize("time_name", ["time", "valid_time"])
def test_request_dates_exact_and_parts_merged(tmp_path, monkeypatch, start, end, time_name):
    calls = []

    def retrieve(dataset, request, output):
        assert dataset == "reanalysis-era5-single-levels"
        calls.append(request)
        dates = [
            f"{y}-{m}-{d}"
            for y, m, d in itertools.product(request["year"], request["month"], request["day"])
        ]
        times = np.array(
            [f"{day}T{hour}" for day in dates for hour in request["time"]], dtype="datetime64[ns]"
        )
        xr.Dataset(
            {"u10": ((time_name,), np.arange(len(times), dtype=float))}, coords={time_name: times}
        ).to_netcdf(output)

    monkeypatch.setitem(
        sys.modules,
        "cdsapi",
        SimpleNamespace(Client=lambda **kw: SimpleNamespace(retrieve=retrieve)),
    )
    output = tmp_path / "weather.nc"
    first = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    last = datetime.fromisoformat(end).replace(tzinfo=timezone.utc)
    result = era5.fetch_era5_weather(
        dict(min_lat=49, max_lat=50, min_lon=-5, max_lon=-4), first, last, output
    )
    assert result["status"] == "ok"
    actual = [
        f"{y}-{m}-{d}"
        for req in calls
        for y, m, d in itertools.product(req["year"], req["month"], req["day"])
    ]
    expected = [
        (first + timedelta(days=i)).strftime("%Y-%m-%d") for i in range((last - first).days + 1)
    ]
    assert actual == expected
    assert all(len(req["year"]) == len(req["month"]) == 1 for req in calls)
    with xr.open_dataset(output) as ds:
        times = ds[time_name].values
        assert len(times) == len(expected) * 8
        assert (np.diff(times) > np.timedelta64(0, "s")).all()
    assert result["checksum"] == era5.compute_file_checksum(output)
    assert list(tmp_path.iterdir()) == [output]


def test_later_month_failure_leaves_no_partial_cache(tmp_path, monkeypatch):
    calls = []

    def retrieve(dataset, request, output):
        calls.append(request)
        Path(output).write_bytes(b"partial download")
        if len(calls) == 2:
            raise OSError("second month failed")

    monkeypatch.setitem(
        sys.modules,
        "cdsapi",
        SimpleNamespace(Client=lambda **kw: SimpleNamespace(retrieve=retrieve)),
    )
    output = tmp_path / "weather.nc"
    result = era5.fetch_era5_weather(
        dict(min_lat=49, max_lat=50, min_lon=-5, max_lon=-4),
        datetime(2023, 1, 31),
        datetime(2023, 2, 1),
        output,
    )
    assert result["status"] == "failed"
    assert len(calls) == 2
    assert not output.exists()
    assert list(tmp_path.iterdir()) == []
