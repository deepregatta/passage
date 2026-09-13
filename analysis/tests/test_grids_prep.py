"""Native-node sampling parity and coastal-mask regressions (no network)."""

from datetime import datetime, timezone

import numpy as np
import pytest
import xarray as xr

from deepweather_analysis import grids_prep
from deepweather_analysis.environment_grid import EnvironmentGrid


def _grid(tmp_path, *, reverse=False, alternate_dims=False, masked=True):
    lats = 49.0 + np.arange(9) * 0.025
    lons = -5.0 + np.arange(11) * 0.025
    times = np.arange("2026-07-12T00", "2026-07-12T04", dtype="datetime64[h]").astype(
        "datetime64[ns]"
    )
    t, i, j = np.indices((4, 9, 11))
    u = (0.07 * t + 0.013 * i**2 - 0.021 * j).astype(np.float32)
    v = (-0.04 * t + 0.031 * i + 0.003 * j**2).astype(np.float32)
    if masked:
        # Wide land patch stays null; its edge and an isolated hole can be filled.
        u[:, :4, :5] = v[:, :4, :5] = np.nan
        u[:, 6, 6] = v[:, 6, 6] = np.nan
        v[1, 4, 4] = np.nan  # one missing component uses the existing pair fill
    ds = xr.Dataset(
        {
            "uo": (("time", "latitude", "longitude"), u),
            "vo": (("time", "latitude", "longitude"), v),
        },
        coords={"time": times, "latitude": lats, "longitude": lons},
    )
    if not alternate_dims:
        ds = xr.concat([ds, ds + 100], dim=xr.IndexVariable("depth", [0.5, 10.0]))
    if reverse:
        ds = ds.isel(
            latitude=slice(None, None, -1),
            longitude=slice(None, None, -1),
            time=slice(None, None, -1),
        )
    if alternate_dims:
        ds = ds.rename({"latitude": "lat", "longitude": "lon", "time": "valid_time"})
        ds = ds.transpose("lon", "valid_time", "lat")
    grid = EnvironmentGrid(currents_path=tmp_path / "absent.nc")
    grid._currents_ds = ds
    grid._currents_loaded = True
    grid._build_wet_cell_index()
    return grid


def _build(grid, *, stride=True, single_time=False):
    return grids_prep._build_grid_artifact(
        grid,
        bounds={"min_lat": 49.025, "max_lat": 49.175, "min_lon": -4.975, "max_lon": -4.775},
        start_time=datetime(2026, 7, 12, 1, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 1 if single_time else 2, tzinfo=timezone.utc),
        target_resolution_deg=0.05 if stride else 0.025,
        region="IBI",
        dataset_id="test-currents",
        native_resolution_deg=0.025,
        fetched_at="2026-07-12T00:15:00Z",
    )


def _legacy_sample(grid, doc):
    """Run the previous interpolation/fill path on the same exact native nodes."""
    ds = grid.dataset
    lat, lon, _ = grid._get_coord_names(ds)
    # Match to native values so artifact coordinate rounding does not affect the reference.
    lats = sorted(ds[lat].values)
    lons = sorted(ds[lon].values)
    lats = np.array(
        [
            min(lats, key=lambda x: abs(x - (doc["lat0"] + i * doc["dlat"])))
            for i in range(doc["nlat"])
        ]
    )
    lons = np.array(
        [
            min(lons, key=lambda x: abs(x - (doc["lon0"] + i * doc["dlon"])))
            for i in range(doc["nlon"])
        ]
    )
    times = np.array([t.removesuffix("Z") for t in doc["time_axis"]], dtype="datetime64[s]")
    u, v = grid.get_current_batch(
        np.tile(np.repeat(lats, len(lons)), len(times)),
        np.tile(lons, len(lats) * len(times)),
        np.repeat(times.astype("int64"), len(lats) * len(lons)),
    )
    return [np.round(a * grids_prep.MS_TO_KNOTS, 2) for a in (u, v)]


@pytest.mark.parametrize("reverse,alternate_dims", [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize("stride,single_time", [(False, False), (True, False), (True, True)])
def test_matches_previous_sampling(tmp_path, reverse, alternate_dims, stride, single_time):
    with _grid(tmp_path, reverse=reverse, alternate_dims=alternate_dims) as grid:
        original = grid.dataset.copy(deep=True)
        doc = _build(grid, stride=stride, single_time=single_time)
        expected = _legacy_sample(grid, doc)
        for field, values in zip(("u_kt", "v_kt"), expected):
            actual = np.asarray(doc[field], dtype=float)
            np.testing.assert_array_equal(np.isnan(actual), np.isnan(values))
            np.testing.assert_allclose(actual, values, atol=0.010001, rtol=0, equal_nan=True)
        xr.testing.assert_identical(grid.dataset, original)
        assert doc["time_axis"][0] == "2026-07-12T01:00:00Z"
        assert len(doc["time_axis"]) == (1 if single_time else 2)
        assert doc["nlat"] == (4 if stride else 7)
        assert doc["nlon"] == (5 if stride else 9)


@pytest.mark.parametrize("masked", [False, True])
def test_native_nodes_bypass_interpolation(tmp_path, monkeypatch, masked):
    with _grid(tmp_path, masked=masked) as grid:

        def no_interpolation(*args, **kwargs):
            pytest.fail("native nodes must not go through general interpolation")

        monkeypatch.setattr(grid, "get_current_batch", no_interpolation)
        _build(grid)


def test_only_masked_pairs_need_coastal_fill(tmp_path):
    with _grid(tmp_path) as grid:
        _build(grid)
        raw = grid.dataset.isel(
            depth=0, time=[1, 2], latitude=[1, 3, 5, 7], longitude=[1, 3, 5, 7, 9]
        )
        expected_raw = int((np.isfinite(raw.uo) & np.isfinite(raw.vo)).sum())
        assert grid.coastal_fill_metrics.points_raw == expected_raw
        assert grid.coastal_fill_metrics.points_filled > 0
        assert grid.coastal_fill_metrics.points_unfilled > 0
