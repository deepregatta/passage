"""Per-route source registry for the four 'local' feeds (config/route-sources.json).

The forecast-model layer (ECMWF, Open-Meteo, ERA5) is global; only tides,
currents, warnings, and observations need per-region sources. This module is
the single lookup point: every feed module resolves its stations / ports /
bounds / broadcast-area filters through here, keyed by route_id, instead of
hardcoding Channel values. Adding a region means adding a route entry to the
JSON registry — no feed-module changes.

Marine warning zones (the per-route zone→bulletin matching) stay in
config/route-zones.json; this registry carries the feed *sources*.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Dict

from .paths import config_dir

DEFAULT_ROUTE_ID = os.environ.get("DEEPWEATHER_ROUTE_ID", "cherbourg-plymouth-v1")


@lru_cache(maxsize=1)
def load_route_sources() -> Dict[str, Any]:
    return json.loads((config_dir() / "route-sources.json").read_text())


def route_sources(route_id: str | None = None) -> Dict[str, Any]:
    resolved = route_id or DEFAULT_ROUTE_ID
    routes = load_route_sources()["routes"]
    if resolved not in routes:
        known = ", ".join(sorted(routes))
        raise KeyError(
            f"Unknown route '{resolved}' — declare it in config/route-sources.json (known: {known})"
        )
    return routes[resolved]


def live_stations(route_id: str | None = None) -> tuple[Dict[str, Any], ...]:
    return tuple(route_sources(route_id)["observations"]["live_stations"])


def synthetic_stations(route_id: str | None = None) -> tuple[Dict[str, Any], ...]:
    return tuple(route_sources(route_id)["observations"]["synthetic_stations"])


def synthetic_observations_source_name(route_id: str | None = None) -> str:
    return route_sources(route_id)["observations"]["synthetic_source_name"]


def live_observations_source_name(route_id: str | None = None) -> str:
    return route_sources(route_id)["observations"].get("live_source_name", "ndbc-realtime2")


def observations_live_source(route_id: str | None = None) -> Dict[str, Any]:
    """Live observations source spec, e.g. {'kind': 'ndbc'} or
    {'kind': 'cmems_insitu_nrt', 'base_url': ...}.

    Absent registry entries default to ndbc (the original Channel/US path).
    """
    return dict(route_sources(route_id)["observations"].get("live_source", {"kind": "ndbc"}))


def tide_ports(route_id: str | None = None) -> Dict[str, Dict[str, Any]]:
    """Ports with (amp, phase) constituent tuples, as tides.py consumes them."""
    ports = {}
    for port_id, port in route_sources(route_id)["tides"]["ports"].items():
        ports[port_id] = {
            **port,
            "constituents": {k: tuple(v) for k, v in port["constituents"].items()},
        }
    return ports


def tides_artifact_name(route_id: str | None = None) -> str:
    return route_sources(route_id)["tides"]["artifact_name"]


def tides_live_source(route_id: str | None = None) -> Dict[str, Any]:
    """Live tide source spec, e.g. {'kind': 'cmems_ssh'} or {'kind': 'noaa_coops'}.

    Absent registry entries default to cmems_ssh (the original Channel path).
    """
    return dict(route_sources(route_id)["tides"].get("live_source", {"kind": "cmems_ssh"}))


def currents_bounds(route_id: str | None = None) -> Dict[str, float]:
    return dict(route_sources(route_id)["currents_bounds"])


def fr_broadcast_areas(route_id: str | None = None) -> set[str]:
    """BMS broadcast areas that can carry bulletins for the route(s).

    With route_id None, unions across every registered route — matching how
    warnings_mf matches zone tokens across all of route-zones.json.
    """
    if route_id is not None:
        return set(route_sources(route_id).get("warnings_fr", {}).get("broadcast_areas", []))
    areas: set[str] = set()
    for entry in load_route_sources()["routes"].values():
        areas.update(entry.get("warnings_fr", {}).get("broadcast_areas", []))
    return areas


__all__ = [
    "DEFAULT_ROUTE_ID",
    "currents_bounds",
    "fr_broadcast_areas",
    "live_observations_source_name",
    "live_stations",
    "observations_live_source",
    "load_route_sources",
    "route_sources",
    "synthetic_observations_source_name",
    "synthetic_stations",
    "tide_ports",
    "tides_artifact_name",
    "tides_live_source",
]
