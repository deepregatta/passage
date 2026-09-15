"""Australian marine warnings — BOM marine wind warning summaries (authority layer).

Feed spike (2026-07-17): the Bureau of Meteorology has no public warnings API,
but publishes every product as structured XML on its anonymous FTP server
(ftp.bom.gov.au/anon/gen/fwo/). The per-state Marine Wind Warning Summary
(e.g. IDQ20085 for Queensland) carries machine-readable hazards: severity
codes (STR/GALE/STORM), AAC-coded coastal-waters areas, and per-forecast-period
UTC validity times — no scraping, reissued at least twice daily and amended
between issues. Route zones live in config/route-zones.json as au_zones
entries carrying the AAC area code and the state's bom_product id, so other
states (IDN/IDV/IDW/IDS/IDT…) are a config addition, not a code change.

Bulletin policy: only type MWW hazards become bulletins; a CAN phase/severity
is BOM's explicit cancellation and is never emitted (counted in the coverage
note). Severity maps from the warning phenomena text first (Strong Wind
Warning → near-gale, aligned with the NWS Small Craft Advisory mapping; Gale →
gale; Storm Force → storm; Hurricane Force → hurricane), falling back to the
severity attribute; unknown phenomena still surface with severity null.
Validity comes from the hazard's forecast-period UTC attributes (structured,
confidence 0.95). Raw text is always preserved.

Coverage caveat (disclosed in the note): the summary covers coastal waters
zones only — BOM high-seas forecasts are separate products and are not
fetched, so offshore legs beyond coastal waters carry no BOM coverage here.
"""

from __future__ import annotations

import os
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from .textutil import slugify as _slug
from .timeutil import parse_iso_utc

BOM_FTP_URL_TEMPLATE = os.environ.get(
    "DEEPWEATHER_BOM_FTP_URL_TEMPLATE",
    "ftp://ftp.bom.gov.au/anon/gen/fwo/{product_id}.xml",
)

# warning_phenomena text prefix -> our severity vocabulary (primary), aligned
# with the FR/US scale where advisory-grade == near-gale.
PHENOMENA_SEVERITY = [
    ("hurricane force wind warning", "hurricane"),
    ("storm force wind warning", "storm"),
    ("gale warning", "gale"),
    ("strong wind warning", "near-gale"),
]

# hazard severity attribute -> severity (fallback when phenomena text is absent)
ATTR_SEVERITY = {"STR": "near-gale", "GALE": "gale", "STORM": "storm", "HUR": "hurricane"}


def _severity(phenomena: str, severity_attr: str) -> str | None:
    lowered = phenomena.lower()
    for prefix, severity in PHENOMENA_SEVERITY:
        if lowered.startswith(prefix):
            return severity
    return ATTR_SEVERITY.get(severity_attr.upper())


def _hazard_text(hazard: ET.Element, kind: str) -> str | None:
    element = hazard.find(f"text[@type='{kind}']")
    return element.text.strip() if element is not None and element.text else None


def parse_bom_mww(
    xml_text: str, route_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str, int]:
    """(bulletins for route zones, issue-time note fragment, cancelled count)
    from one Marine Wind Warning Summary product XML."""
    now = now or datetime.now(timezone.utc)
    root = ET.fromstring(xml_text)
    zones_by_aac = {zone["aac"]: zone for zone in route_zones}

    issue_time = root.findtext("amoc/issue-time-utc") or "unknown"
    bulletins: list[dict] = []
    cancelled = 0
    for period in root.iter("forecast-period"):
        valid_from = period.get("start-time-utc")
        valid_to = period.get("end-time-utc")
        if not valid_from or not valid_to:
            continue
        for hazard in period.findall("hazard"):
            if hazard.get("type") != "MWW":
                continue
            severity_attr = hazard.get("severity", "")
            if severity_attr == "CAN" or hazard.get("phase") == "CAN":
                cancelled += 1
                continue
            matched = [
                zones_by_aac[area.get("aac")]
                for area in hazard.findall("area-list/area")
                if area.get("aac") in zones_by_aac
            ]
            if not matched:
                continue
            if parse_iso_utc(valid_to) < now:
                continue  # a past forecast period still present in the product
            phenomena = _hazard_text(hazard, "warning_phenomena") or ""
            areas_text = _hazard_text(hazard, "warning_areas") or ""
            raw_text = f"{phenomena} for {areas_text}".strip() or "Marine wind warning"
            for zone in matched:
                bulletins.append(
                    {
                        "zone_id": zone["zone_id"],
                        "zone_name": zone.get("zone_name", zone["zone_id"]),
                        "kind": f"bom-{_slug(phenomena) or 'mww'}",
                        "severity": _severity(phenomena, severity_attr),
                        "valid_from": valid_from,
                        "valid_to": valid_to,
                        "raw_text": raw_text,
                        "parse_confidence": 0.95,
                    }
                )
    return bulletins, issue_time, cancelled


def fetch_au_bulletins(
    route_au_zones: list[dict], now: datetime | None = None
) -> tuple[list[dict], str]:
    """(bulletins for route AU zones, status note). Raises on fetch failure."""
    if not route_au_zones:
        return [], "AU: no route zones configured."
    products: dict[str, list[dict]] = {}
    for zone in route_au_zones:
        products.setdefault(zone["bom_product"], []).append(zone)
    bulletins: list[dict] = []
    notes: list[str] = []
    for product_id, zones in sorted(products.items()):
        url = BOM_FTP_URL_TEMPLATE.format(product_id=product_id)
        with urllib.request.urlopen(url, timeout=60) as response:  # ftp:// by design
            xml_text = response.read().decode("utf-8")
        product_bulletins, issue_time, cancelled = parse_bom_mww(xml_text, zones, now=now)
        bulletins.extend(product_bulletins)
        note = (
            f"AU: BOM marine wind warning summary {product_id} (issued {issue_time}) for "
            f"{len(zones)} route zone(s): {len(product_bulletins)} bulletin(s) in force. "
            "Coastal waters zones only — BOM high-seas forecasts are not fetched, so "
            "offshore legs carry no BOM coverage."
        )
        if cancelled:
            note += f" {cancelled} cancellation notice(s) not emitted."
        notes.append(note)
    return bulletins, " ".join(notes)
