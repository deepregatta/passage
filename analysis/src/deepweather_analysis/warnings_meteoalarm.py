"""European marine warnings — Meteoalarm CAP aggregation (authority layer).

Feed spike (2026-07-17): meteoalarm.org aggregates the official CAP warnings
of ~35 European national weather services behind one tokenless JSON API per
country (https://feeds.meteoalarm.org/api/v1/warnings/feeds-{country}).
Granularity varies per country; for Spain (AEMET) the ES8xx 'Costa - …'
EMMA_ID zones are dedicated maritime-coastal zones, verified live. Route
zones live in config/route-zones.json as meteoalarm_zones entries carrying
the EMMA_ID geocode and the feed country. FR/UK keep their dedicated feeds
(BMS mirror / shipping-forecast page) — Meteoalarm serves the countries we
have no better source for.

Bulletin policy: an alert becomes a bulletin only when its awareness_type is
marine-relevant (Wind or coastalevent) — heat/rain/thunderstorm warnings on
the same coastal zones are counted in the coverage note, never emitted (the
engine treats any bulletin as an authority override). Severity maps from the
Meteoalarm awareness level (yellow → near-gale, orange → gale, red → storm):
CAP carries no Beaufort force, so this is an approximation and
parse_confidence stays at 0.8. Green ('Minor') entries are Meteoalarm's
explicit all-clear state and are never emitted; an unknown colour still
surfaces as a bulletin with severity null (conservative, like unknown NWS
warning events). Cancelled/superseded alerts are dropped via
msgType/status and the CAP references chain. Raw text is always preserved.

Coverage caveat (disclosed in the note): Meteoalarm only distributes coastal
zones — national high-seas bulletins are NOT in the feed, so open-water legs
carry no Meteoalarm coverage and absence of a bulletin is not absence of risk.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import requests

from .timeutil import optional_iso_utc as _iso_utc
from .timeutil import parse_iso_utc

METEOALARM_URL_TEMPLATE = os.environ.get(
    "DEEPWEATHER_METEOALARM_URL_TEMPLATE",
    "https://feeds.meteoalarm.org/api/v1/warnings/feeds-{country}",
)

# marine-relevant Meteoalarm awareness_type values (parameter '1; Wind', '7; coastalevent')
MARINE_AWARENESS_TYPES = {"wind", "coastalevent"}

# awareness_level colour -> our severity vocabulary (approximate: CAP carries
# no wind force; aligned with the FR/US scale where advisory-grade == near-gale)
LEVEL_SEVERITY = {"yellow": "near-gale", "orange": "gale", "red": "storm"}


def _parameter(info: dict[str, Any], name: str) -> str | None:
    for parameter in info.get("parameter", []):
        if parameter.get("valueName") == name:
            return parameter.get("value")
    return None


def _awareness_type(info: dict[str, Any]) -> str | None:
    """'7; coastalevent' -> 'coastalevent' (lowercased; feed casing varies)."""
    raw = _parameter(info, "awareness_type")
    if not raw:
        return None
    return raw.split(";")[-1].strip().lower()


def _awareness_colour(info: dict[str, Any]) -> str | None:
    """'3; orange; Severe' -> 'orange'."""
    raw = _parameter(info, "awareness_level")
    if not raw:
        return None
    parts = [p.strip().lower() for p in raw.split(";")]
    return parts[1] if len(parts) >= 2 else None


def _info_areas(info: dict[str, Any]) -> set[str]:
    emma_ids: set[str] = set()
    for area in info.get("area", []):
        for geocode in area.get("geocode", []):
            if geocode.get("valueName") == "EMMA_ID":
                emma_ids.add(geocode.get("value"))
    return emma_ids


def _pick_info(alert: dict[str, Any]) -> dict[str, Any] | None:
    """Prefer the English info block (event/headline in en-GB), else the first."""
    infos = alert.get("info", [])
    for info in infos:
        if str(info.get("language", "")).lower().startswith("en"):
            return info
    return infos[0] if infos else None


def parse_meteoalarm(
    feed_doc: dict[str, Any],
    route_zones: list[dict],
    country: str,
    now: datetime | None = None,
) -> tuple[list[dict], str]:
    """(bulletins for route zones, status note) from a Meteoalarm country feed."""
    now = now or datetime.now(timezone.utc)
    zones_by_emma = {zone["emma_id"]: zone for zone in route_zones}

    alerts = [w.get("alert", {}) for w in feed_doc.get("warnings", [])]
    superseded: set[str] = set()
    for alert in alerts:
        for ref in str(alert.get("references", "")).split():
            # CAP reference format: sender,identifier,sent
            parts = ref.split(",")
            if len(parts) >= 2:
                superseded.add(parts[1])

    bulletins: list[dict] = []
    skipped_types: list[str] = []
    for alert in alerts:
        if alert.get("status") != "Actual" or alert.get("msgType") == "Cancel":
            continue
        if alert.get("identifier") in superseded:
            continue
        info = _pick_info(alert)
        if info is None:
            continue
        matched = [zones_by_emma[e] for e in _info_areas(info) if e in zones_by_emma]
        if not matched:
            continue
        valid_to = _iso_utc(info.get("expires"))
        if valid_to is None:
            continue  # a warning with no expiry at all — malformed, skip
        if parse_iso_utc(valid_to) < now:
            continue  # expired
        awareness_type = _awareness_type(info)
        if awareness_type not in MARINE_AWARENESS_TYPES:
            skipped_types.append(awareness_type or "unknown")
            continue
        colour = _awareness_colour(info)
        if colour == "green":
            continue  # green is Meteoalarm's published all-clear, not a warning
        valid_from = _iso_utc(info.get("onset") or info.get("effective")) or now.strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        raw_text = "\n".join(
            part for part in (info.get("headline"), info.get("description")) if part
        ).strip()
        for zone in matched:
            bulletins.append(
                {
                    "zone_id": zone["zone_id"],
                    "zone_name": zone.get("zone_name", zone["zone_id"]),
                    "kind": f"meteoalarm-{awareness_type}",
                    "severity": LEVEL_SEVERITY.get(colour or ""),
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                    "raw_text": raw_text or str(info.get("event", "")),
                    "parse_confidence": 0.8,
                }
            )
    note = (
        f"Meteoalarm {country}: CAP warnings for {len(route_zones)} coastal route zone(s): "
        f"{len(bulletins)} marine bulletin(s) in force. Coastal zones only — high-seas "
        "bulletins are not distributed via Meteoalarm, so open-water legs carry no "
        "Meteoalarm coverage."
    )
    if skipped_types:
        note += (
            f" {len(skipped_types)} non-marine warning(s) on route zones not emitted "
            f"({', '.join(sorted(set(skipped_types)))})."
        )
    return bulletins, note


def fetch_meteoalarm_bulletins(
    route_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route Meteoalarm zones, status note). Raises on fetch failure."""
    if not route_zones:
        return [], "Meteoalarm: no route zones configured."
    countries: dict[str, list[dict]] = {}
    for zone in route_zones:
        countries.setdefault(zone["country"], []).append(zone)
    bulletins: list[dict] = []
    notes: list[str] = []
    for country, zones in sorted(countries.items()):
        response = requests.get(METEOALARM_URL_TEMPLATE.format(country=country), timeout=60)
        response.raise_for_status()
        country_bulletins, country_note = parse_meteoalarm(response.json(), zones, country, now=now)
        bulletins.extend(country_bulletins)
        notes.append(country_note)
    return bulletins, " ".join(notes)
