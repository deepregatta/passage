"""Coverage boundaries and unsorted nearest/coastal queries; synthetic data only."""

import numpy as np
import pytest
import xarray as xr

from deepweather_analysis.environment_grid import EnvironmentGrid


def grid_at(tmp_path, order=(0, 1, 2, 3), masked=False):
    times = np.arange("2026-07-12T00", "2026-07-12T04", dtype="datetime64[h]")
    values = np.broadcast_to(np.arange(4.0)[:, None, None] + 1, (4, 3, 3)).copy()
    if masked:
        values[:, 1, 1] = np.nan
    ds = xr.Dataset(
        {"uo": (("time", "lat", "lon"), values), "vo": (("time", "lat", "lon"), values * 2)},
        coords={
            "time": times.astype("datetime64[ns]"),
            "lat": [49.0, 49.01, 49.02],
            "lon": [-5.0, -4.99, -4.98],
        },
    ).isel(time=list(order))
    grid = EnvironmentGrid(currents_path=tmp_path / "absent.nc")
    grid._currents_ds = ds
    grid._currents_loaded = True
    grid._build_wet_cell_index()
    return grid


@pytest.mark.parametrize("mode", ["linear", "nearest", "linear-failure", "isel-failure"])
def test_outside_coverage_stays_nan_even_with_coastal_fill(tmp_path, monkeypatch, mode):
    if mode == "nearest":
        monkeypatch.setenv("DEEPWEATHER_INTERP_NEAREST_ONLY", "1")
    elif mode in ("linear-failure", "isel-failure"):

        def fail(*args, **kwargs):
            raise ValueError("forced fallback")

        monkeypatch.setattr(xr.DataArray, "interp", fail)
        if mode == "isel-failure":

            def fail_indices(*args):
                raise ValueError("forced label fallback")

            monkeypatch.setattr(EnvironmentGrid, "_nearest_indices", fail_indices)
    with grid_at(tmp_path) as grid:
        t = np.datetime64("2026-07-12T01", "s").astype("int64")
        lats = np.array([49.0, 49.02, 48.999, 49.021, 49.01, 49.01, 49.01, 49.01])
        lons = np.array([-5.0, -4.98, -4.99, -4.99, -5.001, -4.979, -4.99, -4.99])
        times = np.array([t - 3600, t + 7200, t, t, t, t, t - 3601, t + 7201])
        u, v = grid.get_current_batch(lats, lons, times)
        np.testing.assert_allclose(u[:2], [1, 4])
        np.testing.assert_allclose(v[:2], [2, 8])
        assert np.isnan(u[2:]).all()
        assert np.isnan(v[2:]).all()
        assert grid.coastal_fill_metrics.points_unfilled == 6


@pytest.mark.parametrize("order", [(0, 1, 2, 3), (3, 2, 1, 0), (2, 0, 3, 1)])
def test_coastal_fill_uses_nearest_unsorted_time_without_mutating_dataset(tmp_path, order):
    with grid_at(tmp_path, order, masked=True) as grid:
        original = grid.dataset.copy(deep=True)
        times = np.array(
            ["2026-07-12T00:10", "2026-07-12T01:10", "2026-07-12T02:50"], dtype="datetime64[s]"
        ).astype("int64")
        u, v = grid.get_current_batch(np.full(3, 49.01), np.full(3, -4.99), times)
        np.testing.assert_allclose(u, [1, 2, 4])
        np.testing.assert_allclose(v, [2, 4, 8])
        assert grid.coastal_fill_metrics.points_filled == 3
        xr.testing.assert_identical(grid.dataset, original)


def test_nearest_unsorted_axes_and_singleton_bounds(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPWEATHER_INTERP_NEAREST_ONLY", "1")
    with grid_at(tmp_path, (2, 0, 3, 1)) as grid:
        grid._currents_ds = grid.dataset.isel(lat=[1], lon=[1])
        times = np.array(["2026-07-12T00:10", "2026-07-12T02:50"], dtype="datetime64[s]")
        values = grid._interpolate_variable_batch(
            grid.dataset, "uo", np.array([49.01, 49.011]), np.full(2, -4.99), times
        )
        assert values[0] == 1
        assert np.isnan(values[1])


def test_subsecond_bounds_and_nonfinite_positions_stay_missing(tmp_path, monkeypatch):
    from deepweather_analysis import environment_grid

    monkeypatch.setattr(environment_grid, "INTERP_BATCH_SIZE", 2)
    monkeypatch.setenv("DEEPWEATHER_INTERP_NEAREST_ONLY", "1")
    with grid_at(tmp_path) as grid:
        t = float(np.datetime64("2026-07-12T00", "s").astype("int64"))
        times = np.array([t, t - 0.1, t + 10800.1, t + 3600, t + 3600])
        u, v = grid.get_current_batch(
            np.array([49.0, 49.0, 49.0, np.nan, 49.0]),
            np.array([-5.0, -5.0, -5.0, -5.0, np.inf]),
            times,
        )
        assert u[0] == 1
        assert v[0] == 2
        assert np.isnan(u[1:]).all()
        assert np.isnan(v[1:]).all()
        assert grid.coastal_fill_metrics.points_unfilled == 4
