"""Met Office shipping-forecast parsing, on the real 2026-07-17 page."""

from pathlib import Path

from deepweather_analysis.warnings_uk import _area_matches, parse_shipping_forecast

FIXTURE = (Path(__file__).parent / "fixtures" / "shipping-forecast-2026-07-17.html").read_text()


def test_parse_real_page():
    parsed = parse_shipping_forecast(FIXTURE)
    # issued 10:30 UTC+1 -> 09:30 UTC; valid 12:00 UTC+1 -> 11:00 UTC
    assert parsed["issued"].strftime("%Y-%m-%dT%H:%M:%SZ") == "2026-07-17T09:30:00Z"
    assert parsed["valid_from"].strftime("%Y-%m-%dT%H:%M:%SZ") == "2026-07-17T11:00:00Z"
    assert parsed["valid_to"].strftime("%Y-%m-%dT%H:%M:%SZ") == "2026-07-18T11:00:00Z"
    assert parsed["gale_areas"] == ["Viking", "North Utsire", "South Utsire", "Forties", "Fisher"]
    # combined headings split into individual areas
    assert "Portland" in parsed["area_forecasts"]
    assert "Plymouth" in parsed["area_forecasts"]
    assert parsed["area_forecasts"]["Portland"].startswith("Cyclonic 3 to 5")


def test_route_zones_not_under_gale_on_this_page():
    parsed = parse_shipping_forecast(FIXTURE)
    for zone_name in ("Portland", "Plymouth"):
        assert not any(_area_matches(zone_name, area) for area in parsed["gale_areas"])


def test_area_matching_handles_qualified_names():
    assert _area_matches("Forties", "West Forties")
    assert _area_matches("Thames", "Southwest Thames")
    assert not _area_matches("Portland", "Plymouth")


def test_no_gales_sentence_absent():
    page = FIXTURE.replace("warnings of gales", "no warnings at all")
    parsed = parse_shipping_forecast(page)
    assert parsed["gale_areas"] == []
