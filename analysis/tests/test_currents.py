"""M7 tests: CMEMS forecast currents fetcher + region-grid artifact writer.

No network: copernicusmarine is mocked (same pattern as coachregatta's
test_environment_fetcher.py) and the artifact writer runs from a small
synthetic xarray dataset built in-test.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import numpy as np
import pytest
import xarray as xr
from jsonschema import Draft202012Validator

from deepweather_analysis import environment_fetcher as fetcher
from deepweather_analysis import grids_prep
from deepweather_analysis.environment_fetcher import (
    REGIONAL_MODELS,
    REGION_PRIORITY,
    CurrentsMetadata,
    detect_region,
)
from deepweather_analysis.grids_prep import CHANNEL_BOUNDS, MS_TO_KNOTS
from deepweather_analysis.paths import contracts_dir

CHANNEL = dict(CHANNEL_BOUNDS)


# =============================================================================
# Region detection
# =============================================================================


class TestDetectRegion:
    def test_channel_corridor_picks_ibi(self):
        assert detect_region(CHANNEL) == "IBI"

    def test_nws_is_the_fallback_for_the_channel(self, monkeypatch):
        # The Channel corridor is fully inside NWS bounds too...
        nws = REGIONAL_MODELS["NWS"]
        assert CHANNEL["min_lat"] >= nws.bounds["lat"][0]
        assert CHANNEL["max_lat"] <= nws.bounds["lat"][1]
        assert CHANNEL["min_lon"] >= nws.bounds["lon"][0]
        assert CHANNEL["max_lon"] <= nws.bounds["lon"][1]
        assert REGION_PRIORITY[:2] == ["IBI", "NWS"]
        # ...so without IBI, detection falls back to NWS.
        monkeypatch.setattr(fetcher, "REGION_PRIORITY", ["NWS", "MED", "BAL"])
        assert detect_region(CHANNEL) == "NWS"

    def test_overlap_threshold_respected(self):
        # 20% overlap with IBI (lat 26..30 of a 10..30 box) -> below 0.25 -> None
        below = {"min_lat": 10.0, "max_lat": 30.0, "min_lon": -19.0, "max_lon": -5.0}
        assert detect_region(below) is None
        # 40% overlap (lat 26..30 of a 20..30 box) -> above threshold -> IBI
        above = {"min_lat": 20.0, "max_lat": 30.0, "min_lon": -19.0, "max_lon": -5.0}
        assert detect_region(above) == "IBI"

    def test_missing_bounds_returns_none(self):
        assert detect_region({}) is None
        assert detect_region({"min_lat": 50.0}) is None


# =============================================================================
# Forecast dataset resolution
# =============================================================================


def _fake_dataset(dataset_id: str, variables=("uo", "vo")):
    service = SimpleNamespace(
        variables=[SimpleNamespace(short_name=name) for name in variables]
    )
    part = SimpleNamespace(services=[service])
    version = SimpleNamespace(parts=[part])
    return SimpleNamespace(dataset_id=dataset_id, versions=[version])


class TestResolveForecastDataset:
    @pytest.fixture(autouse=True)
    def _clean_state(self, monkeypatch):
        monkeypatch.setattr(fetcher, "_RESOLVED_REGIONAL_DATASETS", {})
        monkeypatch.delenv("DEEPWEATHER_CURRENTS_DATASET_IBI", raising=False)

    def test_prefers_anfc_hourly_currents(self, monkeypatch):
        catalogue = SimpleNamespace(
            products=[
                SimpleNamespace(
                    product_id="IBI_ANALYSISFORECAST_PHY_005_001",
                    datasets=[
                        _fake_dataset("cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m"),
                        # daily -> excluded (not hourly/3-hourly)
                        _fake_dataset("cmems_mod_ibi_phy_anfc_0.027deg-3D_P1D-m"),
                        # 3-hourly anfc -> loses to hourly anfc
                        _fake_dataset("cmems_mod_ibi_phy_anfc_0.027deg_PT3H-m"),
                    ],
                ),
                SimpleNamespace(
                    product_id="IBI_MULTIYEAR_PHY_005_002",
                    datasets=[
                        # hourly but multiyear/reanalysis -> excluded (forecast-only)
                        _fake_dataset("cmems_mod_ibi_phy_my_0.027deg_PT1H-m"),
                    ],
                ),
                SimpleNamespace(
                    product_id="IBI_OTHER_005_003",
                    datasets=[
                        # hourly but not anfc -> loses to anfc
                        _fake_dataset("cmems_mod_ibi_phy_xyz_PT1H-m"),
                        # hourly anfc without uo/vo (waves) -> excluded
                        _fake_dataset(
                            "cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i",
                            variables=("VHM0",),
                        ),
                    ],
                ),
            ]
        )
        monkeypatch.setitem(
            sys.modules,
            "copernicusmarine",
            SimpleNamespace(describe=lambda **kwargs: catalogue),
        )

        resolved = fetcher._resolve_regional_dataset("IBI")
        assert resolved is not None
        assert resolved.dataset_id == "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m"
        assert resolved.temporal_resolution == "hourly"
        assert resolved.product_id == "IBI_ANALYSISFORECAST_PHY_005_001"

    def test_env_override_wins(self, monkeypatch):
        monkeypatch.setenv(
            "DEEPWEATHER_CURRENTS_DATASET_IBI", "my_custom_ibi_currents_PT1H-m"
        )
        monkeypatch.setitem(
            sys.modules,
            "copernicusmarine",
            SimpleNamespace(
                describe=lambda **kwargs: (_ for _ in ()).throw(
                    AssertionError("catalogue should not be queried when overridden")
                )
            ),
        )

        resolved = fetcher._resolve_regional_dataset("IBI")
        assert resolved is not None
        assert resolved.dataset_id == "my_custom_ibi_currents_PT1H-m"
        assert resolved.temporal_resolution == "hourly"


# =============================================================================
# Expiry-based cache invalidation
# =============================================================================


class TestExpiryInvalidation:
    @pytest.fixture()
    def fetch_env(self, tmp_path, monkeypatch):
        monkeypatch.setattr(fetcher, "CACHE_ROOT", tmp_path)
        monkeypatch.setattr(fetcher, "_validate_currents_file", lambda p: (True, None))

        calls = []

        def fake_fetch_regional(region, bounds, start_time, end_time, output_path):
            calls.append(region)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake netcdf")
            return {
                "status": "ok",
                "source": "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m",
                "region": region,
                "resolution_deg": 0.027,
                "temporal_resolution": "hourly",
                "variables": ["uo", "vo"],
            }

        monkeypatch.setattr(fetcher, "fetch_regional_currents", fake_fetch_regional)
        return calls

    def test_fresh_cache_is_reused_and_stale_valid_until_refetches(self, fetch_env):
        calls = fetch_env
        start = datetime(2026, 7, 12, 0, 0, tzinfo=timezone.utc)
        end = start + timedelta(hours=48)

        meta1 = fetcher.fetch_forecast_currents(CHANNEL, start, end)
        assert meta1.currents["status"] == "ok"
        assert len(calls) == 1
        assert meta1.valid_until > meta1.fetched_at

        # Fresh metadata (valid_until in the future) -> cache hit, no refetch.
        meta2 = fetcher.fetch_forecast_currents(CHANNEL, start, end)
        assert len(calls) == 1
        assert meta2.fetched_at == meta1.fetched_at

        # Stale valid_until -> refetch.
        stale = fetcher.load_currents_metadata(meta1.fetch_id)
        stale.valid_until = (
            datetime.now(timezone.utc) - timedelta(hours=1)
        ).isoformat()
        fetcher.save_currents_metadata(stale)
        meta3 = fetcher.fetch_forecast_currents(CHANNEL, start, end)
        assert len(calls) == 2
        assert meta3.fetched_at != meta1.fetched_at

    def test_changed_time_window_refetches(self, fetch_env):
        calls = fetch_env
        start = datetime(2026, 7, 12, 0, 0, tzinfo=timezone.utc)
        end = start + timedelta(hours=48)

        fetcher.fetch_forecast_currents(CHANNEL, start, end)
        assert len(calls) == 1
        # Same bounds, shifted window -> stale cache -> refetch.
        fetcher.fetch_forecast_currents(CHANNEL, start, end + timedelta(hours=6))
        assert len(calls) == 2

    def test_metadata_expired_helper(self):
        now = datetime(2026, 7, 12, 12, 0, tzinfo=timezone.utc)
        fresh = CurrentsMetadata(
            fetch_id="x",
            fetched_at=(now - timedelta(hours=1)).isoformat(),
            valid_until=(now + timedelta(hours=11)).isoformat(),
        )
        stale = CurrentsMetadata(
            fetch_id="x",
            fetched_at=(now - timedelta(hours=13)).isoformat(),
            valid_until=(now - timedelta(hours=1)).isoformat(),
        )
        broken = CurrentsMetadata(fetch_id="x", fetched_at="", valid_until="not-a-date")
        assert not fetcher._metadata_expired(fresh, now=now)
        assert fetcher._metadata_expired(stale, now=now)
        assert fetcher._metadata_expired(broken, now=now)


# =============================================================================
# Grid artifact writer
# =============================================================================

# Synthetic native grid: 0.05 deg spacing (== target -> stride 1), 2 hourly steps.
SYN_LATS = np.round(49.30 + 0.05 * np.arange(4), 6)  # 49.30 .. 49.45
SYN_LONS = np.round(-5.00 + 0.05 * np.arange(5), 6)  # -5.00 .. -4.80
SYN_BOUNDS = {"min_lat": 49.30, "max_lat": 49.45, "min_lon": -5.00, "max_lon": -4.80}


def _uo(t, i, j):
    return 0.5 * t + 0.1 * i + 0.01 * j


def _vo(t, i, j):
    return 0.2 * t - 0.05 * i + 0.02 * j


def _write_synthetic_currents(path):
    nt, ni, nj = 2, len(SYN_LATS), len(SYN_LONS)
    uo = np.zeros((nt, 1, ni, nj))
    vo = np.zeros((nt, 1, ni, nj))
    for t in range(nt):
        for i in range(ni):
            for j in range(nj):
                uo[t, 0, i, j] = _uo(t, i, j)
                vo[t, 0, i, j] = _vo(t, i, j)
    # Land: whole row i=0 is dry (nearest wet cell 5.55 km away -> stays null),
    # plus cell (i=1, j=0) whose lon-neighbour (1,1) is 3.6 km away -> gets filled.
    uo[:, :, 0, :] = np.nan
    vo[:, :, 0, :] = np.nan
    uo[:, :, 1, 0] = np.nan
    vo[:, :, 1, 0] = np.nan

    times = np.array(
        ["2026-07-12T00:00:00", "2026-07-12T01:00:00"], dtype="datetime64[ns]"
    )
    ds = xr.Dataset(
        {
            "uo": (("time", "depth", "latitude", "longitude"), uo),
            "vo": (("time", "depth", "latitude", "longitude"), vo),
        },
        coords={
            "time": times,
            "depth": [0.5],
            "latitude": SYN_LATS,
            "longitude": SYN_LONS,
        },
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(path)
    ds.close()


class TestGridArtifactWriter:
    @pytest.fixture()
    def artifact(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path / "data"))

        cache_dir = tmp_path / "cache" / "test-fetch"
        _write_synthetic_currents(cache_dir / "currents.nc")

        fetched_at = "2026-07-12T00:15:00+00:00"
        meta = CurrentsMetadata(
            fetch_id="test-fetch",
            fetched_at=fetched_at,
            valid_until="2026-07-12T12:15:00+00:00",
            bounds=dict(SYN_BOUNDS),
            time_range={"start": "2026-07-12T00:00:00+00:00", "end": "2026-07-12T01:00:00+00:00"},
            currents={
                "status": "ok",
                "source": "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m",
                "region": "IBI",
                "resolution_deg": 0.05,
                "temporal_resolution": "hourly",
                "variables": ["uo", "vo"],
            },
        )
        monkeypatch.setattr(
            fetcher, "fetch_forecast_currents", lambda *a, **k: meta
        )
        monkeypatch.setattr(fetcher, "get_cache_dir", lambda fid: tmp_path / "cache" / fid)

        path = grids_prep.prepare_current_grid(
            bounds=SYN_BOUNDS,
            start="2026-07-12T00:00:00Z",
            end="2026-07-12T01:00:00Z",
        )
        return path, json.loads(path.read_text()), tmp_path

    def test_artifact_is_schema_valid(self, artifact):
        _, doc, _ = artifact
        schema = json.loads((contracts_dir() / "region-grid.schema.json").read_text())
        Draft202012Validator(schema).validate(doc)
        assert doc["kind"] == "surface_current"
        assert doc["schema_version"] == 1
        assert doc["source"]["mode"] == "live"
        assert doc["source"]["dataset_id"] == "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m"
        assert doc["source"]["fetched_at"] == "2026-07-12T00:15:00Z"

    def test_grid_geometry_and_time_axis(self, artifact):
        _, doc, _ = artifact
        assert doc["nlat"] == 4
        assert doc["nlon"] == 5
        assert doc["lat0"] == pytest.approx(49.30)
        assert doc["lon0"] == pytest.approx(-5.00)
        assert doc["dlat"] == pytest.approx(0.05)
        assert doc["dlon"] == pytest.approx(0.05)
        assert doc["time_axis"] == ["2026-07-12T00:00:00Z", "2026-07-12T01:00:00Z"]
        assert len(doc["u_kt"]) == 2 * 4 * 5
        assert len(doc["v_kt"]) == 2 * 4 * 5

    def test_flat_indexing_and_knot_conversion(self, artifact):
        _, doc, _ = artifact
        nlat, nlon = doc["nlat"], doc["nlon"]

        def idx(t, i, j):
            return (t * nlat + i) * nlon + j

        # Known corner value: (t=1, i=3, j=4) -> flat index 39.
        assert idx(1, 3, 4) == 39
        assert doc["u_kt"][39] == pytest.approx(round(_uo(1, 3, 4) * MS_TO_KNOTS, 2))
        assert doc["v_kt"][39] == pytest.approx(round(_vo(1, 3, 4) * MS_TO_KNOTS, 2))
        # And the opposite time slice of the same cell.
        assert doc["u_kt"][idx(0, 3, 4)] == pytest.approx(
            round(_uo(0, 3, 4) * MS_TO_KNOTS, 2)
        )
        # Interior wet cell.
        assert doc["u_kt"][idx(0, 2, 3)] == pytest.approx(
            round(_uo(0, 2, 3) * MS_TO_KNOTS, 2)
        )

    def test_coastal_fill_and_land_nulls(self, artifact):
        _, doc, _ = artifact
        nlat, nlon = doc["nlat"], doc["nlon"]

        def idx(t, i, j):
            return (t * nlat + i) * nlon + j

        # Dry row i=0 is > MAX_FILL_DISTANCE_KM from any wet cell -> null.
        for t in range(2):
            for j in range(nlon):
                assert doc["u_kt"][idx(t, 0, j)] is None
                assert doc["v_kt"][idx(t, 0, j)] is None
        # Dry cell (1,0) is ~3.6 km from wet neighbour (1,1) -> filled with it.
        for t in range(2):
            assert doc["u_kt"][idx(t, 1, 0)] == pytest.approx(
                round(_uo(t, 1, 1) * MS_TO_KNOTS, 2)
            )
            assert doc["v_kt"][idx(t, 1, 0)] == pytest.approx(
                round(_vo(t, 1, 1) * MS_TO_KNOTS, 2)
            )

    def test_latest_json_points_at_artifact(self, artifact):
        path, doc, tmp_path = artifact
        run_id = doc["run_id"]
        assert run_id == "cmems-ibi-20260712T00Z"
        assert path == tmp_path / "data" / "processed" / "runs" / run_id / "current_grid.json"
        latest = json.loads(
            (tmp_path / "data" / "processed" / "runs" / "latest.json").read_text()
        )
        assert latest["run_id"] == run_id
        assert latest["artifacts"]["current_grid"] == f"runs/{run_id}/current_grid.json"
