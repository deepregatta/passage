"""Fresh-process import checks and cache read/write boundary regressions."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from unittest.mock import patch

import pytest


def run_python(code, tmp_path):
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        env={**os.environ, "MPLCONFIGDIR": str(tmp_path / "mpl")},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("module", ["grids_prep", "observations", "tides"])
def test_feed_import_does_not_read_registry(module, tmp_path):
    run_python(
        f"""
        import importlib
        from unittest.mock import patch
        from deepweather_analysis import route_sources
        with patch.object(route_sources, 'load_route_sources',
                          side_effect=FileNotFoundError('registry unavailable')) as read:
            module = importlib.import_module('deepweather_analysis.{module}')
            read.assert_not_called()
        # Legacy aliases still resolve when explicitly requested.
        aliases = {{
            'grids_prep': {{'CHANNEL_BOUNDS': route_sources.currents_bounds}},
            'observations': {{'STATIONS': route_sources.synthetic_stations,
                             'LIVE_STATIONS': route_sources.live_stations,
                             'SOURCE_NAME': route_sources.synthetic_observations_source_name,
                             'LIVE_SOURCE_NAME': route_sources.live_observations_source_name}},
            'tides': {{'PORTS': route_sources.tide_ports}},
        }}
        for name, lookup in aliases['{module}'].items():
            assert getattr(module, name) == lookup()
        try:
            getattr(module, 'missing_attribute')
        except AttributeError:
            pass
        else:
            raise AssertionError('unknown attributes must raise AttributeError')
        """,
        tmp_path,
    )


@pytest.mark.parametrize("module", ["synoptic", "synoptic_prep", "cli"])
def test_import_does_not_load_matplotlib(module, tmp_path):
    run_python(
        f"""
        import importlib
        import sys
        importlib.import_module('deepweather_analysis.{module}')
        assert not any(n == 'matplotlib' or n.startswith('matplotlib.') for n in sys.modules)
        """,
        tmp_path,
    )
    assert not (tmp_path / "mpl").exists()


def test_render_preserves_host_backend_and_open_figures(tmp_path):
    run_python(
        f"""
        import matplotlib
        matplotlib.use('svg')
        import matplotlib.pyplot as plt
        import numpy as np
        import xarray as xr
        from unittest.mock import patch
        host = plt.figure()
        host_number = host.number
        with patch.object(matplotlib, 'use', side_effect=AssertionError('global backend switch')):
            from deepweather_analysis.synoptic import render_panels
            axis = np.linspace(40, 50, 11)
            pressure = 1000 + np.add.outer(axis - 40, axis - 40)
            ds = xr.Dataset({{'msl': (('step', 'latitude', 'longitude'), pressure[None])}},
                            coords={{'step': [0], 'latitude': axis, 'longitude': axis - 50}})
            panels = render_panels(ds, [], {str(tmp_path / "charts")!r}, steps=(0, 24))
        assert matplotlib.get_backend() == 'svg'
        assert plt.get_fignums() == [host_number]
        assert plt.figure(host_number) is host
        assert len(panels) == 1 and panels[0]['step_h'] == 0
        from pathlib import Path
        import struct
        png = Path(panels[0]['file']).read_bytes()
        assert png[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
        assert struct.unpack('>II', png[16:24]) == (1200, 900)
        plt.close(host)
        """,
        tmp_path,
    )


@pytest.mark.parametrize("reader", ["path", "ecmwf", "era5"])
def test_cache_miss_does_not_create_directories(reader, tmp_path, monkeypatch):
    from deepweather_analysis import ecmwf_open_data, paths
    from deepweather_analysis.verification import era5

    root = tmp_path / "absent-data"
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(root))
    with patch.object(Path, "mkdir", side_effect=AssertionError("write on read")):
        if reader == "path":
            assert paths.cache_dir("example") == root / "cache" / "example"
        elif reader == "ecmwf":
            assert ecmwf_open_data._load_cached("20260701T00Z") is None
        else:
            with pytest.raises(FileNotFoundError, match="No usable ERA5 cache"):
                era5.open_case_dataset("missing-case")
    assert not root.exists()


def test_cached_datasets_open_without_mkdir(tmp_path, monkeypatch):
    import xarray as xr
    from deepweather_analysis import ecmwf_open_data
    from deepweather_analysis.verification import era5

    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))
    dataset = xr.Dataset({"msl": ("time", [1010.0])}, coords={"time": [0]})
    ec_dir = tmp_path / "cache/ecmwf/20260701T00Z"
    ec_dir.mkdir(parents=True)
    dataset.to_netcdf(ec_dir / "fields.nc")
    (ec_dir / "metadata.json").write_text(json.dumps({"cycle": "20260701T00Z"}))
    era_dir = tmp_path / "cache/era5/case"
    era_dir.mkdir(parents=True)
    dataset.to_netcdf(era_dir / "weather.nc")
    (era_dir / "metadata.json").write_text(
        json.dumps({"status": "ok", "path": str(era_dir / "weather.nc")})
    )
    with patch.object(Path, "mkdir", side_effect=AssertionError("write on cache hit")):
        ec_ds, ec_meta = ecmwf_open_data._load_cached("20260701T00Z")
        era_ds, era_meta = era5.open_case_dataset("case")
        assert ec_meta["cycle"] == "20260701T00Z"
        assert era_meta["status"] == "ok"
        xr.testing.assert_equal(ec_ds, dataset)
        xr.testing.assert_equal(era_ds, dataset)
        ec_ds.close()
        era_ds.close()


def test_era5_failed_fetch_still_writes_metadata(tmp_path, monkeypatch):
    from datetime import datetime, timezone
    from deepweather_analysis.verification import era5

    root = tmp_path / "absent-data"
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(root))
    monkeypatch.setattr(era5, "fetch_era5_weather", lambda *a, **kw: None)
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    metadata = era5.fetch_era5_case("case", {}, start, start)
    assert metadata["status"] == "failed"
    assert json.loads((root / "cache/era5/case/metadata.json").read_text()) == metadata


@pytest.mark.parametrize("available", [False, True])
def test_history_creates_cache_only_after_success(tmp_path, monkeypatch, available):
    from deepweather_analysis import openmeteo_history as history

    root = tmp_path / "absent-data"
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(root))
    payload = {"hourly": {"wind_speed_10m": [12.0]}} if available else {"error": True}
    with patch.object(history, "_fetch_with_backoff", return_value=payload) as fetch:
        result = history.fetch_route_history([(50, -2)], "2026-07-01", "2026-07-02")
        fetch.assert_called_once()
    assert result["route_conditions_available"] is available
    assert root.exists() is available
    if available:
        assert len(list(root.rglob("*.json"))) == 1
        with (
            patch.object(Path, "mkdir", side_effect=AssertionError("write on cache hit")),
            patch.object(history, "_fetch_with_backoff", side_effect=AssertionError("network")),
        ):
            cached = history.fetch_route_history([(50, -2)], "2026-07-01", "2026-07-02")
        assert cached["points"][0]["cached"] is True
        assert cached["points"][0]["hourly"] == payload["hourly"]


def test_warnings_cli_summary(tmp_path, monkeypatch, capsys):
    from deepweather_analysis import cli, warnings_mf

    output = tmp_path / "warnings.json"
    output.write_text(json.dumps({"feed_status": "ok", "bulletins": [{}, {}]}))
    monkeypatch.setattr(warnings_mf, "fetch_warnings", lambda **kwargs: output)
    assert cli.cmd_fetch_warnings(argparse.Namespace(gale=None, paste=None)) == 0
    assert capsys.readouterr().out == f"wrote {output} — feed_status=ok, bulletins=2\n"


def test_tide_defaults_resolve_at_call_and_explicit_ports_skip_registry(monkeypatch):
    from deepweather_analysis import tides

    ports = {"test": {"z0": 2.0, "constituents": {}}}
    with patch.object(tides, "tide_ports", return_value=ports) as lookup:
        assert tides.height_m("test", tides.EPOCH) == 2.0
        lookup.assert_called_once()
    with patch.object(tides, "tide_ports", side_effect=AssertionError("registry read")):
        assert tides.height_m("test", tides.EPOCH, ports=ports) == 2.0
        assert tides.hw_lw_events("test", tides.EPOCH, tides.EPOCH, ports=ports) == []


def test_ecmwf_fetch_writes_fresh_cache(tmp_path, monkeypatch):
    from types import ModuleType
    import xarray as xr
    from deepweather_analysis import ecmwf_open_data as ecmwf

    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path / "absent-data"))
    dataset = xr.Dataset({"msl": ("step", [1010.0])}, coords={"step": [0]})
    monkeypatch.setattr(ecmwf, "_decode_grib", lambda *args: dataset)

    class Client:
        def __init__(self, **kwargs):
            pass

        def retrieve(self, request, target):
            Path(target).write_bytes(b"synthetic GRIB stand-in")

    package = ModuleType("ecmwf")
    opendata = ModuleType("ecmwf.opendata")
    opendata.Client = Client
    package.opendata = opendata
    monkeypatch.setitem(sys.modules, "ecmwf", package)
    monkeypatch.setitem(sys.modules, "ecmwf.opendata", opendata)
    written, metadata = ecmwf.fetch_fields("20260701T00Z")
    cached, cached_metadata = ecmwf._load_cached("20260701T00Z")
    xr.testing.assert_equal(cached, written)
    assert cached_metadata == metadata
    assert not list(tmp_path.rglob("*.grib2"))
    cached.close()
