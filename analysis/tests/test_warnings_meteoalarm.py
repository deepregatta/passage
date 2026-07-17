"""Meteoalarm CAP parsing, on real 2026-07-17 feed content (AEMET/Spain): a
yellow coastal galerna warning (Bizkaia), a green all-clear coastalevent entry
covering the three Palma–Barcelona route zones, a green wind entry, and an
orange high-temperature warning (non-marine)."""

import json
from datetime import datetime, timezone
from pathlib import Path

from deepweather_analysis.warnings_meteoalarm import parse_meteoalarm

FEED = json.loads(
    (Path(__file__).parent / "fixtures" / "meteoalarm-es-2026-07-17.json").read_text()
)

# in-force window for the fixture's galerna warning (expires 2026-07-12T18:59:59Z)
NOW = datetime(2026, 7, 12, 16, 0, tzinfo=timezone.utc)

BIZKAIA = {
    "zone_id": "costa-bizkaia",
    "zone_name": "Costa - Bizkaia litoral",
    "emma_id": "ES841",
    "country": "spain",
}
ROUTE_ZONES = [
    {"zone_id": "costa-sur-de-mallorca", "zone_name": "Costa - Sur de Mallorca", "emma_id": "ES874", "country": "spain"},
    {"zone_id": "costa-sierra-tramontana", "zone_name": "Costa - Sierra Tramontana", "emma_id": "ES875", "country": "spain"},
    {"zone_id": "costa-litoral-de-barcelona", "zone_name": "Costa - Litoral de Barcelona", "emma_id": "ES869", "country": "spain"},
]


def test_yellow_coastal_warning_becomes_bulletin():
    bulletins, note = parse_meteoalarm(FEED, [BIZKAIA], "spain", now=NOW)
    assert [b["zone_id"] for b in bulletins] == ["costa-bizkaia"]
    bulletin = bulletins[0]
    assert bulletin["kind"] == "meteoalarm-coastalevent"
    assert bulletin["severity"] == "near-gale"  # yellow
    # onset 2026-07-12T17:00+02:00, expires 2026-07-12T20:59:59+02:00 -> UTC
    assert bulletin["valid_from"] == "2026-07-12T15:00:00Z"
    assert bulletin["valid_to"] == "2026-07-12T18:59:59Z"
    assert "galerna" in bulletin["raw_text"].lower()
    assert "1 marine bulletin(s) in force" in note


def test_green_entries_are_all_clear_never_bulletins():
    # the fixture's route-zone coastalevent entry is green (Minor) — all clear
    now = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    bulletins, note = parse_meteoalarm(FEED, ROUTE_ZONES, "spain", now=now)
    assert bulletins == []
    assert "0 marine bulletin(s) in force" in note


def test_non_marine_warnings_are_counted_not_emitted():
    mallorca_interior = {
        "zone_id": "interior-mallorca", "zone_name": "Interior de Mallorca",
        "emma_id": "ES116", "country": "spain",
    }
    bulletins, note = parse_meteoalarm(FEED, [mallorca_interior], "spain", now=NOW)
    assert bulletins == []
    assert "non-marine warning(s) on route zones not emitted" in note
    assert "high-temperature" in note


def test_expired_warnings_are_dropped():
    late = datetime(2026, 7, 13, 12, 0, tzinfo=timezone.utc)
    bulletins, _ = parse_meteoalarm(FEED, [BIZKAIA], "spain", now=late)
    assert bulletins == []


def test_orange_maps_to_gale_and_unknown_colour_keeps_null_severity():
    doc = json.loads(json.dumps(FEED))
    for warning in doc["warnings"]:
        for info in warning["alert"]["info"]:
            for parameter in info["parameter"]:
                if parameter["valueName"] == "awareness_level":
                    parameter["value"] = "3; orange; Severe"
    bulletins, _ = parse_meteoalarm(doc, [BIZKAIA], "spain", now=NOW)
    assert bulletins[0]["severity"] == "gale"

    for warning in doc["warnings"]:
        for info in warning["alert"]["info"]:
            for parameter in info["parameter"]:
                if parameter["valueName"] == "awareness_level":
                    parameter["value"] = "5; purple; Catastrophic"
    bulletins, _ = parse_meteoalarm(doc, [BIZKAIA], "spain", now=NOW)
    assert len(bulletins) >= 1
    assert all(b["severity"] is None for b in bulletins)


def test_cancelled_and_superseded_alerts_are_dropped():
    doc = json.loads(json.dumps(FEED))
    galerna = next(
        w["alert"] for w in doc["warnings"]
        if any("galerna" in (i.get("event") or "") for i in w["alert"]["info"])
    )
    galerna["msgType"] = "Cancel"
    bulletins, _ = parse_meteoalarm(doc, [BIZKAIA], "spain", now=NOW)
    assert bulletins == []

    doc = json.loads(json.dumps(FEED))
    galerna = next(
        w["alert"] for w in doc["warnings"]
        if any("galerna" in (i.get("event") or "") for i in w["alert"]["info"])
    )
    doc["warnings"].append(
        {"alert": {"identifier": "x", "status": "Actual", "msgType": "Update",
                   "references": f"www.aemet.es,{galerna['identifier']},2026-07-12T09:00:00+00:00",
                   "info": []}}
    )
    bulletins, _ = parse_meteoalarm(doc, [BIZKAIA], "spain", now=NOW)
    assert bulletins == []


def test_route_zones_config_matches_real_emma_ids():
    from deepweather_analysis.warnings_mf import _route_zones

    zones = _route_zones("meteoalarm_zones")
    assert [z["emma_id"] for z in zones] == ["ES874", "ES875", "ES869"]
    assert all(z["country"] == "spain" for z in zones)
    # the fixture's real feed content addresses all three route zones
    fixture_emmas = {
        g["value"]
        for w in FEED["warnings"]
        for i in w["alert"]["info"]
        for a in i.get("area", [])
        for g in a.get("geocode", [])
    }
    assert {"ES874", "ES875", "ES869"} <= fixture_emmas
