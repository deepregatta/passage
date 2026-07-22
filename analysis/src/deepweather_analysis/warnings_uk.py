"""UK gale warnings — Met Office shipping forecast (brief §7 authority layer).

Feed spike (2026-07-17): the Met Office has NO API for the shipping forecast
or its gale warnings — Weather DataHub is model/site data only, DataPoint is
retired, and there is no open-data mirror. The only official machine-readable
surface is the print rendering of the shipping forecast page, which is fully
server-rendered, minimal HTML, purpose-built for plain reading:
  https://weather.metoffice.gov.uk/specialist-forecasts/coast-and-sea/print/shipping-forecast
It carries the gale-warnings-in-force list, issue time, validity period, and
per-area forecast text. We parse that page defensively: bulletins are emitted
ONLY for route UK zones named in the gale-warnings list (the engine treats any
bulletin as an authority override, so routine area forecasts must not become
bulletins). Raw text is always preserved; any parse surprise degrades.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone

import requests

SHIPPING_FORECAST_URL = (
    "https://weather.metoffice.gov.uk/specialist-forecasts/coast-and-sea/print/shipping-forecast"
)

# "10:30 (UTC+1) on Fri 17 Jul 2026" — offset absent means UTC (winter)
TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2})\s*\(UTC([+-]\d{1,2})?\)\s*on\s*\w+\s+(\d{1,2})\s+(\w{3})\s+(\d{4})"
)
GALES_RE = re.compile(r"warnings of gales\s+in\s+(.*?)\.", re.IGNORECASE | re.DOTALL)
AREA_RE = re.compile(
    r'<h3 class="area-forecast-heading">(.*?)</h3>\s*<p class="area-forecast">(.*?)</p>',
    re.DOTALL,
)

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    )
}


def _flatten(raw_html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw_html)
    return html.unescape(re.sub(r"\s+", " ", text))


def _parse_time(match: re.Match) -> datetime:
    hour, minute, offset, day, month, year = match.groups()
    tz = timezone(timedelta(hours=int(offset or 0)))
    return datetime(
        int(year), MONTHS[month], int(day), int(hour), int(minute), tzinfo=tz
    ).astimezone(timezone.utc)


def parse_shipping_forecast(raw_html: str) -> dict:
    """Extract issue time, validity, gale areas, and per-area forecast text."""
    text = _flatten(raw_html)

    times = [_parse_time(m) for m in TIME_RE.finditer(text)]
    # page order: valid-from, valid-until, issued-at (header), then repeats in body
    valid_from = times[0] if len(times) >= 2 else None
    valid_to = times[1] if len(times) >= 2 else None
    issued = times[2] if len(times) >= 3 else valid_from

    gales_match = GALES_RE.search(text)
    gale_areas: list[str] = []
    if gales_match:
        raw_list = re.sub(r"\band\b", ",", gales_match.group(1))
        gale_areas = [a.strip() for a in raw_list.split(",") if a.strip()]

    areas: dict[str, str] = {}
    for heading, body in AREA_RE.findall(raw_html):
        for area in _flatten(heading).split(","):
            areas[area.strip()] = _flatten(body).strip()

    return {
        "issued": issued,
        "valid_from": valid_from,
        "valid_to": valid_to,
        "gale_areas": gale_areas,
        "area_forecasts": areas,
    }


def _area_matches(zone_name: str, area: str) -> bool:
    """'Portland' matches 'Portland' and qualified forms like 'West Portland'."""
    return zone_name.lower() in area.lower()


def fetch_uk_gale_bulletins(
    route_uk_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route zones under gale warning, status note). Raises on fetch/parse failure."""
    now = now or datetime.now(timezone.utc)
    response = requests.get(SHIPPING_FORECAST_URL, timeout=30)
    response.raise_for_status()
    parsed = parse_shipping_forecast(response.text)
    if parsed["valid_from"] is None or parsed["valid_to"] is None:
        raise ValueError("shipping forecast page: validity times not found — layout changed?")

    issued_iso = (parsed["issued"] or now).strftime("%Y-%m-%dT%H:%M:%SZ")
    bulletins: list[dict] = []
    for zone in route_uk_zones:
        matched = [a for a in parsed["gale_areas"] if _area_matches(zone["zone_name"], a)]
        if not matched:
            continue
        forecast_texts = [
            f"{area}: {body}"
            for area, body in parsed["area_forecasts"].items()
            if _area_matches(zone["zone_name"], area)
        ]
        bulletins.append(
            {
                "zone_id": zone["zone_id"],
                "zone_name": zone["zone_name"],
                "kind": "gale-warning",
                "severity": "gale",
                "valid_from": issued_iso,
                "valid_to": parsed["valid_to"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "raw_text": (
                    f"Met Office shipping forecast issued {issued_iso}: warnings of gales in force "
                    f"for {', '.join(matched)}. " + " | ".join(forecast_texts)
                ),
                "parse_confidence": 0.85,
            }
        )
    note = (
        f"UK: Met Office shipping forecast issued {issued_iso}, gales in force for "
        f"{len(parsed['gale_areas'])} area(s); gale warnings between issues are not visible "
        "until the next forecast."
    )
    return bulletins, note
