"""UK gale warnings — Met Office shipping forecast (authority layer).

Feed spike (2026-07-17): the Met Office has NO API for the shipping forecast
or its gale warnings — Weather DataHub is model/site data only, DataPoint is
retired, and there is no open-data mirror. The only official machine-readable
surface is the print rendering of the shipping forecast page, which is fully
server-rendered, minimal HTML, purpose-built for plain reading:
  https://weather.metoffice.gov.uk/specialist-forecasts/coast-and-sea/print/shipping-forecast
It carries the gale-warnings-in-force list, issue time, validity period, and
per-area forecast text. We parse that page defensively: bulletins are emitted
ONLY for route UK zones covered by the gale-warning statement, including its
all-areas and exclusion forms (the engine treats any
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
VALIDITY_RE = re.compile(
    r"Forecast valid from:\s*(?P<valid_from>.*?)\s+until\s+(?P<valid_to>.*?)\.?",
    re.IGNORECASE,
)
ISSUE_RE = re.compile(
    r"(?:The shipping forecast )?Issued by the Met Office, "
    r"on behalf of the Maritime and Coastguard Agency, at\s+(?P<issued>.*?)"
    r"(?:\s+for the period\s+(?P<valid_from>.*?)\s+to\s+(?P<valid_to>.*?))?\.?",
    re.IGNORECASE,
)
GALES_RE = re.compile(
    r"\b(?P<no>no\s+)?warnings of gales\s+in\s+(?P<areas>.*?)\.",
    re.IGNORECASE | re.DOTALL,
)
ALL_AREAS_RE = re.compile(r"all areas(?:\s+except\s+(.+))?", re.IGNORECASE)
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


def _forecast_times(raw_html: str) -> dict[str, datetime]:
    """Read labeled paragraphs, requiring repeated header/body values to agree.

    Use displayed offsets: the fixture's datetime attributes incorrectly mark
    local summer times as Z. Never infer an issue time from validity or fetch time.
    """
    times: dict[str, datetime] = {}
    for paragraph in re.findall(r"<p\b[^>]*>(.*?)</p\s*>", raw_html, re.IGNORECASE | re.DOTALL):
        text = _flatten(paragraph).strip()
        if text.lower().startswith("forecast valid from"):
            match = VALIDITY_RE.fullmatch(text)
        elif text.lower().startswith(("issued by the met office", "the shipping forecast issued")):
            match = ISSUE_RE.fullmatch(text)
        else:
            continue
        if match is None:
            raise ValueError("shipping forecast page: malformed labeled times — layout changed?")
        for field, value in match.groupdict().items():
            if value is None:
                continue
            timestamp = TIME_RE.fullmatch(value.strip())
            if timestamp is None:
                raise ValueError(f"shipping forecast page: malformed {field}")
            try:
                parsed = _parse_time(timestamp)
            except (ValueError, KeyError, OverflowError) as error:
                raise ValueError(f"shipping forecast page: invalid {field}") from error
            if field in times and times[field] != parsed:
                raise ValueError(f"shipping forecast page: conflicting {field}")
            times[field] = parsed

    if not {"issued", "valid_from", "valid_to"} <= times.keys():
        raise ValueError("shipping forecast page: labeled times not found — layout changed?")
    if times["valid_from"] >= times["valid_to"] or times["issued"] >= times["valid_to"]:
        raise ValueError("shipping forecast page: inconsistent validity interval")
    return times


def parse_shipping_forecast(raw_html: str) -> dict:
    """Extract times, gale areas, all-area scope/exclusions, and area forecasts.

    For all-area statements, gale_areas expands the available forecast headings.
    Retain the scope too: a missing area forecast must not suppress its warning.
    Missing, malformed, conflicting, or inconsistent labeled times raise ValueError.
    """
    text = _flatten(raw_html)

    times = _forecast_times(raw_html)

    areas: dict[str, str] = {}
    for heading, body in AREA_RE.findall(raw_html):
        for area in _flatten(heading).split(","):
            areas[area.strip()] = _flatten(body).strip()

    gales_match = GALES_RE.search(text)
    gale_areas: list[str] = []
    excluded_areas: list[str] = []
    all_areas = False
    if gales_match and not gales_match.group("no"):
        statement = gales_match.group("areas").strip()
        all_match = ALL_AREAS_RE.fullmatch(statement)
        if all_match:
            all_areas = True
            excluded_areas = _split_areas(all_match.group(1) or "")
            gale_areas = [
                area
                for area in areas
                if not any(_area_matches(excluded, area) for excluded in excluded_areas)
            ]
        else:
            gale_areas = _split_areas(statement)

    return {
        **times,
        "gale_areas": gale_areas,
        "gale_all_areas": all_areas,
        "gale_excluded_areas": excluded_areas,
        "area_forecasts": areas,
    }


def _split_areas(raw_list: str) -> list[str]:
    return [a.strip() for a in re.split(r",|\band\b", raw_list, flags=re.IGNORECASE) if a.strip()]


def _area_matches(zone_name: str, area: str) -> bool:
    """'Portland' matches 'Portland' and qualified forms like 'West Portland'."""
    return zone_name.lower() in area.lower()


def fetch_uk_gale_bulletins(
    route_uk_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route zones under gale warning, status note). Raises on fetch/parse failure."""
    response = requests.get(SHIPPING_FORECAST_URL, timeout=30)
    response.raise_for_status()
    parsed = parse_shipping_forecast(response.text)
    issued_iso = parsed["issued"].strftime("%Y-%m-%dT%H:%M:%SZ")
    bulletins: list[dict] = []
    for zone in route_uk_zones:
        if parsed["gale_all_areas"]:
            matched = (
                []
                if any(
                    _area_matches(excluded, zone["zone_name"])
                    for excluded in parsed["gale_excluded_areas"]
                )
                else [zone["zone_name"]]
            )
        else:
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
    scope = f"{len(parsed['gale_areas'])} area(s)"
    if parsed["gale_all_areas"]:
        scope = "all areas"
        if parsed["gale_excluded_areas"]:
            scope += " except " + ", ".join(parsed["gale_excluded_areas"])
    note = (
        f"UK: Met Office shipping forecast issued {issued_iso}, gales in force for "
        f"{scope}; gale warnings between issues are not visible "
        "until the next forecast."
    )
    return bulletins, note
