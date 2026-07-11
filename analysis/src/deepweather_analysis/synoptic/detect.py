"""Pressure-system detection on a single 2-D MSLP field (hPa). Pure NumPy/SciPy.

Method (v0):
- candidate extrema via scipy.ndimage minimum/maximum_filter over a ~7.5 deg
  neighbourhood;
- closed-contour test: the extremum must be enclosed by the level
  center +/- CONTOUR_DELTA_HPA (2 hPa) inside a CONTOUR_BOX_DEG (15 deg) box
  without the enclosing region touching the box edge (connected-component
  labelling on the thresholded mask);
- prominence: the deepest delta whose contour still closes inside the box;
  extrema weaker than MIN_PROMINENCE_HPA (3 hPa) are discarded;
- edge guard: no detection on the outermost EDGE_GUARD_CELLS (2) cells.
"""

from __future__ import annotations

from typing import Dict, List

import numpy as np
from scipy import ndimage

# v0 thresholds — calibrate at corpus time.
NEIGHBORHOOD_DEG = 7.5
CONTOUR_DELTA_HPA = 2.0
CONTOUR_BOX_DEG = 15.0
MIN_PROMINENCE_HPA = 3.0
EDGE_GUARD_CELLS = 2
_PROMINENCE_STEP_HPA = 0.5
_PROMINENCE_CAP_HPA = 60.0


def _grid_step_deg(axis: np.ndarray, name: str) -> float:
    if axis.size < 2:
        raise ValueError(f"{name} axis needs at least 2 points")
    step = float(np.median(np.abs(np.diff(axis))))
    if step <= 0:
        raise ValueError(f"{name} axis is degenerate")
    return step


def _odd_cells(deg: float, step_deg: float) -> int:
    n = max(3, int(round(deg / step_deg)))
    return n if n % 2 == 1 else n + 1


def _closed_within_box(
    field: np.ndarray, i: int, j: int, delta: float, half_cells_i: int, half_cells_j: int, sign: int
) -> bool:
    """True if the (center + sign*delta) region around (i, j) closes inside the box.

    sign=+1 for lows (mask = field < center + delta), -1 for highs.
    The box is clipped at the domain edge; a region touching the clipped box
    edge counts as open (conservative near the domain boundary).
    """
    ny, nx = field.shape
    i0, i1 = max(0, i - half_cells_i), min(ny, i + half_cells_i + 1)
    j0, j1 = max(0, j - half_cells_j), min(nx, j + half_cells_j + 1)
    box = field[i0:i1, j0:j1]
    center = field[i, j]
    mask = (box < center + delta) if sign > 0 else (box > center - delta)
    labels, _ = ndimage.label(mask)
    lab = labels[i - i0, j - j0]
    if lab == 0:
        return False
    region = labels == lab
    return not (
        region[0, :].any() or region[-1, :].any() or region[:, 0].any() or region[:, -1].any()
    )


def _prominence(
    field: np.ndarray, i: int, j: int, half_cells_i: int, half_cells_j: int, sign: int
) -> float:
    """Largest delta (hPa) whose contour still closes inside the box; 0 if none."""
    prominence = 0.0
    delta = _PROMINENCE_STEP_HPA
    while delta <= _PROMINENCE_CAP_HPA:
        if not _closed_within_box(field, i, j, delta, half_cells_i, half_cells_j, sign):
            break
        prominence = delta
        delta += _PROMINENCE_STEP_HPA
    return prominence


def detect_systems(
    mslp2d: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    *,
    neighborhood_deg: float = NEIGHBORHOOD_DEG,
    min_prominence_hpa: float = MIN_PROMINENCE_HPA,
    contour_delta_hpa: float = CONTOUR_DELTA_HPA,
    contour_box_deg: float = CONTOUR_BOX_DEG,
    edge_guard_cells: int = EDGE_GUARD_CELLS,
) -> List[Dict]:
    """
    Detect pressure lows/highs on one 2-D MSLP field.

    Args:
        mslp2d: (nlat, nlon) MSLP in hPa
        lats, lons: 1-D coordinate axes matching mslp2d

    Returns:
        list of {kind: "low"|"high", lat, lon, center_hpa, closed_contour},
        lows deepest-first then highs strongest-first.
    """
    field = np.asarray(mslp2d, dtype=float)
    lats = np.asarray(lats, dtype=float).reshape(-1)
    lons = np.asarray(lons, dtype=float).reshape(-1)
    if field.shape != (lats.size, lons.size):
        raise ValueError(f"mslp2d shape {field.shape} != (nlat={lats.size}, nlon={lons.size})")

    dlat = _grid_step_deg(lats, "latitude")
    dlon = _grid_step_deg(lons, "longitude")
    n_lat = _odd_cells(neighborhood_deg, dlat)
    n_lon = _odd_cells(neighborhood_deg, dlon)
    half_box_i = max(1, int(round((contour_box_deg / 2.0) / dlat)))
    half_box_j = max(1, int(round((contour_box_deg / 2.0) / dlon)))

    results: List[Dict] = []
    for kind, sign, extremum in (
        ("low", +1, ndimage.minimum_filter(field, size=(n_lat, n_lon), mode="nearest")),
        ("high", -1, ndimage.maximum_filter(field, size=(n_lat, n_lon), mode="nearest")),
    ):
        # Cheap relief pre-filter: within its own neighbourhood the extremum
        # must stand out by at least the minimum prominence (kills flat
        # fields/plateaus before the per-candidate contour work).
        opposite = (
            ndimage.maximum_filter(field, size=(n_lat, n_lon), mode="nearest")
            if sign > 0
            else ndimage.minimum_filter(field, size=(n_lat, n_lon), mode="nearest")
        )
        relief = sign * (opposite - field)
        candidate = (field == extremum) & (relief >= min_prominence_hpa)

        # Edge guard: no detection on the outermost cells.
        g = edge_guard_cells
        if g > 0:
            candidate[:g, :] = False
            candidate[-g:, :] = False
            candidate[:, :g] = False
            candidate[:, -g:] = False

        idx_i, idx_j = np.nonzero(candidate)
        # Deepest/strongest first so plateau/nearby duplicates keep the best.
        order = np.argsort(sign * field[idx_i, idx_j])
        kept: List[tuple[int, int]] = []
        for k in order:
            i, j = int(idx_i[k]), int(idx_j[k])
            # Suppress duplicates within one neighbourhood radius.
            if any(
                abs(i - pi) * dlat < neighborhood_deg and abs(j - pj) * dlon < neighborhood_deg
                for pi, pj in kept
            ):
                continue
            prominence = _prominence(field, i, j, half_box_i, half_box_j, sign)
            if prominence < min_prominence_hpa:
                continue
            closed = _closed_within_box(field, i, j, contour_delta_hpa, half_box_i, half_box_j, sign)
            kept.append((i, j))
            results.append(
                {
                    "kind": kind,
                    "lat": float(lats[i]),
                    "lon": float(lons[j]),
                    "center_hpa": round(float(field[i, j]), 1),
                    "closed_contour": bool(closed),
                }
            )
    return results


__all__ = [
    "detect_systems",
    "NEIGHBORHOOD_DEG",
    "CONTOUR_DELTA_HPA",
    "CONTOUR_BOX_DEG",
    "MIN_PROMINENCE_HPA",
    "EDGE_GUARD_CELLS",
]
