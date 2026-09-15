"""Factory unit conventions; keep rounding at each artifact's boundary."""

from typing import TYPE_CHECKING, TypeVar

import numpy as np

if TYPE_CHECKING:
    import xarray as xr

# Preserve the established precision in prepared grids, regimes and observations.
MS_TO_KNOTS = 1.9438445

PressureField = TypeVar("PressureField", np.ndarray, "xr.DataArray")


def mslp_hpa(values: PressureField) -> PressureField:
    """Tolerate legacy Pa fields using the existing mean > 10000 heuristic.

    Preserve the input array/DataArray type and dtype, and never mutate it.
    Callers keep their own float coercion and xarray metadata policy. Cached
    ECMWF fields are hPa; raw external/test datasets may still arrive in Pa.
    """
    if np.nanmean(values) > 10000.0:
        return values / 100.0
    return values
