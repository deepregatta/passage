# Vendored from coachregatta analysis/src/coachregatta_analysis/environment_grid.py, 2026-07-11 — adapted for deepweather (forecast products, DEEPWEATHER_* env vars).
"""
Environment grid for spatiotemporal interpolation of current data.

Provides access to cached Copernicus Marine current data with bilinear
spatial and linear temporal interpolation, plus KDTree coastal gap fill.

Adaptations from the coachregatta original: env vars renamed
COACHREGATTA_* -> DEEPWEATHER_*, weather (ERA5) accessors dropped
(currents-only), and the constructor accepts either a cache fetch_id or an
explicit currents.nc path.

Usage:
    from deepweather_analysis.environment_grid import EnvironmentGrid

    grid = EnvironmentGrid("ibi-1a2b3c4d")
    if grid.has_currents:
        u, v = grid.get_current(50.5, -5.2, datetime(2026, 7, 12, 12, 0))
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional, Tuple, TYPE_CHECKING

import numpy as np

from .paths import data_root

if TYPE_CHECKING:
    import xarray as xr

logger = logging.getLogger(__name__)

# Large vectorized queries can be slow in xarray; chunk to keep interpolation responsive.
INTERP_BATCH_SIZE = int(os.getenv("DEEPWEATHER_INTERP_BATCH_SIZE", "250"))
# Build coastal-fill wet masks in small time chunks to avoid loading full current cubes.
COASTAL_FILL_TIME_CHUNK = max(
    1, int(os.getenv("DEEPWEATHER_COASTAL_FILL_TIME_CHUNK", "4"))
)


# Maximum distance (in km) to search for nearest wet cell for coastal gap fill
MAX_FILL_DISTANCE_KM = 5.0


@dataclass
class CoastalFillMetrics:
    """Metrics tracking coastal gap fill operations."""

    points_raw: int = 0  # Points with valid currents from interpolation
    points_filled: int = 0  # Points filled using coastal fallback
    points_unfilled: int = 0  # Points that couldn't be filled (beyond threshold)
    fill_distances_km: List[float] = field(default_factory=list)

    @property
    def total_valid(self) -> int:
        """Total points with current data (raw + filled)."""
        return self.points_raw + self.points_filled

    @property
    def avg_fill_distance_km(self) -> Optional[float]:
        """Average fill distance in km."""
        if not self.fill_distances_km:
            return None
        return sum(self.fill_distances_km) / len(self.fill_distances_km)

    @property
    def max_fill_distance_km(self) -> Optional[float]:
        """Maximum fill distance in km."""
        if not self.fill_distances_km:
            return None
        return max(self.fill_distances_km)


# Cache directory (same as environment_fetcher)
CACHE_ROOT = data_root() / "cache" / "environment"

# Conversion factors
MS_TO_KNOTS = 1.94384


def _open_nc_robust(path: "Path") -> Any:
    """Open a NetCDF/HDF5 file trying netcdf4 then h5netcdf engines."""
    import xarray as xr

    last_exc: Exception = RuntimeError("No engines available")
    for engine in ("netcdf4", "h5netcdf"):
        try:
            return xr.open_dataset(path, engine=engine)
        except Exception as exc:
            last_exc = exc
    raise last_exc


def _check_xarray() -> bool:
    """Check if xarray is available."""
    try:
        import xarray  # noqa: F401

        return True
    except ImportError:
        return False


def _load_source_status(cache_dir: Path, source_key: str) -> Optional[str]:
    """Return cached metadata status for a source, if metadata exists."""
    metadata_path = cache_dir / "metadata.json"
    if not metadata_path.exists():
        return None
    try:
        with metadata_path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    source = metadata.get(source_key)
    if isinstance(source, dict):
        status = source.get("status")
        if isinstance(status, str):
            return status
    return None


class EnvironmentGrid:
    """
    Container for cached current data with interpolation support.

    Loads currents.nc from the cache directory (or an explicit path) and
    provides spatiotemporal interpolation for any point/time within the data
    bounds, with KDTree coastal gap fill for land-masked cells.
    """

    def __init__(
        self,
        fetch_id: Optional[str] = None,
        *,
        currents_path: Optional[Path] = None,
    ):
        """
        Initialize environment grid.

        Args:
            fetch_id: Cache key (determines cache directory CACHE_ROOT/fetch_id)
            currents_path: Explicit path to a currents NetCDF (overrides fetch_id)
        """
        if fetch_id is None and currents_path is None:
            raise ValueError("Provide fetch_id or currents_path")

        self.fetch_id = fetch_id or str(currents_path)
        self._currents_ds = None
        self._currents_loaded = False

        currents_status: Optional[str] = None
        if currents_path is None:
            assert fetch_id is not None
            cache_dir = CACHE_ROOT / fetch_id
            currents_path = cache_dir / "currents.nc"
            currents_status = _load_source_status(cache_dir, "currents")

        # Try to load currents data
        if currents_path.exists() and _check_xarray():
            if currents_status and currents_status != "ok":
                logger.debug(
                    "Ignoring currents.nc for %s because metadata status is %s",
                    self.fetch_id,
                    currents_status,
                )
            else:
                try:
                    ds = _open_nc_robust(currents_path)
                    if "uo" in ds.data_vars and "vo" in ds.data_vars:
                        self._currents_ds = ds
                        self._currents_loaded = True
                        logger.debug("Loaded currents data for %s", self.fetch_id)
                    else:
                        logger.warning(
                            "Ignoring invalid currents.nc for %s (missing uo/vo)",
                            self.fetch_id,
                        )
                        ds.close()
                except Exception as e:
                    logger.warning(
                        "Failed to load currents.nc for %s: %s", self.fetch_id, e
                    )

        # Build wet cell index for coastal gap fill
        self._wet_kdtree: Any | None = None
        self._wet_lats: np.ndarray | None = None
        self._wet_lons: np.ndarray | None = None
        self._lon_scale: float = 1.0
        self._coastal_fill_metrics = CoastalFillMetrics()

        if self._currents_loaded:
            self._build_wet_cell_index()

    @property
    def dataset(self) -> Optional["xr.Dataset"]:
        """The underlying currents dataset, if loaded."""
        return self._currents_ds

    def _build_wet_cell_index(self) -> None:
        """
        Build a KDTree index of 'wet' cells (non-masked) for coastal gap fill.

        A cell is considered wet if uo/vo are finite for at least one time slice.
        This allows nearest-neighbor lookup when interpolation returns NaN near coast.
        """
        try:
            from scipy.spatial import cKDTree  # type: ignore[import-untyped]

            assert self._currents_ds is not None
            lat_coord, lon_coord, _ = self._get_coord_names(self._currents_ds)

            # Get grid coordinates
            lats = np.asarray(self._currents_ds[lat_coord].values).reshape(-1)
            lons = np.asarray(self._currents_ds[lon_coord].values).reshape(-1)

            # Get uo variable (surface currents)
            uo = self._currents_ds["uo"]
            if "depth" in uo.dims:
                uo = uo.isel(depth=0)

            # Build wet mask incrementally so large current cubes do not get loaded at once.
            wet_mask = self._build_chunked_wet_mask(uo, lat_coord, lon_coord)
            expected_shape = (lats.size, lons.size)
            if wet_mask.shape != expected_shape:
                raise ValueError(
                    f"Unexpected wet mask shape {wet_mask.shape}; expected {expected_shape}"
                )

            # Create meshgrid of lat/lon
            lon_grid, lat_grid = np.meshgrid(lons, lats)

            # Extract wet cell coordinates
            wet_lat = lat_grid[wet_mask]
            wet_lon = lon_grid[wet_mask]

            if len(wet_lat) == 0:
                logger.warning(
                    "No wet cells found in currents data for %s", self.fetch_id
                )
                return

            # Build KDTree with (lat, lon) coordinates
            # Note: KDTree uses Euclidean distance, so for lat/lon we scale lon by cos(lat)
            # For small regions this approximation is acceptable
            mean_lat = np.mean(wet_lat)
            lon_scale = np.cos(np.radians(mean_lat))

            # Store wet cell data
            self._wet_lats = wet_lat
            self._wet_lons = wet_lon
            self._lon_scale = lon_scale

            # Build tree with scaled coordinates
            coords = np.column_stack([wet_lat, wet_lon * lon_scale])
            self._wet_kdtree = cKDTree(coords)

            logger.debug(
                "Built wet cell index for %s: %d wet cells (%.1f%% of grid)",
                self.fetch_id,
                len(wet_lat),
                100 * len(wet_lat) / wet_mask.size,
            )

        except Exception as e:
            logger.warning(
                "Failed to build wet cell index for %s: %s", self.fetch_id, e
            )
            self._wet_kdtree = None

    def _build_chunked_wet_mask(
        self,
        var: Any,
        lat_coord: str,
        lon_coord: str,
    ) -> np.ndarray:
        """Collapse all non-spatial dimensions to a 2D wet mask in small chunks."""
        time_coord = self._get_coord_names(self._currents_ds)[2]
        if time_coord not in var.dims:
            return self._mask_lat_lon_values(var, lat_coord, lon_coord)

        time_size = int(var.sizes.get(time_coord, 0))
        if time_size <= 0:
            return self._mask_lat_lon_values(var, lat_coord, lon_coord)

        wet_mask: np.ndarray | None = None
        for start in range(0, time_size, COASTAL_FILL_TIME_CHUNK):
            stop = min(start + COASTAL_FILL_TIME_CHUNK, time_size)
            chunk = var.isel({time_coord: slice(start, stop)})
            chunk_mask = self._mask_lat_lon_values(chunk, lat_coord, lon_coord)
            wet_mask = chunk_mask if wet_mask is None else (wet_mask | chunk_mask)
            if wet_mask.all():
                break

        if wet_mask is None:
            return self._mask_lat_lon_values(var, lat_coord, lon_coord)
        return wet_mask

    @staticmethod
    def _mask_lat_lon_values(var: Any, lat_coord: str, lon_coord: str) -> np.ndarray:
        """Return a 2D boolean mask ordered as (lat, lon)."""
        mask = np.isfinite(np.asarray(var.values))
        reduce_axes = tuple(
            axis
            for axis, dim in enumerate(var.dims)
            if dim not in {lat_coord, lon_coord}
        )
        if reduce_axes:
            mask = np.any(mask, axis=reduce_axes)

        spatial_dims = [dim for dim in var.dims if dim in {lat_coord, lon_coord}]
        mask = np.asarray(mask, dtype=bool)
        if spatial_dims == [lat_coord, lon_coord]:
            return mask
        if spatial_dims == [lon_coord, lat_coord]:
            return mask.T
        raise ValueError(
            f"Could not reduce variable dims {var.dims} to ({lat_coord}, {lon_coord})"
        )

    @property
    def has_currents(self) -> bool:
        """Check if current data is available."""
        return self._currents_loaded

    @property
    def coastal_fill_metrics(self) -> CoastalFillMetrics:
        """Get metrics from coastal gap fill operations."""
        return self._coastal_fill_metrics

    @property
    def has_coastal_fill(self) -> bool:
        """Check if coastal gap fill is available."""
        return self._wet_kdtree is not None

    def _get_coord_names(self, ds: xr.Dataset) -> Tuple[str, str, str]:
        """
        Get coordinate names for lat, lon, time.

        Different datasets use different names (lat/latitude, lon/longitude, time/valid_time).
        """
        # Latitude
        if "latitude" in ds.coords:
            lat_coord = "latitude"
        elif "lat" in ds.coords:
            lat_coord = "lat"
        else:
            raise ValueError("No latitude coordinate found")

        # Longitude
        if "longitude" in ds.coords:
            lon_coord = "longitude"
        elif "lon" in ds.coords:
            lon_coord = "lon"
        else:
            raise ValueError("No longitude coordinate found")

        # Time
        if "time" in ds.coords:
            time_coord = "time"
        elif "valid_time" in ds.coords:
            time_coord = "valid_time"
        else:
            raise ValueError("No time coordinate found")

        return lat_coord, lon_coord, time_coord

    def _interpolate_variable(
        self,
        ds: xr.Dataset,
        var_name: str,
        lat: float,
        lon: float,
        time: datetime,
    ) -> Optional[float]:
        """
        Interpolate a variable at given location and time.

        Uses linear interpolation with nearest-neighbor fallback.
        Returns None if out of bounds or on NaN.
        """
        try:
            lat_coord, lon_coord, time_coord = self._get_coord_names(ds)

            # Use a naive datetime to avoid xarray dtype issues with np.datetime64.
            if time.tzinfo is not None:
                time = time.replace(tzinfo=None)
            time_value = time

            # Get variable
            var = ds[var_name]

            # Check if depth dimension exists and select surface
            if "depth" in var.dims:
                var = var.isel(depth=0)

            # Interpolate
            try:
                result = var.interp(
                    {lat_coord: lat, lon_coord: lon, time_coord: time_value},
                    method="linear",
                )
                value = float(result.values)
                if not np.isnan(value):
                    return value
            except (KeyError, ValueError, ImportError, TypeError):
                pass

            # Fall back to nearest neighbor (avoids scipy dependency/out-of-range NaNs).
            result = var.sel(
                {lat_coord: lat, lon_coord: lon, time_coord: time_value},
                method="nearest",
            )
            value = float(result.values)
            if np.isnan(value):
                return None
            return value

        except Exception as e:
            logger.debug("Interpolation failed for %s: %s", var_name, e)
            return None

    def _interpolate_variable_batch(
        self,
        ds: xr.Dataset,
        var_name: str,
        lats: np.ndarray,
        lons: np.ndarray,
        times: np.ndarray,
    ) -> np.ndarray:
        """
        Interpolate a variable for multiple points (vectorized).

        Args:
            lats: Array of latitudes
            lons: Array of longitudes
            times: Array of timestamps (seconds since epoch)

        Returns:
            Array of interpolated values (NaN where missing)
        """
        try:
            import xarray as xr
            import numpy as np

            lat_coord, lon_coord, time_coord = self._get_coord_names(ds)

            lats = np.asarray(lats).reshape(-1)
            lons = np.asarray(lons).reshape(-1)
            times = np.asarray(times).reshape(-1)
            if not (lats.shape == lons.shape == times.shape):
                logger.debug(
                    "Batch interpolation input mismatch for %s: lats=%s lons=%s times=%s",
                    var_name,
                    lats.shape,
                    lons.shape,
                    times.shape,
                )
                return np.full_like(lats, np.nan)

            if INTERP_BATCH_SIZE > 0 and lats.size > INTERP_BATCH_SIZE:
                output = np.full_like(lats, np.nan, dtype=float)
                for start in range(0, lats.size, INTERP_BATCH_SIZE):
                    end = start + INTERP_BATCH_SIZE
                    output[start:end] = self._interpolate_variable_batch(
                        ds,
                        var_name,
                        lats[start:end],
                        lons[start:end],
                        times[start:end],
                    )
                return output

            # Convert timestamps to datetime64[ns] for xarray (silences precision warnings)
            times_dt = self._to_datetime64ns(times)

            # Get variable
            var = ds[var_name]

            # Check if depth dimension exists and select surface
            if "depth" in var.dims:
                var = var.isel(depth=0)

            # Create xarray DataArrays for the query points
            # This triggers advanced indexing / vectorized interpolation
            lat_da = xr.DataArray(lats, dims="point")
            lon_da = xr.DataArray(lons, dims="point")
            time_da = xr.DataArray(times_dt, dims="point")

            use_linear = os.getenv("DEEPWEATHER_INTERP_NEAREST_ONLY") != "1"

            if use_linear:
                try:
                    result = var.interp(
                        {lat_coord: lat_da, lon_coord: lon_da, time_coord: time_da},
                        method="linear",
                    )
                    # Accept ONLY a truly pointwise result. Some xarray
                    # versions fall back to orthogonal interpolation and
                    # return a broadcast grid; when that grid's size happens
                    # to equal the point count, a reshape(-1) would pass a
                    # size check while pairing every point with an unrelated
                    # raveled-grid value.
                    values = np.asarray(result.values)
                    if result.dims == ("point",) and values.shape == lats.shape:
                        return self._normalize_batch_result(values, lats, var_name)
                    # Broadcast grid or unexpected dims: fall back to nearest.
                except (KeyError, ValueError, ImportError, TypeError):
                    # Fallback to nearest if linear fails (e.g. boundary issues)
                    pass

            try:
                lat_values = np.asarray(ds[lat_coord].values)
                lon_values = np.asarray(ds[lon_coord].values)
                time_values = np.asarray(ds[time_coord].values)
                time_targets = (
                    times_dt
                    if np.issubdtype(time_values.dtype, np.datetime64)
                    else times
                )

                lat_idx = self._nearest_indices(lat_values, lats)
                lon_idx = self._nearest_indices(lon_values, lons)
                time_idx = self._nearest_indices(time_values, time_targets)

                result = var.isel(
                    {
                        lat_coord: xr.DataArray(lat_idx, dims="point"),
                        lon_coord: xr.DataArray(lon_idx, dims="point"),
                        time_coord: xr.DataArray(time_idx, dims="point"),
                    }
                )
                return self._normalize_batch_result(result.values, lats, var_name)
            except Exception:
                result = var.sel(
                    {lat_coord: lat_da, lon_coord: lon_da, time_coord: time_da},
                    method="nearest",
                )
                return self._normalize_batch_result(result.values, lats, var_name)

        except Exception as e:
            logger.debug("Batch interpolation failed for %s: %s", var_name, e)
            return np.full_like(lats, np.nan)

    @staticmethod
    def _normalize_batch_result(
        values: np.ndarray, lats: np.ndarray, var_name: str
    ) -> np.ndarray:
        arr = np.asarray(values)
        if arr.shape == lats.shape:
            return arr
        flat = arr.reshape(-1)
        if flat.shape == lats.shape:
            return flat
        logger.debug(
            "Batch interpolation output shape mismatch for %s: got %s expected %s",
            var_name,
            arr.shape,
            lats.shape,
        )
        return np.full_like(lats, np.nan)

    @staticmethod
    def _nearest_indices(coord_values: np.ndarray, targets: np.ndarray) -> np.ndarray:
        values = np.asarray(coord_values)
        targets_arr = np.asarray(targets)
        if values.size <= 1:
            return np.zeros_like(targets_arr, dtype=int)
        ascending = values[0] < values[-1]
        if not ascending:
            values = values[::-1]
        idx = np.searchsorted(values, targets_arr, side="left")
        idx = np.clip(idx, 1, values.size - 1)
        left = values[idx - 1]
        right = values[idx]
        idx -= (targets_arr - left) <= (right - targets_arr)
        if not ascending:
            idx = values.size - 1 - idx
        return idx.astype(int)

    @staticmethod
    def _to_datetime64ns(times: np.ndarray) -> np.ndarray:
        arr = np.asarray(times)
        if np.issubdtype(arr.dtype, np.datetime64):
            return arr.astype("datetime64[ns]")
        return arr.astype("datetime64[s]").astype("datetime64[ns]")

    def get_current(
        self, lat: float, lon: float, time: datetime
    ) -> Optional[Tuple[float, float]]:
        """
        Get interpolated current at location and time.

        Args:
            lat: Latitude in degrees
            lon: Longitude in degrees
            time: Datetime (UTC)

        Returns:
            Tuple (u, v) in m/s where u=eastward, v=northward, or None if unavailable
        """
        if not self.has_currents or self._currents_ds is None:
            return None

        # Regional models use uo, vo for surface currents
        uo = self._interpolate_variable(self._currents_ds, "uo", lat, lon, time)
        vo = self._interpolate_variable(self._currents_ds, "vo", lat, lon, time)

        if uo is None or vo is None:
            return None

        return (uo, vo)

    def get_current_batch(
        self, lats: np.ndarray, lons: np.ndarray, times: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Get interpolated current for multiple points with coastal gap fill.

        Uses bilinear interpolation for current data, then fills NaN values
        (typically near coast due to land masking) using nearest wet cell lookup.

        Args:
            lats: Array of latitudes
            lons: Array of longitudes
            times: Array of timestamps (seconds since epoch)

        Returns:
            Tuple (u_array, v_array) in m/s. NaNs only where beyond fill threshold.
        """
        if not self.has_currents or self._currents_ds is None:
            nan = np.full_like(lats, np.nan)
            return nan, nan

        uo = self._interpolate_variable_batch(
            self._currents_ds, "uo", lats, lons, times
        )
        vo = self._interpolate_variable_batch(
            self._currents_ds, "vo", lats, lons, times
        )

        # Apply coastal gap fill for NaN values
        if self.has_coastal_fill:
            uo, vo = self._fill_coastal_gaps(uo, vo, lats, lons, times)

        return uo, vo

    def _sample_wet_cells_nearest(
        self,
        var_name: str,
        lats: np.ndarray,
        lons: np.ndarray,
        times: np.ndarray,
    ) -> np.ndarray:
        """
        Sample variable values at wet cell locations using pure nearest-neighbor.

        Unlike _interpolate_variable_batch which uses linear interpolation (and can
        return NaN near land-masked cells), this method uses pure nearest-neighbor
        selection which is appropriate for coastal gap filling.

        Args:
            var_name: Variable name ('uo' or 'vo')
            lats, lons: Wet cell coordinates
            times: Timestamps (seconds since epoch)

        Returns:
            Array of sampled values
        """
        try:
            import xarray as xr

            if self._currents_ds is None:
                return np.full(len(lats), np.nan)
            lat_coord, lon_coord, time_coord = self._get_coord_names(self._currents_ds)

            # Convert timestamps to datetime64[ns] for xarray (silences precision warnings)
            times_dt = self._to_datetime64ns(times)

            # Get variable
            var = self._currents_ds[var_name]

            # Check if depth dimension exists and select surface
            if "depth" in var.dims:
                var = var.isel(depth=0)

            # Use pure nearest-neighbor selection (not interpolation)
            lat_da = xr.DataArray(lats, dims="point")
            lon_da = xr.DataArray(lons, dims="point")
            time_da = xr.DataArray(times_dt, dims="point")

            result = var.sel(
                {lat_coord: lat_da, lon_coord: lon_da, time_coord: time_da},
                method="nearest",
            )
            return result.values

        except Exception as e:
            logger.debug("Nearest sampling failed for %s: %s", var_name, e)
            return np.full_like(lats, np.nan)

    def _fill_coastal_gaps(
        self,
        uo: np.ndarray,
        vo: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        times: np.ndarray,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Fill NaN current values using nearest wet cell lookup.

        For points where interpolation returned NaN (typically near coast due to
        land masking), finds the nearest wet cell and samples that cell's current
        at the same timestamp using nearest-neighbor selection.

        Args:
            uo, vo: Current component arrays with potential NaNs
            lats, lons: Query point coordinates
            times: Query point timestamps (seconds since epoch)

        Returns:
            Updated (uo, vo) arrays with gaps filled where possible.
        """
        # Identify NaN points
        nan_mask = np.isnan(uo) | np.isnan(vo)
        raw_valid = ~nan_mask

        # Track metrics
        self._coastal_fill_metrics.points_raw += int(np.count_nonzero(raw_valid))

        if not nan_mask.any():
            # No gaps to fill
            return uo, vo

        if self._wet_kdtree is None:
            # No wet cell index available
            self._coastal_fill_metrics.points_unfilled += int(
                np.count_nonzero(nan_mask)
            )
            return uo, vo

        if self._wet_lats is None or self._wet_lons is None:
            self._coastal_fill_metrics.points_unfilled += int(
                np.count_nonzero(nan_mask)
            )
            return uo, vo

        # Get indices of NaN points
        nan_indices = np.where(nan_mask)[0]

        # Query KDTree for nearest wet cells
        query_lats = lats[nan_indices]
        query_lons = lons[nan_indices]
        query_times = times[nan_indices]

        # Scale longitude for distance calculation
        query_coords = np.column_stack([query_lats, query_lons * self._lon_scale])
        distances, nearest_idx = self._wet_kdtree.query(query_coords)

        # Convert tree distance to approximate km
        # 1 degree latitude ~ 111 km
        distances_km = distances * 111.0

        # Fill values within threshold
        fill_mask = distances_km <= MAX_FILL_DISTANCE_KM

        if fill_mask.any():
            fill_indices = nan_indices[fill_mask]
            wet_indices = nearest_idx[fill_mask]
            fill_times = query_times[fill_mask]
            fill_distances = distances_km[fill_mask]

            # Get wet cell coordinates
            wet_lats = self._wet_lats[wet_indices]
            wet_lons = self._wet_lons[wet_indices]

            # Sample currents at wet cell locations using nearest-neighbor
            # (linear interpolation would return NaN due to adjacent masked cells)
            filled_uo = self._sample_wet_cells_nearest(
                "uo", wet_lats, wet_lons, fill_times
            )
            filled_vo = self._sample_wet_cells_nearest(
                "vo", wet_lats, wet_lons, fill_times
            )

            # Apply fills where we got valid values
            valid_fills = np.isfinite(filled_uo) & np.isfinite(filled_vo)
            actual_fill_indices = fill_indices[valid_fills]
            actual_distances = fill_distances[valid_fills]

            uo[actual_fill_indices] = filled_uo[valid_fills]
            vo[actual_fill_indices] = filled_vo[valid_fills]

            # Update metrics
            self._coastal_fill_metrics.points_filled += len(actual_fill_indices)
            self._coastal_fill_metrics.fill_distances_km.extend(
                actual_distances.tolist()
            )

            # Count unfilled (beyond threshold or failed lookup)
            unfilled_count = len(nan_indices) - len(actual_fill_indices)
            self._coastal_fill_metrics.points_unfilled += unfilled_count
        else:
            # All NaN points are beyond threshold
            self._coastal_fill_metrics.points_unfilled += len(nan_indices)

        return uo, vo

    def get_current_polar(
        self, lat: float, lon: float, time: datetime
    ) -> Optional[Tuple[float, float]]:
        """
        Get current as speed and direction.

        Args:
            lat: Latitude in degrees
            lon: Longitude in degrees
            time: Datetime (UTC)

        Returns:
            Tuple (speed in knots, direction in degrees towards) or None
        """
        uv = self.get_current(lat, lon, time)
        if uv is None:
            return None

        u, v = uv
        speed = math.sqrt(u**2 + v**2) * MS_TO_KNOTS
        # Direction the current is flowing TOWARDS (oceanographic convention)
        direction = (90 - math.degrees(math.atan2(v, u))) % 360

        return (speed, direction)

    def close(self):
        """Close any open datasets."""
        if self._currents_ds is not None:
            self._currents_ds.close()
            self._currents_ds = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


__all__ = ["EnvironmentGrid", "CoastalFillMetrics", "MAX_FILL_DISTANCE_KM"]
