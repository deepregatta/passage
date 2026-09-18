"""Met Office shipping-forecast parsing, on the real 2026-07-17 page."""

import json
import re
from datetime import datetime, timezone
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
VALIDITY = re.search(r"<p>Forecast valid from:.*?</p>", FIXTURE).group()
ISSUE = re.search(r"<p>Issued by the Met Office.*?</p>", FIXTURE).group()
SUMMARY = re.search(r"<p>The shipping forecast issued.*?</p>", FIXTURE).group()
UNRELATED = "<p>Page updated 09:00 (UTC+1) on Fri 17 Jul 2026</p>"


@pytest.mark.parametrize(
    "page",
    [
        UNRELATED + FIXTURE,
        FIXTURE.replace(ISSUE, UNRELATED + ISSUE),
        FIXTURE.replace(VALIDITY, "").replace(ISSUE, ISSUE + VALIDITY),
        FIXTURE.replace(VALIDITY, "").replace(ISSUE, ""),  # body summary alone
        FIXTURE.replace(SUMMARY, ""),  # header alone
        FIXTURE.replace("<time ", '<span class="time" ').replace("</time>", "</span>"),
        FIXTURE.replace("Forecast valid from:", "Forecast <b>valid</b> from:")
        .replace("Issued by", "Issued\nby")
        .replace(" on Fri", "&nbsp;on Fri"),
        "<p>Archived 99:00 (UTC+1) on Fri 31 Feb 2026</p>" + FIXTURE,
    ],
    ids=["prepend", "between", "reorder", "body-only", "header-only", "tags", "space", "noise"],
)
def test_labeled_times_ignore_page_order_and_unrelated_timestamps(page, monkeypatch):
    assert parse_shipping_forecast(page) == parse_shipping_forecast(FIXTURE)
    mock_page(monkeypatch, FIXTURE)
    expected = fetch_uk_gale_bulletins(ROUTE_ZONES)
    mock_page(monkeypatch, page)
    assert fetch_uk_gale_bulletins(ROUTE_ZONES) == expected


@pytest.mark.parametrize(
    "page",
    [
        FIXTURE.replace("Sat 18 Jul 2026", "Thu 16 Jul 2026"),
        FIXTURE.replace("Sat 18 Jul 2026", "Fri 17 Jul 2026"),
        FIXTURE.replace("10:30 (UTC+1) on Fri 17", "13:00 (UTC+1) on Sat 18"),
        FIXTURE.replace("10:30 (UTC+1) on Fri 17", "12:00 (UTC+1) on Sat 18"),
        FIXTURE.replace("10:30 (UTC+1)", "09:30 (UTC+1)", 1),
        FIXTURE.replace("12:00 (UTC+1)", "11:00 (UTC+1)", 1),
        FIXTURE.replace("Sat 18 Jul 2026", "Sun 19 Jul 2026", 1),
        FIXTURE.replace(ISSUE, "").replace(SUMMARY, "") + UNRELATED,
        FIXTURE.replace(VALIDITY, "").replace(SUMMARY, "") + UNRELATED,
        FIXTURE.replace("10:30 (UTC+1)", "time unavailable"),
        FIXTURE.replace("Sat 18 Jul 2026", "Tue 31 Feb 2026"),
        FIXTURE.replace("Jul 2026", "Foo 2026"),
        FIXTURE.replace("(UTC+1)", "(UTC+24)"),
        FIXTURE.replace("12:00 (UTC+1)", "25:00 (UTC+1)"),
        FIXTURE.replace("Forecast valid from:", "Unlabeled:")
        .replace("Issued by", "Published by")
        .replace(SUMMARY, ""),
    ],
    ids=[
        "reversed",
        "empty",
        "issue-after-end",
        "issue-at-end",
        "conflicting-issue",
        "conflicting-start",
        "conflicting-end",
        "missing-issue",
        "missing-period",
        "malformed-issue",
        "invalid-date",
        "invalid-month",
        "invalid-offset",
        "invalid-hour",
        "unlabeled",
    ],
)
def test_invalid_forecast_times_reject_parser_and_bulletins(page, monkeypatch):
    with pytest.raises(ValueError, match="shipping forecast page:"):
        parse_shipping_forecast(page)
    mock_page(monkeypatch, page)
    with pytest.raises(ValueError, match="shipping forecast page:"):
        fetch_uk_gale_bulletins(ROUTE_ZONES)


@pytest.mark.parametrize("offset, hour", [("", 12), ("+1", 11), ("-2", 14)])
def test_labeled_times_convert_offsets_to_utc(offset, hour):
    page = FIXTURE.replace("UTC+1", f"UTC{offset}")
    parsed = parse_shipping_forecast(page)
    assert parsed["valid_from"] == datetime(2026, 7, 17, hour, tzinfo=timezone.utc)
    assert parsed["valid_to"] == datetime(2026, 7, 18, hour, tzinfo=timezone.utc)


def test_issue_during_forecast_period_remains_valid(monkeypatch):
    page = FIXTURE.replace("10:30 (UTC+1)", "13:30 (UTC+1)")
    mock_page(monkeypatch, page)
    bulletins, _ = fetch_uk_gale_bulletins(ROUTE_ZONES)
    assert bulletins[0]["valid_from"] == "2026-07-17T12:30:00Z"
    assert bulletins[0]["valid_to"] == "2026-07-18T11:00:00Z"


@pytest.mark.parametrize(
    "page",
    [
        FIXTURE.replace("Sat 18 Jul 2026", "Thu 16 Jul 2026"),
        FIXTURE.replace(ISSUE, "").replace(SUMMARY, ""),
        FIXTURE.replace("10:30 (UTC+1)", "09:30 (UTC+1)", 1),
    ],
    ids=["reversed", "missing-issue", "conflicting-issue"],
)
def test_rejected_times_degrade_feed_without_adding_bulletins(page, monkeypatch):
    from deepweather_analysis.warnings_mf import _merge_uk_warnings

    mock_page(monkeypatch, page)
    monkeypatch.setattr("deepweather_analysis.warnings_mf._route_zones", lambda _: ROUTE_ZONES)
    existing_bulletin = {"zone_id": "existing-fr-warning"}
    doc = {
        "bulletins": [existing_bulletin],
        "feed_status": "ok",
        "coverage_note": "Existing coverage.",
        "source": {"name": "Meteo-France"},
    }
    result = _merge_uk_warnings(doc)
    assert result["feed_status"] == "parse-degraded"
    assert "UK feed unavailable: shipping forecast page:" in result["coverage_note"]
    assert result["bulletins"] == [existing_bulletin]
    assert result["source"]["name"] == "Meteo-France"


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
