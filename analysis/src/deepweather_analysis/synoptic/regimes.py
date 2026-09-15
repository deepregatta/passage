"""Named regional regime pattern rules. Pure.

These are gradient-wind events detected from pressure patterns — NOT
convection. v0 ships one combined Mistral/Tramontane detector; thresholds
are v0 values to calibrate at corpus time.

Rule R-MISTRAL-01:
  ridge/high over the Bay of Biscay (area-mean MSLP >= 1020 hPa over
  43-47N, 8W-2W) AND low over the Gulf of Genoa (area-mean <= 1012 hPa over
  42-45N, 7-11E) AND mean 10 m wind over the Gulf of Lion (41.5-43.5N, 3-6E)
  from the NW quadrant (direction-from 280-360 deg) at >= 18 kt
  -> "mistral"; labelled "tramontane" instead when the mean direction is
  290-340 deg AND the westerly (u) component over the Tramontane corridor
  (42.5-43.5N, 2.5-4E) exceeds the Gulf of Lion mean u — i.e. the flow is
  channelling west of the Rhone valley.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

import numpy as np

from ..units import MS_TO_KNOTS

RULE_ID = "R-MISTRAL-01"

# Boxes: (min_lat, max_lat, min_lon, max_lon)
BISCAY_BOX = (43.0, 47.0, -8.0, -2.0)
GENOA_BOX = (42.0, 45.0, 7.0, 11.0)
LION_BOX = (41.5, 43.5, 3.0, 6.0)
TRAMONTANE_BOX = (42.5, 43.5, 2.5, 4.0)

# v0 thresholds — calibrate at corpus time.
BISCAY_HIGH_MIN_HPA = 1020.0
GENOA_LOW_MAX_HPA = 1012.0
LION_WIND_MIN_KT = 18.0
MISTRAL_DIR_RANGE = (280.0, 360.0)
TRAMONTANE_DIR_RANGE = (290.0, 340.0)

_MIN_BOX_CELLS = 4


def _box_mask(lats: np.ndarray, lons: np.ndarray, box) -> tuple[np.ndarray, np.ndarray]:
    min_lat, max_lat, min_lon, max_lon = box
    ii = np.nonzero((lats >= min_lat) & (lats <= max_lat))[0]
    jj = np.nonzero((lons >= min_lon) & (lons <= max_lon))[0]
    return ii, jj


def _box_mean(field: np.ndarray, lats: np.ndarray, lons: np.ndarray, box) -> Optional[float]:
    ii, jj = _box_mask(lats, lons, box)
    if ii.size * jj.size < _MIN_BOX_CELLS:
        return None
    values = field[np.ix_(ii, jj)]
    if np.isnan(values).all():
        return None
    mean = float(np.nanmean(values))
    return mean if np.isfinite(mean) else None


def _dir_from_deg(u_mean: float, v_mean: float) -> float:
    """Meteorological direction the wind blows FROM (0 = N, 90 = E)."""
    return math.degrees(math.atan2(-u_mean, -v_mean)) % 360.0


def detect_mistral(
    mslp2d: np.ndarray,
    u10: np.ndarray,
    v10: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
) -> Optional[Dict]:
    """
    Combined Mistral/Tramontane pattern rule on one analysis step.

    Args:
        mslp2d: (nlat, nlon) MSLP in hPa
        u10, v10: (nlat, nlon) 10 m wind components in m/s
        lats, lons: 1-D axes matching the fields

    Returns:
        None, or {regime_id: "mistral"|"tramontane", rule_id, pattern_evidence}.
        Returns None when any rule box falls outside the supplied grid.
    """
    mslp2d = np.asarray(mslp2d, dtype=float)
    u10 = np.asarray(u10, dtype=float)
    v10 = np.asarray(v10, dtype=float)
    lats = np.asarray(lats, dtype=float).reshape(-1)
    lons = np.asarray(lons, dtype=float).reshape(-1)

    biscay_hpa = _box_mean(mslp2d, lats, lons, BISCAY_BOX)
    genoa_hpa = _box_mean(mslp2d, lats, lons, GENOA_BOX)
    if biscay_hpa is None or genoa_hpa is None:
        return None
    if biscay_hpa < BISCAY_HIGH_MIN_HPA or genoa_hpa > GENOA_LOW_MAX_HPA:
        return None

    ii, jj = _box_mask(lats, lons, LION_BOX)
    if ii.size * jj.size < _MIN_BOX_CELLS:
        return None
    lion_u = u10[np.ix_(ii, jj)]
    lion_v = v10[np.ix_(ii, jj)]
    # Strength: mean of per-cell speed; direction: direction of the mean vector.
    speed_kt = float(np.nanmean(np.hypot(lion_u, lion_v))) * MS_TO_KNOTS
    u_mean = float(np.nanmean(lion_u))
    v_mean = float(np.nanmean(lion_v))
    dir_from = _dir_from_deg(u_mean, v_mean)

    if speed_kt < LION_WIND_MIN_KT:
        return None
    if not (MISTRAL_DIR_RANGE[0] <= dir_from <= MISTRAL_DIR_RANGE[1]):
        return None

    regime_id = "mistral"
    tram_u = _box_mean(u10, lats, lons, TRAMONTANE_BOX)
    if (
        TRAMONTANE_DIR_RANGE[0] <= dir_from <= TRAMONTANE_DIR_RANGE[1]
        and tram_u is not None
        and tram_u > u_mean
    ):
        regime_id = "tramontane"

    return {
        "regime_id": regime_id,
        "rule_id": RULE_ID,
        "pattern_evidence": {
            "biscay_mean_mslp_hpa": round(biscay_hpa, 1),
            "genoa_mean_mslp_hpa": round(genoa_hpa, 1),
            "lion_mean_wind_kt": round(speed_kt, 1),
            "lion_mean_dir_from_deg": round(dir_from, 0),
            "tramontane_corridor_mean_u_ms": None if tram_u is None else round(tram_u, 2),
            "thresholds_v0": {
                "biscay_high_min_hpa": BISCAY_HIGH_MIN_HPA,
                "genoa_low_max_hpa": GENOA_LOW_MAX_HPA,
                "lion_wind_min_kt": LION_WIND_MIN_KT,
                "mistral_dir_from_deg": list(MISTRAL_DIR_RANGE),
                "tramontane_dir_from_deg": list(TRAMONTANE_DIR_RANGE),
            },
        },
    }


__all__ = [
    "detect_mistral",
    "RULE_ID",
    "BISCAY_BOX",
    "GENOA_BOX",
    "LION_BOX",
    "TRAMONTANE_BOX",
]
