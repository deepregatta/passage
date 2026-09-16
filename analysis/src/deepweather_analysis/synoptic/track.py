"""Pressure-system tracking across forecast steps. Pure.

Greedy nearest-neighbour association step-to-step, kind-consistent, with a
maximum-displacement gate (default 6 deg per 3 h ~ 40 kt motion). Tracks not
matched at a step terminate (no coasting through gaps, v0). Tracks shorter
than 2 steps are dropped.

Derived per track:
- deepening_hpa_per_24h: linear central-pressure trend scaled to 24 h,
  SIGNED (negative = pressure falling = a low deepening / a high collapsing).
- motion: {dir_deg, speed_kt} from the last two positions (dir_deg = heading
  the system is moving TOWARD, 0 = north, 90 = east).

Ids: L1/L2/... lows ordered by minimum central pressure (deepest first),
H1/H2/... highs by maximum central pressure (strongest first).
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence

import numpy as np

from ..geo import separation_deg

# 6 deg per 3 h step ~ 40 kt system motion.
MAX_DISPLACEMENT_DEG_PER_3H = 6.0
MIN_TRACK_STEPS = 2
NM_PER_DEG = 60.0


def _sep_deg(a: Dict, b: Dict) -> float:
    """Separation in degrees, longitude scaled by cos(mean lat)."""
    return separation_deg(a["lat"], a["lon"], b["lat"], b["lon"])


def _motion(p_prev: Dict, p_last: Dict, dt_h: float) -> Dict | None:
    """{dir_deg, speed_kt} from two consecutive track points."""
    if dt_h <= 0:
        return None
    coslat = math.cos(math.radians(0.5 * (p_prev["lat"] + p_last["lat"])))
    dx_nm = (p_last["lon"] - p_prev["lon"]) * coslat * NM_PER_DEG
    dy_nm = (p_last["lat"] - p_prev["lat"]) * NM_PER_DEG
    speed_kt = math.hypot(dx_nm, dy_nm) / dt_h
    dir_deg = math.degrees(math.atan2(dx_nm, dy_nm)) % 360.0
    return {"dir_deg": round(dir_deg, 0), "speed_kt": round(speed_kt, 1)}


def _deepening(points: List[Dict], step_hours: Sequence[float]) -> float | None:
    """Linear central-pressure trend (hPa per 24 h), signed."""
    if len(points) < 2:
        return None
    hours = np.array([step_hours[p["step_idx"]] for p in points], dtype=float)
    pressures = np.array([p["center_hpa"] for p in points], dtype=float)
    slope_per_h = float(np.polyfit(hours, pressures, 1)[0])
    return round(slope_per_h * 24.0, 1)


def track_systems(
    per_step_detections: Sequence[Sequence[Dict]],
    step_hours: Sequence[float],
    *,
    max_displacement_deg_per_3h: float = MAX_DISPLACEMENT_DEG_PER_3H,
    min_track_steps: int = MIN_TRACK_STEPS,
) -> List[Dict]:
    """
    Associate per-step detections into system tracks.

    Args:
        per_step_detections: detect_systems output per forecast step
        step_hours: forecast hour of each step (same length)

    Returns:
        list of {system_id, kind, track: [{step_h, lat, lon, center_hpa,
        closed_contour}], deepening_hpa_per_24h, motion}
    """
    if len(per_step_detections) != len(step_hours):
        raise ValueError(
            f"{len(per_step_detections)} detection steps != {len(step_hours)} step hours"
        )

    tracks: List[Dict] = []  # {kind, points: [{step_idx, **det}], open: bool}
    for t, detections in enumerate(per_step_detections):
        detections = list(detections)
        if t == 0:
            for det in detections:
                tracks.append(
                    {"kind": det["kind"], "points": [{"step_idx": 0, **det}], "open": True}
                )
            continue

        dt_h = float(step_hours[t] - step_hours[t - 1])
        gate_deg = max_displacement_deg_per_3h * (dt_h / 3.0)

        # Only tracks whose last point is at the previous step may continue.
        active = [tr for tr in tracks if tr["open"] and tr["points"][-1]["step_idx"] == t - 1]
        # Greedy: all (track, detection) pairs of matching kind, nearest first.
        pairs = []
        for ti, tr in enumerate(active):
            last = tr["points"][-1]
            for di, det in enumerate(detections):
                if det["kind"] != tr["kind"]:
                    continue
                d = _sep_deg(last, det)
                if d <= gate_deg:
                    pairs.append((d, ti, di))
        pairs.sort(key=lambda p: p[0])
        used_tracks: set[int] = set()
        used_dets: set[int] = set()
        for d, ti, di in pairs:
            if ti in used_tracks or di in used_dets:
                continue
            active[ti]["points"].append({"step_idx": t, **detections[di]})
            used_tracks.add(ti)
            used_dets.add(di)

        # Unmatched active tracks terminate; unmatched detections start fresh.
        for ti, tr in enumerate(active):
            if ti not in used_tracks:
                tr["open"] = False
        for di, det in enumerate(detections):
            if di not in used_dets:
                tracks.append(
                    {"kind": det["kind"], "points": [{"step_idx": t, **det}], "open": True}
                )

    survivors = [tr for tr in tracks if len(tr["points"]) >= min_track_steps]

    def _rank(tr: Dict) -> float:
        pressures = [p["center_hpa"] for p in tr["points"]]
        return min(pressures) if tr["kind"] == "low" else -max(pressures)

    results: List[Dict] = []
    for kind, prefix in (("low", "L"), ("high", "H")):
        of_kind = sorted((tr for tr in survivors if tr["kind"] == kind), key=_rank)
        for n, tr in enumerate(of_kind, start=1):
            points = tr["points"]
            track = [
                {
                    "step_h": step_hours[p["step_idx"]],
                    "lat": p["lat"],
                    "lon": p["lon"],
                    "center_hpa": p["center_hpa"],
                    "closed_contour": p["closed_contour"],
                }
                for p in points
            ]
            dt_last = float(step_hours[points[-1]["step_idx"]] - step_hours[points[-2]["step_idx"]])
            results.append(
                {
                    "system_id": f"{prefix}{n}",
                    "kind": kind,
                    "track": track,
                    "deepening_hpa_per_24h": _deepening(points, step_hours),
                    "motion": _motion(points[-2], points[-1], dt_last),
                }
            )
    return results


__all__ = ["track_systems", "MAX_DISPLACEMENT_DEG_PER_3H", "MIN_TRACK_STEPS"]
