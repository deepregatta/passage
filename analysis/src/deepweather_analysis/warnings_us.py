"""US marine warnings — NWS active alerts via api.weather.gov (authority layer).

Unlike FR (daily-lagged data.gouv mirror) and UK (print-page parse), the US has
a real official API: api.weather.gov serves active CAP alerts per marine
forecast zone, free, tokenless, structured JSON — no scraping and no sync lag.
Route zones live in config/route-zones.json as us_zones entries whose nws_zone
is the NWS UGC code (e.g. ANZ237 Block Island Sound).

Bulletin policy: an alert becomes a bulletin only when its event name ends in
"Warning" or "Advisory" (Small Craft Advisory, Gale/Storm/Hurricane Force Wind
Warning, Special Marine Warning, ...). Watches and Statements are counted in
the coverage note but are NOT emitted — the engine treats any bulletin as an
authority override, and a watch is not an in-force warning. Raw alert text is
always preserved; severity comes from an explicit event map (unknown warning
events keep severity null but still surface as bulletins).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import requests

from .http import USER_AGENT as NWS_USER_AGENT
from .textutil import slugify as _event_slug
from .timeutil import optional_iso_utc as _iso_utc

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"

# NWS event name (lowercased prefix) -> our severity vocabulary, aligned with
# the FR SEVERITY_WORDS scale (near-gale, gale, storm, violent-storm, hurricane).
EVENT_SEVERITY = [
    ("hurricane force wind warning", "hurricane"),
    ("hurricane warning", "hurricane"),
    ("tropical storm warning", "storm"),
    ("storm warning", "storm"),
    ("gale warning", "gale"),
    ("small craft advisory", "near-gale"),
    ("special marine warning", "storm"),
]


def _severity(event: str) -> str | None:
    lowered = event.lower()
    for prefix, severity in EVENT_SEVERITY:
        if lowered.startswith(prefix):
            return severity
    return None


def _is_bulletin_event(event: str) -> bool:
    return event.lower().endswith(("warning", "advisory"))


def parse_alerts(
    alerts_doc: dict[str, Any], route_us_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route zones, status note) from an api.weather.gov alerts document."""
    now = now or datetime.now(timezone.utc)
    zones_by_ugc = {zone["nws_zone"]: zone for zone in route_us_zones}
    bulletins: list[dict] = []
    skipped_events: list[str] = []
    for feature in alerts_doc.get("features", []):
        props = feature.get("properties", {})
        event = props.get("event", "")
        ugc_codes = props.get("geocode", {}).get("UGC", [])
        matched = [zones_by_ugc[code] for code in ugc_codes if code in zones_by_ugc]
        if not matched:
            continue
        if not _is_bulletin_event(event):
            skipped_events.append(event)
            continue
        valid_from = _iso_utc(props.get("onset") or props.get("effective")) or now.strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        valid_to = _iso_utc(props.get("ends") or props.get("expires"))
        if valid_to is None:
            continue  # an alert with no end/expiry at all — malformed, skip
        raw_text = "\n".join(
            part for part in (props.get("headline"), props.get("description")) if part
        ).strip()
        for zone in matched:
            bulletins.append(
                {
                    "zone_id": zone["zone_id"],
                    "zone_name": zone.get("zone_name", zone["zone_id"]),
                    "kind": f"nws-{_event_slug(event)}",
                    "severity": _severity(event),
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                    "raw_text": raw_text or event,
                    "parse_confidence": 0.95,
                }
            )
    note = (
        f"US: NWS api.weather.gov active alerts for {len(route_us_zones)} route zone(s): "
        f"{len(bulletins)} bulletin(s) in force."
    )
    if skipped_events:
        note += (
            f" {len(skipped_events)} non-warning alert(s) not emitted "
            f"({', '.join(sorted(set(skipped_events)))})."
        )
    return bulletins, note


def fetch_us_bulletins(
    route_us_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route US zones, status note). Raises on fetch failure."""
    if not route_us_zones:
        return [], "US: no route zones configured."
    response = requests.get(
        NWS_ALERTS_URL,
        params={"zone": ",".join(zone["nws_zone"] for zone in route_us_zones)},
        headers={"User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json"},
        timeout=30,
    )
    response.raise_for_status()
    return parse_alerts(response.json(), route_us_zones, now=now)
