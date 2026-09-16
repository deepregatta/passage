"""Synthetic scenario generator: coherent weather bundles shaped exactly like
Open-Meteo responses, driving each of the five verdict states on demand.

Everything is deterministic (pure functions of hour/point/member index — no RNG),
so scenario runs pin goldens and UI states reproducibly. Bundles are SYNTHETIC:
the warnings bundle carries source.mode="synthetic" and downstream evidence is
badged "emulated".

Limits assumed = config/profiles/default-limits.json (upwind 18 / reach 25 kt,
gusts 28 kt): scenario shapes are tuned against those numbers.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from .paths import config_dir, contracts_dir, data_root
from .route_sources import DEFAULT_ROUTE_ID
from .timeutil import parse_iso_utc

N_MEMBERS = 51
WINDOW_H = 72
DEFAULT_DEPARTURE = "2026-07-20T06:00:00Z"

SCENARIOS = ("calm", "approaching", "storm", "diverging", "warning")
EXPECTED_VERDICT = {
    "calm": "within",
    "approaching": "approaching",
    "storm": "exceeds",
    "diverging": "insufficient",
    "warning": "warning_active",
}


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _wind(scenario: str, h: int, p: int) -> tuple[float, float, float]:
    """(sustained kt, gust kt, direction °true) for hour h at point p."""
    if scenario == "calm":
        wind = 9 + 2 * math.sin(h / 6 + p * 0.5)
        return wind, wind + 4, 230.0
    if scenario in ("approaching", "warning"):
        # max ~16.1 (+0.6 model offset → 16.7) = 93% of the 18 kt upwind limit:
        # firmly 'approaching', never over
        wind = 13.5 + 2.6 * math.sin(h / 8 + p * 0.4)
        return wind, wind + 5, 250.0
    if scenario == "storm":
        ramp = _sigmoid((h - 24) / 3)
        wind = 16 + 14 * ramp
        return wind, wind * 1.35, 220 + 80 * ramp  # veer 220→300 through the front
    if scenario == "diverging":
        wind = 19 + 2 * math.sin(h / 7 + p * 0.3)
        return wind, wind + 6, 250.0
    raise ValueError(scenario)


# per-model offsets: only "diverging" splits the models
_MODEL_OFFSET = {
    "default": {"ecmwf_ifs025": 0.6, "gfs_global": -0.6, "icon_eu": 0.0},
    "diverging": {"ecmwf_ifs025": 5.0, "gfs_global": -5.0, "icon_eu": 0.0},
}


def _member_offset(m: int, h: int) -> float:
    if m == 0:
        return 0.0
    return 2.5 * math.sin(m * 0.7 + h / 4) + 1.5 * math.cos(m * 1.3)


def _waves(scenario: str, h: int) -> dict[str, float]:
    if scenario == "storm":
        ramp = _sigmoid((h - 26) / 4)
        hs = 1.0 + 2.4 * ramp
        wind_wave = hs * 0.85
        swell = 0.8
    else:
        hs = 0.6 + 0.25 * math.sin(h / 9)
        wind_wave = hs * 0.8
        swell = 0.25
    return {
        "wave_height": round(hs, 2),
        "wave_period": 6.0 if scenario != "storm" else 6.5,
        "wave_direction": 240,
        "wind_wave_height": round(wind_wave, 2),
        "wind_wave_period": 5.0,
        "wind_wave_direction": 240,
        "swell_wave_height": round(swell, 2),
        "swell_wave_period": 8.0,
        "swell_wave_direction": 260,
    }


def _times(departure: datetime) -> list[str]:
    start = departure - timedelta(hours=6)
    return [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(WINDOW_H)]


def generate_scenario(
    name: str, departure_iso: str = DEFAULT_DEPARTURE, *, route_id: str | None = None
) -> Path:
    if name not in SCENARIOS:
        raise ValueError(f"unknown scenario '{name}' (choose from {SCENARIOS})")
    route_id = route_id or DEFAULT_ROUTE_ID
    route = next(
        (
            doc
            for path in sorted((config_dir() / "routes").glob("*.json"))
            if (doc := json.loads(path.read_text()))["route_id"] == route_id
        ),
        None,
    )
    if route is None or len(route["waypoints"]) < 2:
        raise ValueError(f"Unknown or invalid scenario route '{route_id}'")
    # Match the engine's representative point per leg (linear midpoint).
    points = [
        ((a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2)
        for a, b in zip(route["waypoints"], route["waypoints"][1:])
    ]
    route_zones = json.loads((config_dir() / "route-zones.json").read_text())["routes"]
    zones = [zone for group in route_zones.get(route_id, {}).values() for zone in group]
    if name == "warning" and not zones:
        raise ValueError(f"No warning zones configured for scenario route '{route_id}'")
    departure = parse_iso_utc(departure_iso)
    times = _times(departure)
    out_root = data_root() / "scenarios"
    # Keep the original default location; other routes must not overwrite it.
    if route_id != "cherbourg-plymouth-v1":
        out_root /= route_id
    out_dir = out_root / name
    out_dir.mkdir(parents=True, exist_ok=True)

    def series(fn) -> list[float]:
        return [round(fn(h), 2) for h in range(WINDOW_H)]

    # ---- forecast.json (primary deterministic = ecmwf-shaped) ----
    forecast = []
    for p, (lat, lon) in enumerate(points):
        winds = [_wind(name, h, p) for h in range(WINDOW_H)]
        off = _MODEL_OFFSET["diverging" if name == "diverging" else "default"]["ecmwf_ifs025"]
        forecast.append(
            {
                "latitude": lat,
                "longitude": lon,
                "hourly": {
                    "time": times,
                    "wind_speed_10m": [round(w + off, 2) for w, _, _ in winds],
                    "wind_gusts_10m": [round(g + off, 2) for _, g, _ in winds],
                    "wind_direction_10m": [round(d, 1) for _, _, d in winds],
                },
            }
        )
    (out_dir / "forecast.json").write_text(json.dumps(forecast))

    # ---- ensemble.json ----
    ensemble = []
    for p, (lat, lon) in enumerate(points):
        winds = [_wind(name, h, p) for h in range(WINDOW_H)]
        hourly: dict[str, list] = {"time": times}
        for m in range(N_MEMBERS):
            suffix = "" if m == 0 else f"_member{m:02d}"
            hourly[f"wind_speed_10m{suffix}"] = [
                round(w + _member_offset(m, h), 2) for h, (w, _, _) in enumerate(winds)
            ]
            hourly[f"wind_gusts_10m{suffix}"] = [
                round(g + _member_offset(m, h), 2) for h, (_, g, _) in enumerate(winds)
            ]
        ensemble.append({"latitude": lat, "longitude": lon, "hourly": hourly})
    (out_dir / "ensemble.json").write_text(json.dumps(ensemble))

    # ---- marine.json ----
    marine = []
    for p, (lat, lon) in enumerate(points):
        hourly = {"time": times}
        keys = _waves(name, 0).keys()
        for key in keys:
            hourly[key] = [_waves(name, h)[key] for h in range(WINDOW_H)]
        marine.append({"latitude": lat, "longitude": lon, "hourly": hourly})
    (out_dir / "marine.json").write_text(json.dumps(marine))

    # ---- multimodel.json ----
    offsets = _MODEL_OFFSET["diverging" if name == "diverging" else "default"]
    multimodel = []
    for p, (lat, lon) in enumerate(points):
        winds = [_wind(name, h, p) for h in range(WINDOW_H)]
        hourly = {"time": times}
        for model, off in offsets.items():
            hourly[f"wind_speed_10m_{model}"] = [round(w + off, 2) for w, _, _ in winds]
            hourly[f"wind_gusts_10m_{model}"] = [round(g + off, 2) for _, g, _ in winds]
            hourly[f"wind_direction_10m_{model}"] = [round(d, 1) for _, _, d in winds]
            hourly[f"visibility_{model}"] = [
                None if model == "ecmwf_ifs025" else 22000 for _ in range(WINDOW_H)
            ]
            hourly[f"cape_{model}"] = [
                round(600 * _sigmoid((h - 30) / 4), 0) if name == "storm" else 15
                for h in range(WINDOW_H)
            ]
            hourly[f"temperature_2m_{model}"] = series(lambda h: 17 + 2 * math.sin(h / 12))
            hourly[f"dew_point_2m_{model}"] = series(lambda h: 11 + math.sin(h / 12))
            hourly[f"precipitation_{model}"] = [
                round(2.5 * _sigmoid((h - 24) / 2) * math.exp(-((h - 27) ** 2) / 18), 2)
                if name == "storm"
                else 0.0
                for h in range(WINDOW_H)
            ]
        multimodel.append({"latitude": lat, "longitude": lon, "hourly": hourly})
    (out_dir / "multimodel.json").write_text(json.dumps(multimodel))

    # ---- warnings.json (only the warning scenario ships a bulletin) ----
    if name == "warning":
        warnings = {
            "schema_version": 1,
            "fetched_at": departure.isoformat(),
            "source": {"mode": "synthetic", "name": "Passage scenario harness (synthetic)"},
            "feed_status": "ok",
            "bulletins": [
                {
                    "zone_id": zone["zone_id"],
                    "zone_name": zone.get("zone_name", zone["zone_id"]),
                    "kind": "gale",
                    "severity": "gale",
                    "valid_from": (departure + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "valid_to": (departure + timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "raw_text": "SYNTHETIC BULLETIN — Gale warning: W or SW gale force 8 "
                    "expected later. Generated by the Passage scenario harness; "
                    "never use for a real passage decision.",
                    "parse_confidence": 1.0,
                }
                for zone in zones
            ],
            "coverage_note": "synthetic scenario bundle — every value emulated",
        }
        Draft202012Validator(
            json.loads((contracts_dir() / "warnings.schema.json").read_text()),
            format_checker=FormatChecker(),
        ).validate(warnings)
        (out_dir / "warnings.json").write_text(json.dumps(warnings, indent=1))

    (out_dir / "scenario.json").write_text(
        json.dumps(
            {
                "scenario": name,
                "route_id": route_id,
                "departure": departure_iso,
                "expected_verdict": EXPECTED_VERDICT[name],
                "synthetic": True,
            },
            indent=1,
        )
    )
    return out_dir


def generate_all(
    departure_iso: str = DEFAULT_DEPARTURE, *, route_id: str | None = None
) -> list[Path]:
    return [generate_scenario(name, departure_iso, route_id=route_id) for name in SCENARIOS]
