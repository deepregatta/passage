"""BMS live-feed parsing: validity, severity, and route-zone matching."""

from datetime import datetime, timezone

from deepweather_analysis.warnings_mf import (
    _normalize,
    _parse_validity,
    _route_zone_tokens,
    _severity,
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
