"""M8 tests: synoptic prepared-run publishing with a mocked ECMWF fetch.

No network: fetch_fields is monkeypatched to return a synthetic xarray
dataset; the data root is redirected to tmp_path via DEEPWEATHER_DATA_ROOT.
Checks schema validity of every artifact and that the latest.json merge
preserves the existing CMEMS current_grid pointer.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pytest
import xarray as xr
from jsonschema import Draft202012Validator

from deepweather_analysis import synoptic_prep
from deepweather_analysis.paths import contracts_dir
from deepweather_analysis.synoptic_prep import MS_TO_KNOTS, prepare_synoptic

CYCLE = "20260701T00Z"
CYCLE_TIME = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)

LATS = np.arange(40.0, 55.01, 0.25)   # covers the Channel wind window
LONS = np.arange(-12.0, 2.01, 0.25)
STEPS = [0, 3, 6]


def synthetic_dataset() -> xr.Dataset:
    """A deep low (985 hPa) at 50N drifting east 0.75 deg per 3 h step."""
    lon_grid, lat_grid = np.meshgrid(LONS, LATS)
    msl = np.empty((len(STEPS), LATS.size, LONS.size))
    for t, step_h in enumerate(STEPS):
        clat, clon = 50.0, -8.0 + 0.25 * step_h
        r2 = (lat_grid - clat) ** 2 + ((lon_grid - clon) * np.cos(np.radians(clat))) ** 2
        msl[t] = 1015.0 - 30.0 * np.exp(-r2 / (2.0 * 3.0**2)) + 0.1 * step_h
    u10 = np.full_like(msl, 5.0)
    v10 = np.full_like(msl, -2.0)
    valid = np.datetime64(CYCLE_TIME.replace(tzinfo=None), "ns") + np.array(
        STEPS, dtype="timedelta64[h]"
    )
    return xr.Dataset(
        {
            "msl": (("step", "latitude", "longitude"), msl, {"units": "hPa"}),
            "u10": (("step", "latitude", "longitude"), u10, {"units": "m s-1"}),
            "v10": (("step", "latitude", "longitude"), v10, {"units": "m s-1"}),
        },
        coords={
            "step": ("step", np.array(STEPS)),
            "latitude": ("latitude", LATS),
            "longitude": ("longitude", LONS),
            "valid_time": ("step", valid),
        },
        attrs={"cycle": CYCLE},
    )


def synthetic_meta() -> dict:
    return {
        "cycle": CYCLE,
        "cycle_time": "2026-07-01T00:00:00Z",
        "fetched_at": "2026-07-01T07:05:00Z",
        "checksum": "sha256:" + "0" * 64,
        "licence": "CC-BY-4.0, source: ECMWF open data",
        "dataset_id": "ifs-0.25-open-data",
        "params": ["msl", "10u", "10v"],
        "steps_h": STEPS,
        "window": {"min_lat": 35.0, "max_lat": 65.0, "min_lon": -35.0, "max_lon": 10.0},
        "publication_lag_minutes": 425.0,
    }


@pytest.fixture()
def prep_env(tmp_path, monkeypatch):
    """Redirected data root with a pre-existing CMEMS latest.json + mocked fetch."""
    data_root = tmp_path / "data"
    runs_dir = data_root / "processed" / "runs"
    runs_dir.mkdir(parents=True)
    existing_latest = {
        "run_id": "cmems-ibi-20260630T19Z",
        "artifacts": {"current_grid": "runs/cmems-ibi-20260630T19Z/current_grid.json"},
    }
    (runs_dir / "latest.json").write_text(json.dumps(existing_latest, indent=2) + "\n")

    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(data_root))
    monkeypatch.setattr(
        synoptic_prep, "fetch_fields", lambda cycle=None, force=False: (synthetic_dataset(), synthetic_meta())
    )
    return data_root


def _validator(schema_file: str) -> Draft202012Validator:
    schema = json.loads((contracts_dir() / schema_file).read_text())
    return Draft202012Validator(schema)


class TestPrepareSynoptic:
    def test_full_prepare_publishes_valid_artifacts(self, prep_env):
        summary = prepare_synoptic(panel_steps=(0, 3))
        run_id = summary["run_id"]
        assert run_id == f"ecmwf-ifs025-{CYCLE}"
        run_dir = prep_env / "processed" / "runs" / run_id

        # features.json: schema-valid, one tracked low, no route transitions.
        features = json.loads((run_dir / "synoptic" / "features.json").read_text())
        _validator("synoptic-features.schema.json").validate(features)
        assert features["run_id"] == run_id
        assert features["route_transitions"] == []
        lows = [s for s in features["systems"] if s["kind"] == "low"]
        assert len(lows) == 1
        low = lows[0]
        assert low["system_id"] == "L1"
        assert len(low["track"]) == len(STEPS)
        assert low["track"][0]["valid_time"] == "2026-07-01T00:00:00Z"
        assert low["track"][-1]["valid_time"] == "2026-07-01T06:00:00Z"
        # Moving east: motion ~090; filling +0.1 hPa/h -> +2.4 hPa/24h.
        assert low["motion"]["dir_deg"] == pytest.approx(90.0, abs=5.0)
        assert low["deepening_hpa_per_24h"] == pytest.approx(2.4, abs=0.2)
        # Mediterranean boxes are outside this grid -> no regime.
        assert features["regimes"] == []

        # Charts + captions.
        assert len(features["chart_captions"]) == 2
        for entry in features["chart_captions"]:
            assert (prep_env / "processed" / entry["file"]).exists()
            assert entry["caption"].startswith(f"T+{entry['step_h']}:")
            assert "L1" in entry["caption"]
        assert (run_dir / "synoptic" / "charts" / "t000.png").exists()
        assert (run_dir / "synoptic" / "charts" / "t003.png").exists()

        # wind_grid.json: schema-valid, Channel window at native 0.25 deg.
        wind = json.loads((run_dir / "wind_grid.json").read_text())
        _validator("region-grid.schema.json").validate(wind)
        assert wind["kind"] == "wind10m"
        assert wind["lat0"] == 49.0 and wind["lon0"] == -6.0
        assert wind["dlat"] == 0.25 and wind["dlon"] == 0.25
        assert wind["nlat"] == 9 and wind["nlon"] == 25
        assert len(wind["time_axis"]) == len(STEPS)
        assert len(wind["u_kt"]) == len(STEPS) * 9 * 25
        assert wind["u_kt"][0] == pytest.approx(round(5.0 * MS_TO_KNOTS, 2))
        assert wind["v_kt"][0] == pytest.approx(round(-2.0 * MS_TO_KNOTS, 2))

        # run.json manifest: schema-valid, source provenance carried through.
        manifest = json.loads((run_dir / "run.json").read_text())
        _validator("prepared-run.schema.json").validate(manifest)
        assert manifest["cycle"] == CYCLE
        assert manifest["steps_h"] == STEPS
        assert manifest["valid_until"] == "2026-07-01T12:00:00Z"
        assert manifest["bounds"]["min_lat"] == 35.0
        assert manifest["artifacts"]["synoptic_features"] == f"runs/{run_id}/synoptic/features.json"
        assert manifest["artifacts"]["wind_grid"] == f"runs/{run_id}/wind_grid.json"
        assert len(manifest["artifacts"]["synoptic_charts"]) == 2
        source = manifest["sources"][0]
        assert source["kind"] == "ecmwf-open-data"
        assert source["mode"] == "live"
        assert source["checksum_sha256"].startswith("sha256:")
        assert source["licence"].startswith("CC-BY-4.0")

    def test_latest_json_merge_preserves_current_grid(self, prep_env):
        prepare_synoptic(panel_steps=(0,))
        latest = json.loads((prep_env / "processed" / "runs" / "latest.json").read_text())
        run_id = f"ecmwf-ifs025-{CYCLE}"
        assert latest["run_id"] == run_id
        artifacts = latest["artifacts"]
        # The pre-existing CMEMS pointer is never dropped.
        assert artifacts["current_grid"] == "runs/cmems-ibi-20260630T19Z/current_grid.json"
        assert artifacts["synoptic_features"] == f"runs/{run_id}/synoptic/features.json"
        assert artifacts["wind_grid"] == f"runs/{run_id}/wind_grid.json"
        assert artifacts["run_manifest"] == f"runs/{run_id}/run.json"
        assert artifacts["synoptic_charts"] == [f"runs/{run_id}/synoptic/charts/t000.png"]

    def test_panel_steps_missing_from_dataset_are_skipped(self, prep_env):
        summary = prepare_synoptic(panel_steps=(0, 24, 48, 72))
        assert [c["step_h"] for c in summary["charts"]] == [0]
