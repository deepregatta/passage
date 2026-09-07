"""Met Office shipping-forecast parsing, on the real 2026-07-17 page."""

import json
import re
from pathlib import Path

import pytest

from deepweather_analysis.warnings_uk import (
    _area_matches,
    fetch_uk_gale_bulletins,
    parse_shipping_forecast,
)

FIXTURE = (Path(__file__).parent / "fixtures" / "shipping-forecast-2026-07-17.html").read_text()
GALE_FORMS = json.loads(
    (Path(__file__).parent / "fixtures" / "shipping-forecast-gale-forms.json").read_text()
)
ROUTE_ZONES = [
    {"zone_id": name.lower(), "zone_name": name}
    for name in ("Portland", "Plymouth", "Trafalgar", "Forties")
]


@pytest.fixture(params=GALE_FORMS, ids=lambda form: form["id"])
def gale_form(request):
    form = request.param
    page = re.sub(
        r'<p class="warning">.*?</p>',
        f'<p class="warning">{form["sentence"]}</p>',
        FIXTURE,
    )
    return page, form["expected_zones"]


def mock_page(monkeypatch, page):
    class Response:
        text = page

        def raise_for_status(self):
            pass

    monkeypatch.setattr(
        "deepweather_analysis.warnings_uk.requests.get",
        lambda *args, **kwargs: Response(),
    )


def test_gale_forms_parse(gale_form):
    page, expected_zones = gale_form
    parsed = parse_shipping_forecast(page)
    assert [
        zone["zone_name"]
        for zone in ROUTE_ZONES
        if any(_area_matches(zone["zone_name"], area) for area in parsed["gale_areas"])
    ] == expected_zones
    if not expected_zones:
        assert parsed["gale_areas"] == []  # "in force" is not an area


def test_gale_forms_emit_only_affected_route_bulletins(gale_form, monkeypatch):
    page, expected_zones = gale_form
    mock_page(monkeypatch, page)
    bulletins, note = fetch_uk_gale_bulletins(ROUTE_ZONES)
    assert [b["zone_name"] for b in bulletins] == expected_zones
    assert [b["zone_id"] for b in bulletins] == [name.lower() for name in expected_zones]
    for bulletin in bulletins:
        assert bulletin["kind"] == "gale-warning"
        assert bulletin["severity"] == "gale"
        assert bulletin["valid_from"] == "2026-07-17T09:30:00Z"
        assert bulletin["valid_to"] == "2026-07-18T11:00:00Z"
        assert bulletin["zone_name"] in bulletin["raw_text"]
    assert "issued 2026-07-17T09:30:00Z" in note


def test_all_areas_warning_does_not_require_area_forecast_text(monkeypatch):
    page = re.sub(
        r'<p class="warning">.*?</p>',
        '<p class="warning">There are warnings of gales in all areas except Trafalgar.</p>',
        FIXTURE,
    )
    page = re.sub(r'<h3 class="area-forecast-heading">.*?</h3>', "", page)
    mock_page(monkeypatch, page)
    bulletins, _ = fetch_uk_gale_bulletins(ROUTE_ZONES)
    assert [b["zone_name"] for b in bulletins] == ["Portland", "Plymouth", "Forties"]


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
