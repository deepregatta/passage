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


@pytest.mark.parametrize("failure", [None, "exception", "invalid-file"])
def test_currents_delay_only_backs_off_failed_attempts(tmp_path, monkeypatch, failure):
    sleeps = []
    attempts = []
    output = tmp_path / "currents.nc"

    def subset(**kwargs):
        attempts.append(kwargs)
        if failure == "exception" and len(attempts) == 1:
            raise ConnectionError("temporary outage")
        output.write_bytes(b"mock currents")

    monkeypatch.setitem(sys.modules, "copernicusmarine", SimpleNamespace(subset=subset))
    monkeypatch.setattr(fetcher, "_check_copernicusmarine", lambda: True)
    monkeypatch.setattr(
        fetcher,
        "_resolve_regional_dataset",
        lambda region: SimpleNamespace(
            dataset_id="test-currents", product_id="test-product", temporal_resolution="hourly"
        ),
    )
    monkeypatch.setattr(fetcher, "_downsample_currents_file", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        fetcher,
        "_validate_currents_file",
        lambda path: (
            (False, "corrupt") if failure == "invalid-file" and len(attempts) == 1 else (True, None)
        ),
    )
    monkeypatch.setattr(fetcher, "CURRENTS_FETCH_DELAY", 2.0)
    monkeypatch.setattr(fetcher, "MAX_CURRENTS_RETRIES", 2)
    monkeypatch.setattr(fetcher.time, "sleep", sleeps.append)
    start = datetime(2026, 7, 12, tzinfo=timezone.utc)
    result = fetcher.fetch_regional_currents(
        "IBI", CHANNEL, start, start + timedelta(hours=6), output
    )
    assert result["status"] == "ok"
    assert len(attempts) == (2 if failure else 1)
    assert sleeps == ([2.0] if failure else [])


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

    def test_partial_regional_overlap_now_resolves_to_global(self):
        # A box only partly inside IBI used to overlap-match IBI (or fall to
        # None); since the GLO fallback landed, anything not fully inside a
        # regional model gets the global product, which covers the whole box.
        partial = {"min_lat": 20.0, "max_lat": 30.0, "min_lon": -19.0, "max_lon": -5.0}
        assert detect_region(partial) == "GLO"
        outside = {"min_lat": 10.0, "max_lat": 30.0, "min_lon": -19.0, "max_lon": -5.0}
        assert detect_region(outside) == "GLO"

    def test_missing_bounds_returns_none(self):
        assert detect_region({}) is None
        assert detect_region({"min_lat": 50.0}) is None


# =============================================================================
# Forecast dataset resolution
# =============================================================================


def _fake_dataset(dataset_id: str, variables=("uo", "vo")):
    service = SimpleNamespace(variables=[SimpleNamespace(short_name=name) for name in variables])
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
        monkeypatch.setenv("DEEPWEATHER_CURRENTS_DATASET_IBI", "my_custom_ibi_currents_PT1H-m")
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
        stale.valid_until = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
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

    times = np.array(["2026-07-12T00:00:00", "2026-07-12T01:00:00"], dtype="datetime64[ns]")
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
        monkeypatch.setattr(fetcher, "fetch_forecast_currents", lambda *a, **k: meta)
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
        assert doc["u_kt"][idx(0, 3, 4)] == pytest.approx(round(_uo(0, 3, 4) * MS_TO_KNOTS, 2))
        # Interior wet cell.
        assert doc["u_kt"][idx(0, 2, 3)] == pytest.approx(round(_uo(0, 2, 3) * MS_TO_KNOTS, 2))

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
            assert doc["u_kt"][idx(t, 1, 0)] == pytest.approx(round(_uo(t, 1, 1) * MS_TO_KNOTS, 2))
            assert doc["v_kt"][idx(t, 1, 0)] == pytest.approx(round(_vo(t, 1, 1) * MS_TO_KNOTS, 2))

    def test_latest_json_points_at_artifact(self, artifact):
        path, doc, tmp_path = artifact
        run_id = doc["run_id"]
        assert run_id == "cmems-ibi-20260712T00Z"
        assert path == tmp_path / "data" / "processed" / "runs" / run_id / "current_grid.json"
        latest = json.loads((tmp_path / "data" / "processed" / "runs" / "latest.json").read_text())
        assert latest["run_id"] == run_id
        assert latest["artifacts"]["current_grid"] == f"runs/{run_id}/current_grid.json"


# =============================================================================
# Time axis length: the default window and a product that ends early
# =============================================================================

# forecast-tiles docs/ibi-currents.md (measured 2026-09-28): the IBI bulletin of
# day D carries hourly values from D 00:00 to D+9 23:00 (240 h) and lands about
# 09:40-11:40 UTC, so a run before that reads the previous day's bulletin.
BULLETIN_HOURS = 240


def _hourly_value(hours_from_product_start):
    return round(0.01 * hours_from_product_start, 4)


def _write_hourly_currents(path, first, hours):
    """A wet synthetic product of `hours` hourly steps from `first`: value = 0.01 * hour."""
    times = np.array(
        [np.datetime64(first.replace(tzinfo=None) + timedelta(hours=h), "ns") for h in range(hours)]
    )
    shape = (hours, 1, len(SYN_LATS), len(SYN_LONS))
    values = np.broadcast_to(
        np.array([_hourly_value(h) for h in range(hours)])[:, None, None, None], shape
    ).copy()
    ds = xr.Dataset(
        {
            "uo": (("time", "depth", "latitude", "longitude"), values),
            "vo": (("time", "depth", "latitude", "longitude"), -values),
        },
        coords={"time": times, "depth": [0.5], "latitude": SYN_LATS, "longitude": SYN_LONS},
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(path)
    ds.close()


@pytest.fixture()
def product_run(tmp_path, monkeypatch):
    """prepare_current_grid against a product that holds only the hours it holds.

    The fake fetch writes the product whatever window it is asked for, as
    copernicusmarine.subset's default "inside" selection returns only the
    requested hours that exist (a warning, not an error, when the request
    runs past the dataset's end).
    """
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path / "data"))
    requests = []

    def run(product_first, product_hours, start, end=None):
        def fetch(bounds, start_time, end_time, force=False):
            requests.append((start_time, end_time))
            _write_hourly_currents(
                tmp_path / "cache" / "product" / "currents.nc", product_first, product_hours
            )
            return CurrentsMetadata(
                fetch_id="product",
                fetched_at=start_time.isoformat(),
                valid_until=(start_time + timedelta(hours=12)).isoformat(),
                bounds=dict(bounds),
                time_range={"start": start_time.isoformat(), "end": end_time.isoformat()},
                currents={
                    "status": "ok",
                    "source": "cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m",
                    "region": "IBI",
                    "resolution_deg": 0.05,
                    "variables": ["uo", "vo"],
                },
            )

        monkeypatch.setattr(fetcher, "fetch_forecast_currents", fetch)
        monkeypatch.setattr(fetcher, "get_cache_dir", lambda fid: tmp_path / "cache" / fid)
        path = grids_prep.prepare_current_grid(bounds=SYN_BOUNDS, start=start, end=end)
        return json.loads(path.read_text())

    return run, requests, tmp_path / "data" / "processed" / "runs"


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_run_before_the_bulletin_lands_publishes_the_whole_default_window(product_run):
    run, requests, _ = product_run
    day = datetime(2026, 11, 14, tzinfo=timezone.utc)
    start = day + timedelta(hours=11)  # the latest a run still reads D-1's bulletin
    doc = run(day - timedelta(days=1), BULLETIN_HOURS, _iso(start))

    assert requests == [(start, start + timedelta(hours=168))]
    assert len(doc["time_axis"]) == 169
    assert doc["time_axis"][0] == _iso(start)
    assert doc["time_axis"][-1] == _iso(start + timedelta(hours=168))
    # Hour k of the axis is the product's hour 35 + k (D-1 00:00 + 24 h + 11 h).
    cells = doc["nlat"] * doc["nlon"]
    last = 168 * cells
    assert doc["u_kt"][last] == pytest.approx(round(_hourly_value(35 + 168) * MS_TO_KNOTS, 2))


@pytest.mark.parametrize("product_hours_past_start", [100, 48])
def test_product_ending_early_publishes_a_shorter_axis_without_padding(
    product_run, product_hours_past_start
):
    run, _, runs_dir = product_run
    start = datetime(2026, 11, 14, 11, tzinfo=timezone.utc)
    doc = run(start, product_hours_past_start + 1, _iso(start))

    assert len(doc["time_axis"]) == product_hours_past_start + 1
    assert doc["time_axis"][-1] == _iso(start + timedelta(hours=product_hours_past_start))
    cells = doc["nlat"] * doc["nlon"]
    assert len(doc["u_kt"]) == len(doc["v_kt"]) == len(doc["time_axis"]) * cells
    for k in (0, product_hours_past_start):
        expected = round(_hourly_value(k) * MS_TO_KNOTS, 2)
        assert doc["u_kt"][k * cells : (k + 1) * cells] == [pytest.approx(expected)] * cells
    latest = json.loads((runs_dir / "latest.json").read_text())
    assert latest["artifacts"]["current_grid"] == f"runs/{doc['run_id']}/current_grid.json"


def test_product_too_short_to_be_useful_fails_and_publishes_nothing(product_run):
    run, _, runs_dir = product_run
    start = datetime(2026, 11, 14, 11, tzinfo=timezone.utc)
    with pytest.raises(RuntimeError, match="not published"):
        run(start, 48, _iso(start))  # ends at start + 47 h
    assert not runs_dir.exists() or not any(runs_dir.rglob("*.json"))


def test_an_explicit_window_shorter_than_the_minimum_is_still_published(product_run):
    run, _, _ = product_run
    start = datetime(2026, 11, 14, 11, tzinfo=timezone.utc)
    doc = run(start, 4, _iso(start), _iso(start + timedelta(hours=3)))
    assert len(doc["time_axis"]) == 4
