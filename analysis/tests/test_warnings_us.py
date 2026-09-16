"""NWS active-alerts parsing, on the real 2026-07-17 response (a live Small
Craft Advisory covering Rhode Island Sound and Block Island Sound)."""

import json
from pathlib import Path

from deepweather_analysis.warnings_us import _severity, parse_alerts

ALERTS = json.loads((Path(__file__).parent / "fixtures" / "nws-alerts-2026-07-17.json").read_text())

ROUTE_ZONES = [
    {"zone_id": "rhode-island-sound", "zone_name": "Rhode Island Sound", "nws_zone": "ANZ235"},
    {"zone_id": "block-island-sound", "zone_name": "Block Island Sound", "nws_zone": "ANZ237"},
    {"zone_id": "new-york-harbor", "zone_name": "New York Harbor", "nws_zone": "ANZ338"},
]


def test_parse_real_response():
    bulletins, note = parse_alerts(ALERTS, ROUTE_ZONES)
    # one SCA whose UGC list includes ANZ235 and ANZ237 (not ANZ338)
    assert [b["zone_id"] for b in bulletins] == ["rhode-island-sound", "block-island-sound"]
    for bulletin in bulletins:
        assert bulletin["kind"] == "nws-small-craft-advisory"
        assert bulletin["severity"] == "near-gale"
        # onset 2026-07-18T11:00-04:00, ends 2026-07-19T12:00-04:00 -> UTC
        assert bulletin["valid_from"] == "2026-07-18T15:00:00Z"
        assert bulletin["valid_to"] == "2026-07-19T16:00:00Z"
        assert "Small Craft Advisory" in bulletin["raw_text"]
        assert "Southwest winds 15 to 25 kt" in bulletin["raw_text"]
    assert "2 bulletin(s) in force" in note


def test_statements_and_watches_are_counted_not_emitted():
    doc = json.loads(json.dumps(ALERTS))
    doc["features"][0]["properties"]["event"] = "Marine Weather Statement"
    bulletins, note = parse_alerts(doc, ROUTE_ZONES)
    assert bulletins == []
    assert "Marine Weather Statement" in note

    doc["features"][0]["properties"]["event"] = "Gale Watch"
    bulletins, _ = parse_alerts(doc, ROUTE_ZONES)
    assert bulletins == []


def test_unknown_warning_event_still_becomes_bulletin_without_severity():
    doc = json.loads(json.dumps(ALERTS))
    doc["features"][0]["properties"]["event"] = "Hazardous Seas Warning"
    bulletins, _ = parse_alerts(doc, ROUTE_ZONES)
    assert len(bulletins) == 2
    assert all(b["severity"] is None for b in bulletins)
    assert bulletins[0]["kind"] == "nws-hazardous-seas-warning"


def test_alerts_outside_route_zones_are_ignored():
    bulletins, note = parse_alerts(ALERTS, [{"zone_id": "x", "nws_zone": "ANZ999"}])
    assert bulletins == []
    assert "0 bulletin(s) in force" in note


def test_route_zones_config_matches_real_nws_ugc_codes():
    from deepweather_analysis.warnings_mf import _route_zones

    zones = _route_zones("us_zones")
    assert [z["nws_zone"] for z in zones] == [
        "ANZ235",
        "ANZ237",
        "ANZ350",
        "ANZ353",
        "ANZ355",
        "ANZ338",
    ]
    bulletins, _ = parse_alerts(ALERTS, zones)
    assert {b["zone_id"] for b in bulletins} == {"rhode-island-sound", "block-island-sound"}


def test_severity_scale_matches_fr_vocabulary():
    assert _severity("Gale Warning") == "gale"
    assert _severity("Storm Warning") == "storm"
    assert _severity("Hurricane Force Wind Warning") == "hurricane"
    assert _severity("Small Craft Advisory for Hazardous Seas") == "near-gale"
    assert _severity("Special Marine Warning") == "storm"
    assert _severity("Dense Fog Advisory") is None


def test_only_actual_alerts_emit_bulletins():
    from copy import deepcopy

    for status in ("Test", "Exercise", "System", "Draft", None, "", "Unknown"):
        doc = deepcopy(ALERTS)
        doc["features"][0]["properties"]["status"] = status
        bulletins, _ = parse_alerts(doc, ROUTE_ZONES)
        assert bulletins == [], status
    doc = deepcopy(ALERTS)
    del doc["features"][0]["properties"]["status"]
    assert parse_alerts(doc, ROUTE_ZONES)[0] == []
    doc["features"].append(deepcopy(ALERTS["features"][0]))
    assert parse_alerts(doc, ROUTE_ZONES)[0] == parse_alerts(ALERTS, ROUTE_ZONES)[0]
