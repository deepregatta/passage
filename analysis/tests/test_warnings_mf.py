"""BMS live-feed parsing: validity, severity, and route-zone matching."""

import csv
import gzip
import io
from datetime import datetime, timezone

import pytest

from deepweather_analysis.warnings_mf import (
    _normalize,
    _parse_validity,
    _route_zone_tokens,
    _severity,
    fetch_live,
    parse_manual_bulletin,
)

# Trimmed from a real bms_2026.csv row (Manche Est et Sud Mer du Nord, 13 July 2026).
REAL_BULLETIN = """
ORIGINE METEO-FRANCE.
BMS LARGE SUD MER DU NORD ET EST DE MANCHE NR 53
LUNDI 13 JUILLET 2026 A 09H10 UTC
COUP DE VENT EN COURS OU PREVU POUR ANTIFER.

ANTIFER.
IMMINENT ET VALABLE JUSQU'AU 13 A 18H UTC.
SECTEUR NORD-EST 8. FORTES RAFALES.

FIN.
"""

# Adapt the recorded bulletin to a registered route; all transport is mocked.
NOW = datetime(2026, 7, 13, 12, tzinfo=timezone.utc)
ACTIVE_ROW = {
    "date": "2026-07-13 09:14:00",
    "langue": "FR",
    "zone": "Manche Est et Sud Mer du Nord",
    "type": "large",
    "contenu": REAL_BULLETIN.replace("ANTIFER", "CASQUETS"),
}
CANCELLATIONS = [
    "FIN D'AVIS DE COUP DE VENT POUR CASQUETS.",
    "Fin d’avis de tempête pour Casquets.",
    "FIN D AVIS DE GRAND FRAIS POUR CASQUETS.",
    "LEVÉE DE L'AVIS DE COUP DE VENT POUR CASQUETS.",
    "LEVEE DU BMS POUR CASQUETS. AVIS DE TEMPETE TERMINE.",
]


def mock_csv(monkeypatch, rows, fields=None):
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=fields or list(ACTIVE_ROW), delimiter=";")
    writer.writeheader()
    writer.writerows(rows)
    mock_response(monkeypatch, gzip.compress(stream.getvalue().encode("utf-8")))


def mock_response(monkeypatch, payload):
    class Response:
        content = payload

        def raise_for_status(self):
            pass

    monkeypatch.setattr(
        "deepweather_analysis.warnings_mf.requests.get", lambda *args, **kwargs: Response()
    )


def test_fetch_live_preserves_active_bulletin(monkeypatch):
    mock_csv(monkeypatch, [ACTIVE_ROW])
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "ok"
    assert doc["source"]["mode"] == "live"
    assert len(doc["bulletins"]) == 1
    bulletin = doc["bulletins"][0]
    assert bulletin["zone_id"] == "casquets"
    assert bulletin["kind"] == "BMS-large"
    assert bulletin["severity"] == "gale"
    assert bulletin["valid_from"] == "2026-07-13T09:14:00Z"
    assert bulletin["valid_to"] == "2026-07-13T18:00:00Z"
    assert bulletin["raw_text"] == ACTIVE_ROW["contenu"].strip()
    assert bulletin["parse_confidence"] == 0.85


@pytest.mark.parametrize("field", list(ACTIVE_ROW))
def test_missing_csv_column_is_unavailable_even_without_rows(monkeypatch, field):
    mock_csv(monkeypatch, [], fields=[key for key in ACTIVE_ROW if key != field])
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "unavailable"
    assert doc["bulletins"] == []
    assert field in doc["coverage_note"]


@pytest.mark.parametrize(
    "bad_values",
    [
        {"date": "not a date"},
        {"date": "2026-02-30 09:14:00"},
        *[{field: ""} for field in ACTIVE_ROW],
    ],
)
def test_bad_row_degrades_and_preserves_good_rows(monkeypatch, bad_values):
    mock_csv(monkeypatch, [{**ACTIVE_ROW, **bad_values}, ACTIVE_ROW])
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "parse-degraded"
    assert [b["zone_id"] for b in doc["bulletins"]] == ["casquets"]
    assert "1 malformed" in doc["coverage_note"]


def test_only_malformed_rows_do_not_report_ok(monkeypatch):
    mock_csv(monkeypatch, [{**ACTIVE_ROW, "date": "invalid"}])
    doc = fetch_live(NOW)
    assert doc["feed_status"] in ("parse-degraded", "unavailable")
    assert doc["bulletins"] == []


@pytest.mark.parametrize("text", CANCELLATIONS)
def test_cancellation_has_no_active_severity(text):
    assert _severity(_normalize(text)) is None


@pytest.mark.parametrize("text", CANCELLATIONS)
def test_cancellation_never_emits_an_active_bulletin(monkeypatch, text):
    mock_csv(monkeypatch, [{**ACTIVE_ROW, "contenu": text}])
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "ok"
    # A null-severity bulletin still triggers the engine's authority override.
    assert doc["bulletins"] == []


def test_cancellation_does_not_discard_another_zone_warning(monkeypatch):
    mock_csv(
        monkeypatch,
        [{**ACTIVE_ROW, "contenu": "FIN D'AVIS DE COUP DE VENT POUR HAGUE."}, ACTIVE_ROW],
    )
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "ok"
    assert [b["zone_id"] for b in doc["bulletins"]] == ["casquets"]


@pytest.mark.parametrize("text", CANCELLATIONS)
def test_manual_cancellation_preserves_text_without_active_bulletin(text):
    doc = parse_manual_bulletin(text, "casquets")
    assert doc["feed_status"] == "parse-degraded"
    assert doc["source"]["mode"] == "fixture"
    assert doc["bulletins"] == []
    assert text in doc["coverage_note"]


def test_manual_active_warning_is_preserved():
    doc = parse_manual_bulletin(ACTIVE_ROW["contenu"], "casquets")
    assert doc["feed_status"] == "parse-degraded"
    assert len(doc["bulletins"]) == 1
    assert doc["bulletins"][0]["severity"] == "gale"
    assert doc["bulletins"][0]["raw_text"] == ACTIVE_ROW["contenu"].strip()


def test_valid_empty_feed_is_ok(monkeypatch):
    mock_csv(monkeypatch, [])
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "ok"
    assert doc["bulletins"] == []


@pytest.mark.parametrize(
    "row",
    [
        "2026-07-13 09:14:00;FR;Manche Est et Sud Mer du Nord\n",
        "2026-07-13 09:14:00;FR;Manche Est et Sud Mer du Nord;large;CASQUETS;extra\n",
    ],
    ids=["truncated", "surplus-columns"],
)
def test_wrong_cell_count_degrades(monkeypatch, row):
    text = ";".join(ACTIVE_ROW) + "\n" + row
    mock_response(monkeypatch, gzip.compress(text.encode("utf-8")))
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "parse-degraded"
    assert doc["bulletins"] == []
    assert "1 malformed" in doc["coverage_note"]


@pytest.mark.parametrize(
    "payload",
    [
        b"not gzip",
        gzip.compress(b""),
        gzip.compress(b'date;langue;zone;type;contenu\n"unterminated'),
    ],
    ids=["bad-gzip", "empty-body", "bad-csv"],
)
def test_unreadable_feed_is_unavailable(monkeypatch, payload):
    mock_response(monkeypatch, payload)
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "unavailable"
    assert doc["bulletins"] == []


def test_network_failure_is_unavailable(monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("test feed offline")

    monkeypatch.setattr("deepweather_analysis.warnings_mf.requests.get", fail)
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "unavailable"
    assert doc["bulletins"] == []
    assert "test feed offline" in doc["coverage_note"]


def test_parse_validity_same_month():
    issued = datetime(2026, 7, 13, 9, 14, tzinfo=timezone.utc)
    valid_from, valid_to, confidence = _parse_validity(_normalize(REAL_BULLETIN), issued)
    assert valid_from is None
    assert valid_to == "2026-07-13T18:00:00Z"
    assert confidence == 0.85


def test_parse_validity_cote_phrasing_with_weekday_and_month():
    issued = datetime(2026, 7, 13, 9, 15, tzinfo=timezone.utc)
    norm = _normalize("En cours et valable jusqu'au lundi 13 juillet à 22H00 UTC")
    _, valid_to, confidence = _parse_validity(norm, issued)
    assert valid_to == "2026-07-13T22:00:00Z"
    assert confidence == 0.85


def test_parse_validity_range_form():
    issued = datetime(2026, 6, 5, 3, 21, tzinfo=timezone.utc)
    norm = _normalize("VALABLE DU VENDREDI 5 JUIN A 20H00 UTC AU SAMEDI 6 JUIN A 06H00 UTC")
    valid_from, valid_to, confidence = _parse_validity(norm, issued)
    assert valid_from == "2026-06-05T20:00:00Z"
    assert valid_to == "2026-06-06T06:00:00Z"
    assert confidence == 0.85


def test_parse_validity_year_rollover_with_month_name():
    issued = datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc)
    _, valid_to, _ = _parse_validity(
        _normalize("VALABLE JUSQU'AU JEUDI 1 JANVIER A 06H00 UTC"), issued
    )
    assert valid_to == "2027-01-01T06:00:00Z"


def test_parse_validity_month_rollover():
    issued = datetime(2026, 7, 31, 22, 0, tzinfo=timezone.utc)
    _, valid_to, _ = _parse_validity(_normalize("VALABLE JUSQU'AU 1 A 06H UTC"), issued)
    assert valid_to == "2026-08-01T06:00:00Z"


def test_parse_validity_missing_degrades():
    issued = datetime(2026, 7, 13, 9, 14, tzinfo=timezone.utc)
    valid_from, valid_to, confidence = _parse_validity(_normalize("PAS DE MENTION"), issued)
    assert valid_from is None
    assert valid_to is None
    assert confidence == 0.5


def test_severity_ladder():
    assert _severity(_normalize(REAL_BULLETIN)) == "gale"
    assert _severity(_normalize("AVIS DE TEMPETE")) == "storm"
    assert _severity(_normalize("FORTE TEMPETE ATTENDUE")) == "violent-storm"
    assert _severity(_normalize("AVIS DE GRAND FRAIS")) == "near-gale"
    assert _severity(_normalize("RIEN A SIGNALER")) is None


def test_route_zone_tokens_match_casquets_bulletin():
    tokens = dict((zone_id, toks) for zone_id, _, toks in _route_zone_tokens())
    assert "casquets" in tokens
    norm = _normalize("COUP DE VENT EN COURS POUR CASQUETS ET OUESSANT.")
    assert any(tok in norm for tok in tokens["casquets"])
    # the Antifer-only bulletin must NOT match the Casquets zone
    assert not any(tok in _normalize(REAL_BULLETIN) for tok in tokens["casquets"])
