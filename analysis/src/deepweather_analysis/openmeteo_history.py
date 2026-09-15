"""Open-Meteo HISTORICAL FORECAST archive client (verification layer).

https://historical-forecast-api.open-meteo.com/v1/forecast takes the same
parameters as the forecast API plus start_date/end_date, and replays what the
named model FORECAST said at the time — which is exactly what a retrospective
corpus wants on the route layer (the synoptic layer replays ERA5 instead).

Requests use a cell-keyed file cache (points rounded to the 0.25 deg model
cell) under data/cache/openmeteo-history/ and exponential backoff on 429/5xx.
Failures are NON-FATAL by design — the archive does not reach arbitrarily far
back for every model, so corpus cases just record route_conditions_available: false.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from .paths import cache_dir

logger = logging.getLogger(__name__)

BASE_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
DEFAULT_MODEL = "ecmwf_ifs025"
CELL_DEG = 0.25  # cache cell size ~ model resolution

HOURLY_VARIABLES = (
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_direction_10m",
    "pressure_msl",
)

MAX_ATTEMPTS = 4
BACKOFF_BASE_S = 2.0
REQUEST_TIMEOUT_S = 30

Point = Union[Tuple[float, float], Dict[str, float]]


def _as_latlon(point: Point) -> Tuple[float, float]:
    if isinstance(point, dict):
        return float(point["lat"]), float(point["lon"])
    return float(point[0]), float(point[1])


def _cell_of(lat: float, lon: float) -> Tuple[float, float]:
    return (round(lat / CELL_DEG) * CELL_DEG, round(lon / CELL_DEG) * CELL_DEG)


def _cache_path(model: str, cell: Tuple[float, float], start_date: str, end_date: str) -> Path:
    label = f"{model}_{cell[0]:+07.2f}_{cell[1]:+07.2f}_{start_date}_{end_date}.json"
    return cache_dir("openmeteo-history") / label


def _fetch_with_backoff(url: str) -> Dict[str, Any]:
    """GET with exponential backoff on 429/5xx."""
    last_error: Optional[str] = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_S) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            last_error = f"HTTP {exc.code}: {body}"
            if exc.code == 429 or exc.code >= 500:
                delay = BACKOFF_BASE_S * (2**attempt)
                logger.warning("open-meteo history %s; retrying in %.0fs", exc.code, delay)
                time.sleep(delay)
                continue
            raise RuntimeError(last_error) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = str(exc)
            time.sleep(BACKOFF_BASE_S * (2**attempt))
    raise RuntimeError(last_error or "open-meteo history: retries exhausted")


def fetch_route_history(
    points: Iterable[Point],
    start_date: str,
    end_date: str,
    model: str = DEFAULT_MODEL,
    *,
    hourly: Sequence[str] = HOURLY_VARIABLES,
) -> Dict[str, Any]:
    """
    Fetch archived route-layer forecast conditions for a set of points.

    Args:
        points: (lat, lon) tuples or {lat, lon} dicts; deduplicated per
            0.25 deg cache cell.
        start_date, end_date: 'YYYY-MM-DD' (archive semantics)
        model: Open-Meteo model id (default ecmwf_ifs025)

    Returns:
        {model, start_date, end_date, points: [{lat, lon, status,
        cached, hourly?|error?}], route_conditions_available} — NON-FATAL on
        refusals: a point that the archive rejects (e.g. dates before the
        model's archive) gets status 'unavailable'.
    """
    results: List[Dict[str, Any]] = []
    seen_cells: set[Tuple[float, float]] = set()

    for point in points:
        lat, lon = _as_latlon(point)
        cell = _cell_of(lat, lon)
        if cell in seen_cells:
            continue
        seen_cells.add(cell)

        entry: Dict[str, Any] = {"lat": cell[0], "lon": cell[1], "cached": False}
        path = _cache_path(model, cell, start_date, end_date)
        if path.exists():
            try:
                cached = json.loads(path.read_text())
                entry.update(status="ok", cached=True, hourly=cached.get("hourly"))
                results.append(entry)
                continue
            except (json.JSONDecodeError, OSError):
                logger.warning("Unreadable open-meteo history cache %s; refetching", path)

        params = {
            "latitude": f"{cell[0]:.2f}",
            "longitude": f"{cell[1]:.2f}",
            "hourly": ",".join(hourly),
            "wind_speed_unit": "kn",
            "start_date": start_date,
            "end_date": end_date,
            "models": model,
            "timezone": "UTC",
        }
        url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
        try:
            payload = _fetch_with_backoff(url)
            if payload.get("error"):
                raise RuntimeError(str(payload.get("reason") or "API error"))
            record = {
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "model": model,
                "hourly": payload.get("hourly"),
            }
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record, separators=(",", ":")) + "\n")
            entry.update(status="ok", hourly=payload.get("hourly"))
        except Exception as exc:  # non-fatal by design
            logger.info("open-meteo history unavailable for %s (%s)", cell, exc)
            entry.update(status="unavailable", error=str(exc)[:300])
        results.append(entry)

    available = bool(results) and all(p["status"] == "ok" for p in results)
    return {
        "model": model,
        "start_date": start_date,
        "end_date": end_date,
        "points": results,
        "route_conditions_available": available,
    }


__all__ = ["BASE_URL", "DEFAULT_MODEL", "HOURLY_VARIABLES", "fetch_route_history"]
