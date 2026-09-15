"""Synoptic chart rendering: MSLP panels with system markers and tracks.

Chart-paper style: #F3EEE3 background, #16283E ink isobars (4 hPa spacing,
labelled every 8), lows marked in red #A63B2A, highs in ink. Coastlines are
drawn from global-land-mask when that package is available and skipped
otherwise (no cartopy dependency). PNGs are ~1200x900 px, named t000.png,
t024.png, ...

Captions are templated from detected facts and teach as they go, e.g.:
"T+24: low L1 (983 hPa) south of Iceland, deepening 6 hPa/24h, moving ENE
22 kt. Tighter isobar spacing over the western Channel means stronger wind."
Cautious language throughout — no front types are ever named.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np

from ..units import mslp_hpa

PAPER = "#F3EEE3"
INK = "#16283E"
RED = "#A63B2A"

FIG_W_PX, FIG_H_PX, DPI = 1200, 900, 100

ISOBAR_STEP_HPA = 4
ISOBAR_LABEL_EVERY_HPA = 8

# Anchors for plain-language positions ("south of Iceland", "over Biscay").
_ANCHORS = [
    ("Iceland", 64.9, -19.0),
    ("the Faroes", 62.0, -7.0),
    ("Scotland", 57.0, -4.5),
    ("Ireland", 53.4, -8.0),
    ("the Irish Sea", 53.5, -5.0),
    ("the North Sea", 56.0, 3.0),
    ("the western Channel", 49.8, -4.5),
    ("Brittany", 48.2, -3.5),
    ("the Bay of Biscay", 45.0, -4.0),
    ("Iberia", 40.0, -4.5),
    ("the Azores", 38.5, -28.0),
    ("the Gulf of Lion", 42.5, 4.5),
    ("the Gulf of Genoa", 43.5, 9.0),
    ("the mid-Atlantic", 50.0, -30.0),
]

# Regions scanned for the strongest pressure gradient (the teaching line).
_GRADIENT_REGIONS = [
    ("the western Channel", 49.0, 51.0, -6.5, -1.0),
    ("the eastern Channel", 49.5, 51.5, -1.0, 2.0),
    ("the Irish Sea", 52.0, 55.0, -7.0, -3.0),
    ("the Bay of Biscay", 43.5, 47.5, -8.0, -2.0),
    ("the North Sea", 53.0, 58.0, 0.0, 8.0),
    ("west of Ireland", 51.0, 55.0, -15.0, -10.0),
    ("the Gulf of Lion", 41.5, 43.5, 3.0, 6.0),
]

_COMPASS16 = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
]
_COMPASS8 = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
]


def _compass16(deg: float) -> str:
    return _COMPASS16[int(round(deg / 22.5)) % 16]


def _compass8(deg: float) -> str:
    return _COMPASS8[int(round(deg / 45.0)) % 8]


def _place_phrase(lat: float, lon: float) -> str:
    """Nearest-anchor description: 'over X' or '<direction> of X'."""
    best_name, best_d, best_bearing = None, float("inf"), 0.0
    for name, alat, alon in _ANCHORS:
        coslat = math.cos(math.radians(0.5 * (lat + alat)))
        dlat = lat - alat
        dlon = (lon - alon) * coslat
        d = math.hypot(dlat, dlon)
        if d < best_d:
            best_name, best_d = name, d
            best_bearing = math.degrees(math.atan2(dlon, dlat)) % 360.0
    if best_name is None:
        return f"near {abs(lat):.0f}N {abs(lon):.0f}{'W' if lon < 0 else 'E'}"
    if best_d < 3.0:
        return f"over {best_name}"
    return f"{_compass8(best_bearing)} of {best_name}"


def _trend_phrase(kind: str, deepening: Optional[float]) -> Optional[str]:
    """Signed pressure trend -> cautious wording (negative = falling)."""
    if deepening is None:
        return None
    if abs(deepening) < 1.0:
        return "steady"
    rate = abs(deepening)
    if kind == "low":
        verb = "deepening" if deepening < 0 else "filling"
    else:
        verb = "building" if deepening > 0 else "declining"
    return f"{verb} {rate:g} hPa/24h"


def _motion_phrase(motion: Optional[Dict]) -> Optional[str]:
    if not motion:
        return None
    speed = float(motion.get("speed_kt", 0.0))
    if speed < 3.0:
        return "quasi-stationary"
    return f"moving {_compass16(float(motion['dir_deg']))} {speed:.0f} kt"


def _system_sentence(system: Dict, point: Dict) -> str:
    parts = [
        f"{system['kind']} {system['system_id']} ({point['center_hpa']:.0f} hPa) "
        f"{_place_phrase(point['lat'], point['lon'])}"
    ]
    trend = _trend_phrase(system["kind"], system.get("deepening_hpa_per_24h"))
    if trend:
        parts.append(trend)
    motion = _motion_phrase(system.get("motion"))
    if motion:
        parts.append(motion)
    return ", ".join(parts)


def _strongest_gradient_region(
    mslp: np.ndarray, lats: np.ndarray, lons: np.ndarray
) -> Optional[str]:
    """Name of the scanned region with the tightest isobar spacing."""
    dlat_km = 111.0 * float(np.median(np.abs(np.diff(lats))))
    best_name, best_grad = None, -1.0
    for name, lat0, lat1, lon0, lon1 in _GRADIENT_REGIONS:
        ii = np.nonzero((lats >= lat0) & (lats <= lat1))[0]
        jj = np.nonzero((lons >= lon0) & (lons <= lon1))[0]
        if ii.size < 3 or jj.size < 3:
            continue
        sub = mslp[np.ix_(ii, jj)]
        sub_lats = lats[ii]
        dlon_km = (
            111.0
            * float(np.median(np.abs(np.diff(lons[jj]))))
            * math.cos(math.radians(float(np.mean(sub_lats))))
        )
        gy, gx = np.gradient(sub, dlat_km, dlon_km)
        grad = float(np.nanmean(np.hypot(gy, gx)))  # hPa/km
        if grad > best_grad:
            best_name, best_grad = name, grad
    return best_name


def _caption(step_h: int, systems: Sequence[Dict], mslp: np.ndarray, lats, lons) -> str:
    at_step: List[tuple[Dict, Dict]] = []
    for system in systems:
        point = next((p for p in system["track"] if p["step_h"] == step_h), None)
        if point is not None:
            at_step.append((system, point))

    # Lows deepest first, then highs strongest first; keep the caption sober.
    at_step.sort(
        key=lambda sp: (
            sp[0]["kind"] != "low",
            sp[1]["center_hpa"] * (1 if sp[0]["kind"] == "low" else -1),
        )
    )
    sentences = [_system_sentence(s, p) for s, p in at_step[:3]]
    body = "; ".join(sentences) if sentences else "no closed pressure centres in the window"

    caption = f"T+{step_h}: {body}."
    region = _strongest_gradient_region(mslp, lats, lons)
    if region:
        caption += f" Tighter isobar spacing over {region} means stronger wind there."
    return caption


def _draw_land(ax, lats: np.ndarray, lons: np.ndarray) -> None:
    """Light land tint via global-land-mask when available; else skip."""
    try:
        from global_land_mask import globe
    except ImportError:
        return
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    land = globe.is_land(lat_grid, lon_grid)
    ax.contourf(lons, lats, land.astype(float), levels=[0.5, 1.5], colors=["#E2D9C5"], zorder=0)
    ax.contour(
        lons,
        lats,
        land.astype(float),
        levels=[0.5],
        colors=[INK],
        linewidths=0.4,
        alpha=0.35,
        zorder=1,
    )


def _fmt_valid(valid: Optional[datetime]) -> str:
    if valid is None:
        return ""
    return valid.strftime("valid %a %d %b %HZ")


def render_panels(
    dataset,
    systems: Sequence[Dict],
    out_dir: str | Path,
    steps: Sequence[int] = (0, 24, 48, 72),
) -> List[Dict]:
    """
    Render one synoptic panel per requested forecast step.

    Args:
        dataset: xarray Dataset with msl (hPa; Pa auto-detected), coords
                 latitude/longitude ascending, step (int hours), and
                 optionally valid_time
        systems: track_systems output (step_h-keyed track points)
        out_dir: directory for the PNGs (created if needed)
        steps: forecast hours to render; hours absent from the dataset skip

    Returns:
        list of {step_h, file, caption} (file = absolute path as str).
    """
    # Import only when rendering, and attach a headless canvas directly so a
    # host application keeps its backend and any open pyplot figures.
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    lats = np.asarray(dataset["latitude"].values, dtype=float)
    lons = np.asarray(dataset["longitude"].values, dtype=float)
    available = [int(s) for s in np.asarray(dataset["step"].values).reshape(-1)]

    results: List[Dict] = []
    for step_h in steps:
        if step_h not in available:
            continue
        sel = dataset.sel(step=step_h)
        mslp = mslp_hpa(np.asarray(sel["msl"].values, dtype=float))

        valid: Optional[datetime] = None
        if "valid_time" in sel.coords:
            raw = np.datetime64(sel["valid_time"].values, "s").astype("int64")
            valid = datetime.fromtimestamp(int(raw), tz=timezone.utc)

        fig = Figure(figsize=(FIG_W_PX / DPI, FIG_H_PX / DPI), dpi=DPI)
        FigureCanvasAgg(fig)
        ax = fig.subplots()
        fig.patch.set_facecolor(PAPER)
        ax.set_facecolor(PAPER)

        _draw_land(ax, lats, lons)

        lo = math.floor(np.nanmin(mslp) / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA
        hi = math.ceil(np.nanmax(mslp) / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA
        levels = np.arange(lo, hi + ISOBAR_STEP_HPA, ISOBAR_STEP_HPA)
        contours = ax.contour(
            lons, lats, mslp, levels=levels, colors=[INK], linewidths=0.8, zorder=2
        )
        label_levels = [lv for lv in levels if lv % ISOBAR_LABEL_EVERY_HPA == 0]
        if label_levels:
            ax.clabel(contours, levels=label_levels, fmt="%d", fontsize=8, colors=[INK])

        for system in systems:
            color = RED if system["kind"] == "low" else INK
            past = [p for p in system["track"] if p["step_h"] <= step_h]
            if len(past) >= 2:
                ax.plot(
                    [p["lon"] for p in past],
                    [p["lat"] for p in past],
                    color=color,
                    linewidth=1.1,
                    linestyle="--",
                    alpha=0.65,
                    zorder=3,
                )
                ax.plot(
                    [p["lon"] for p in past[:-1]],
                    [p["lat"] for p in past[:-1]],
                    marker=".",
                    markersize=3,
                    linestyle="none",
                    color=color,
                    alpha=0.65,
                    zorder=3,
                )
            point = next((p for p in system["track"] if p["step_h"] == step_h), None)
            if point is not None:
                letter = "L" if system["kind"] == "low" else "H"
                ax.text(
                    point["lon"],
                    point["lat"],
                    letter,
                    color=color,
                    fontsize=22,
                    fontweight="bold",
                    ha="center",
                    va="center",
                    zorder=5,
                )
                ax.text(
                    point["lon"],
                    point["lat"] - 1.1,
                    f"{system['system_id']} {point['center_hpa']:.0f}",
                    color=color,
                    fontsize=8,
                    ha="center",
                    va="top",
                    zorder=5,
                )

        ax.set_xlim(float(lons.min()), float(lons.max()))
        ax.set_ylim(float(lats.min()), float(lats.max()))
        ax.set_xlabel("longitude", color=INK, fontsize=9)
        ax.set_ylabel("latitude", color=INK, fontsize=9)
        ax.tick_params(colors=INK, labelsize=8)
        for spine in ax.spines.values():
            spine.set_color(INK)
        ax.grid(True, color=INK, alpha=0.12, linewidth=0.5)
        title = f"MSLP (hPa) — T+{step_h}"
        subtitle = _fmt_valid(valid)
        ax.set_title(
            title + (f"   {subtitle}" if subtitle else ""),
            color=INK,
            fontsize=12,
            loc="left",
            pad=10,
        )
        fig.text(
            0.99,
            0.01,
            "ECMWF open data (CC-BY-4.0) — isobars every 4 hPa",
            color=INK,
            fontsize=7,
            alpha=0.7,
            ha="right",
        )

        # fixed canvas (no tight crop) so the axes' pixel geometry is exact and
        # publishable — the viewer overlays the per-user route client-side, which
        # keeps the prepared chart route-independent (shared across users)
        fig.tight_layout(rect=(0, 0.015, 1, 1))
        fig.canvas.draw()
        pos = ax.get_position()

        file_path = out_dir / f"t{step_h:03d}.png"
        fig.savefig(file_path, dpi=DPI, facecolor=PAPER)

        results.append(
            {
                "step_h": int(step_h),
                "file": str(file_path),
                "caption": _caption(step_h, systems, mslp, lats, lons),
                "size_px": {"w": int(FIG_W_PX), "h": int(FIG_H_PX)},
                "geo": {
                    "lon_min": float(lons.min()),
                    "lon_max": float(lons.max()),
                    "lat_min": float(lats.min()),
                    "lat_max": float(lats.max()),
                },
                # axes bbox in PNG pixel coordinates, y measured from the TOP edge
                "axes_px": {
                    "x0": round(pos.x0 * FIG_W_PX, 1),
                    "x1": round(pos.x1 * FIG_W_PX, 1),
                    "y0": round((1 - pos.y1) * FIG_H_PX, 1),
                    "y1": round((1 - pos.y0) * FIG_H_PX, 1),
                },
            }
        )
    return results


__all__ = ["render_panels", "PAPER", "INK", "RED"]
