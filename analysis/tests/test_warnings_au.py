"""BOM marine wind warning summary parsing, on the real 2026-07-17 IDQ20085
product (a live Gale Warning for Sunshine Coast + Gold Coast Waters and Strong
Wind Warnings across the route zones, plus a Cairns Coast cancellation)."""

from datetime import datetime, timezone
from pathlib import Path

from deepweather_analysis.warnings_au import _severity, parse_bom_mww

XML = (Path(__file__).parent / "fixtures" / "bom-mww-qld-2026-07-17.xml").read_text()

ROUTE_ZONES = [
    {"zone_id": "moreton-bay", "zone_name": "Moreton Bay", "aac": "QLD_MW013"},
    {
        "zone_id": "sunshine-coast-waters",
        "zone_name": "Sunshine Coast Waters: Double Island Point to Cape Moreton",
        "aac": "QLD_MW012",
    },
    {"zone_id": "kgari-coast", "zone_name": "K'gari Coast", "aac": "QLD_MW011"},
    {"zone_id": "capricornia-coast", "zone_name": "Capricornia Coast", "aac": "QLD_MW009"},
]

NOW = datetime(2026, 7, 17, 18, 0, tzinfo=timezone.utc)


def test_parse_real_product():
    bulletins, issue_time, cancelled = parse_bom_mww(XML, ROUTE_ZONES, now=NOW)
    assert issue_time == "2026-07-17T17:00:00Z"

    # day0: gale on Sunshine Coast; strong wind on Capricornia, K'gari, Moreton Bay
    day0 = [b for b in bulletins if b["valid_from"] == "2026-07-17T17:00:00Z"]
    assert [b["zone_id"] for b in day0 if b["severity"] == "gale"] == ["sunshine-coast-waters"]
    strong = [b for b in day0 if b["severity"] == "near-gale"]
    assert {b["zone_id"] for b in strong} == {"capricornia-coast", "kgari-coast", "moreton-bay"}
    for b in day0:
        assert b["valid_to"] == "2026-07-19T14:00:00Z"
        assert b["parse_confidence"] == 0.95

    # day1: strong wind renews on all four route zones (the day1 gale is Gold
    # Coast Waters only — off-route, must not match)
    day1 = [b for b in bulletins if b["valid_from"] == "2026-07-18T14:00:00Z"]
    assert {b["zone_id"] for b in day1} == {z["zone_id"] for z in ROUTE_ZONES}
    assert all(b["severity"] == "near-gale" for b in day1)

    # the Cairns Coast cancellation is counted, never emitted
    assert cancelled == 1
    assert all("Cairns" not in b["raw_text"] for b in bulletins)


def test_kind_and_raw_text_come_from_phenomena():
    bulletins, _, _ = parse_bom_mww(XML, ROUTE_ZONES, now=NOW)
    gale = next(b for b in bulletins if b["severity"] == "gale")
    assert gale["kind"] == "bom-gale-warning"
    assert gale["raw_text"] == "Gale Warning for Sunshine Coast Waters and Gold Coast Waters"


def test_expired_periods_are_dropped():
    late = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)  # after every end-time-utc
    bulletins, _, _ = parse_bom_mww(XML, ROUTE_ZONES, now=late)
    assert bulletins == []


def test_zones_outside_route_are_ignored():
    bulletins, _, _ = parse_bom_mww(
        XML, [{"zone_id": "x", "zone_name": "X", "aac": "QLD_MW999"}], now=NOW
    )
    assert bulletins == []


def test_route_zones_config_matches_real_bom_aac_codes():
    from deepweather_analysis.warnings_mf import _route_zones

    zones = _route_zones("au_zones")
    assert [z["aac"] for z in zones] == ["QLD_MW013", "QLD_MW012", "QLD_MW011", "QLD_MW009"]
    assert all(z["bom_product"] == "IDQ20085" for z in zones)
    bulletins, _, _ = parse_bom_mww(XML, zones, now=NOW)
    assert {b["zone_id"] for b in bulletins} >= {"sunshine-coast-waters", "moreton-bay"}


def test_severity_scale_matches_fr_vocabulary():
    assert _severity("Gale Warning", "GALE") == "gale"
    assert _severity("Strong Wind Warning", "STR") == "near-gale"
    assert _severity("Storm Force Wind Warning", "STORM") == "storm"
    assert _severity("Hurricane Force Wind Warning", "HUR") == "hurricane"
    # unknown phenomena falls back to the severity attribute, then to null
    assert _severity("", "GALE") == "gale"
    assert _severity("Mystery Warning", "UNK") is None
