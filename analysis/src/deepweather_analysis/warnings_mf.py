"""Official marine warnings (brief §7 authority layer) — Météo-France BMS.

Feed spike (2026-07-11, time-boxed):
- public-api.meteofrance.fr (DPVigilance / marine bulletins): requires a free API
  portal account (Bearer token) -> account-gated, so the provider defaults to
  SYNTHETIC per the prototype's data-realism policy. The live client below is
  ready: create a portal account, set DEEPWEATHER_MF_API_TOKEN, flip
  config/providers.json warnings_fr.mode to "live".
- donneespubliques.meteofrance.fr: 302/HTML only — scraping-grade, rejected.
- vigilance.meteofrance.fr: HTML app, no stable JSON without the portal.

Modes:
  synthetic  — clear conditions by default; --gale ZONE injects a gale bulletin
               (drives the warning_active verdict state end-to-end)
  manual     — parse a pasted bulletin text file (feed_status parse-degraded,
               raw text always preserved)
  live       — portal API (token required); graceful feed_status "unavailable"

The absence of a warning must never read as absence of risk: feed_status is
part of the artifact and surfaced in every briefing.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from .paths import contracts_dir, processed_dir
from .providers import Mode, provider_mode

LIVE_ENDPOINT = os.environ.get(
    "DEEPWEATHER_MF_BMS_ENDPOINT",
    "https://public-api.meteofrance.fr/public/DPBulletinsMarine/v1",
)

GALE_WORDS = re.compile(
    r"\b(gale|storm|BMS|coup de vent|tempête|avis de grand frais|force\s*[89]|force\s*1[012])\b",
    re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _base_doc(mode: Mode, name: str) -> dict:
    return {
        "schema_version": 1,
        "fetched_at": _now_iso(),
        "source": {"mode": mode.value, "name": name},
        "feed_status": "ok",
        "bulletins": [],
        "coverage_note": "FR zones only; UK shipping-forecast zones modeled but not fetched",
    }


def synthetic_doc(gale_zone: str | None = None, hours: int = 24) -> dict:
    doc = _base_doc(Mode.SYNTHETIC, "Météo-France BMS (synthetic)")
    if gale_zone:
        now = datetime.now(timezone.utc)
        doc["bulletins"].append(
            {
                "zone_id": gale_zone,
                "zone_name": gale_zone.replace("-", " ").title(),
                "kind": "BMS-large",
                "severity": "gale",
                "valid_from": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "valid_to": (now + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "raw_text": (
                    "SYNTHETIC BULLETIN — Avis de coup de vent. W or SW gale force 8 "
                    "expected. Generated for testing; never use for a real passage decision."
                ),
                "parse_confidence": 1.0,
            }
        )
    return doc


def parse_manual_bulletin(raw_text: str, zone_id: str, valid_hours: int = 24) -> dict:
    """Best-effort parse of a pasted bulletin. Raw text is always preserved."""
    doc = _base_doc(Mode.FIXTURE, "manual paste")
    doc["feed_status"] = "parse-degraded"
    severity = "gale" if GALE_WORDS.search(raw_text) else None
    confidence = 0.7 if severity else 0.4
    now = datetime.now(timezone.utc)
    doc["bulletins"].append(
        {
            "zone_id": zone_id,
            "zone_name": zone_id.replace("-", " ").title(),
            "kind": "BMS-manual",
            "severity": severity,
            "valid_from": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "valid_to": (now + timedelta(hours=valid_hours)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "raw_text": raw_text.strip(),
            "parse_confidence": confidence,
        }
    )
    return doc


def fetch_live() -> dict:
    """Portal API client — ready for when a Météo-France account exists."""
    token = os.environ.get("DEEPWEATHER_MF_API_TOKEN")
    doc = _base_doc(Mode.LIVE, "Météo-France BMS")
    if not token:
        doc["feed_status"] = "unavailable"
        doc["coverage_note"] = (
            "live mode configured but DEEPWEATHER_MF_API_TOKEN is not set — "
            "create a (free) account on the Météo-France API portal"
        )
        return doc
    try:
        response = requests.get(
            f"{LIVE_ENDPOINT}/bulletins",
            headers={"Authorization": f"Bearer {token}"},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as error:  # noqa: BLE001 — any feed failure must degrade, not crash
        doc["feed_status"] = "unavailable"
        doc["coverage_note"] = f"live fetch failed: {error}"
        return doc
    # Portal payload shape to be confirmed against a real token; keep raw + defensive.
    for item in payload.get("bulletins", []):
        doc["bulletins"].append(
            {
                "zone_id": str(item.get("zone", "unknown")).lower(),
                "zone_name": item.get("zoneName", ""),
                "kind": item.get("type", "BMS"),
                "severity": item.get("severity"),
                "valid_from": item.get("validFrom", _now_iso()),
                "valid_to": item.get("validTo", _now_iso()),
                "raw_text": json.dumps(item, ensure_ascii=False),
                "parse_confidence": 0.9,
            }
        )
    return doc


def write_warnings(doc: dict) -> Path:
    from jsonschema import Draft202012Validator

    schema = json.loads((contracts_dir() / "warnings.schema.json").read_text())
    Draft202012Validator(schema).validate(doc)

    out_dir = processed_dir("warnings")
    stamp = doc["fetched_at"].replace("-", "").replace(":", "")
    (out_dir / f"{stamp}.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    latest = out_dir / "latest.json"
    latest.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    return latest


def fetch_warnings(gale_zone: str | None = None, paste_file: str | None = None) -> Path:
    if paste_file:
        doc = parse_manual_bulletin(Path(paste_file).read_text(), zone_id=gale_zone or "casquets")
        return write_warnings(doc)
    mode = provider_mode("warnings_fr")
    if mode is Mode.LIVE:
        return write_warnings(fetch_live())
    return write_warnings(synthetic_doc(gale_zone))
