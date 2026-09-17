"""BMS live-feed parsing: validity, severity, and route-zone matching."""

import csv
import gzip
import io
import json
from datetime import datetime, timedelta, timezone

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


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(tmp_path))


def mock_csv(monkeypatch, rows, fields=None):
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=fields or list(ACTIVE_ROW), delimiter=";")
    writer.writeheader()
    writer.writerows(rows)
    mock_response(monkeypatch, gzip.compress(stream.getvalue().encode("utf-8")))


def mock_response(monkeypatch, payload):
    class Response:
        status_code = 200
        headers = {}
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


@pytest.mark.parametrize(
    "issued, date_text, expected",
    [
        ("2026-09-01", "31 AOUT", "2026-08-31T18:00:00Z"),
        ("2026-01-01", "31 DECEMBRE", "2025-12-31T18:00:00Z"),
        ("2026-08-31", "1 SEPTEMBRE", "2026-09-01T18:00:00Z"),
        ("2026-12-31", "1 JANVIER", "2027-01-01T18:00:00Z"),
        ("2026-09-01", "31", "2026-08-31T18:00:00Z"),
        ("2026-01-01", "31", "2025-12-31T18:00:00Z"),
        ("2024-03-01", "29 FEVRIER", "2024-02-29T18:00:00Z"),
        ("2026-07-13", "6 JUILLET", "2026-07-06T18:00:00Z"),
        ("2026-07-13", "20 JUILLET", "2026-07-20T18:00:00Z"),
    ],
)
def test_validity_resolves_near_issue_time(issued, date_text, expected):
    issued = datetime.fromisoformat(issued).replace(hour=18, tzinfo=timezone.utc)
    assert _parse_validity(f"VALABLE JUSQU'AU {date_text} A 18H UTC", issued) == (
        None,
        expected,
        0.85,
    )


@pytest.mark.parametrize(
    "date_text",
    ["5 JUILLET", "21 JUILLET", "13 JANVIER", "31 JUIN", "29 FEVRIER", "13 INCONNU"],
)
def test_distant_or_invalid_explicit_validity_degrades(date_text):
    assert _parse_validity(f"VALABLE JUSQU'AU {date_text} A 18H UTC", NOW) == (None, None, 0.5)


@pytest.mark.parametrize(
    "issued, start, end, expected_start, expected_end",
    [
        ("2026-09-01", "31 AOUT", "1 SEPTEMBRE", "2026-08-31", "2026-09-01"),
        ("2026-01-01", "31 DECEMBRE", "1 JANVIER", "2025-12-31", "2026-01-01"),
        ("2026-12-31", "31 DECEMBRE", "1 JANVIER", "2026-12-31", "2027-01-01"),
    ],
)
def test_validity_range_across_month_and_year(issued, start, end, expected_start, expected_end):
    issued = datetime.fromisoformat(issued).replace(tzinfo=timezone.utc)
    assert _parse_validity(f"VALABLE DU {start} A 18H UTC AU {end} A 06H UTC", issued) == (
        f"{expected_start}T18:00:00Z",
        f"{expected_end}T06:00:00Z",
        0.85,
    )


@pytest.mark.parametrize(
    "issued, date_text, expected",
    [
        ("2026-09-01", "31 AOUT", "2026-08-31T18:00:00Z"),
        ("2026-01-01", "31 DECEMBRE", "2025-12-31T18:00:00Z"),
    ],
)
def test_fetch_live_expires_previous_month_validity(monkeypatch, issued, date_text, expected):
    mock_csv(
        monkeypatch,
        [
            {
                **ACTIVE_ROW,
                "date": f"{issued} 00:00:00",
                "contenu": f"COUP DE VENT POUR CASQUETS. VALABLE JUSQU'AU {date_text} A 18H UTC.",
            }
        ],
    )
    now = datetime.fromisoformat(issued).replace(tzinfo=timezone.utc)
    # The existing one-day retention grace keeps the real expiry, never next year's date.
    recent = fetch_live(now)["bulletins"]
    assert recent
    assert {b["valid_to"] for b in recent} == {expected}
    # Issue age is still below seven days: filtering must use the parsed expiry.
    assert fetch_live(now + timedelta(days=2))["bulletins"] == []


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


def test_route_registry_is_shared_refreshed_and_not_mutated(tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from deepweather_analysis import warnings_mf as mf

    path = tmp_path / "route-zones.json"
    zone = {"zone_id": "casquets", "match_tokens": ["CASQUETS"]}
    doc = {"routes": {"a": {"fr_zones": [zone], "uk_zones": [zone]}, "b": {"uk_zones": [zone]}}}
    path.write_text(json.dumps(doc))
    monkeypatch.setattr(mf, "config_dir", lambda: tmp_path)
    original = Path.read_text
    reads = []

    def read(file, *args, **kwargs):
        if file == path:
            reads.append(file)
        return original(file, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    assert mf._route_zone_tokens() == [("casquets", "casquets", ["CASQUETS"])]
    assert mf._route_zones("uk_zones") == [zone]
    assert mf._route_zones("missing") == []
    assert len(reads) == 1
    mf._route_zones("uk_zones")[0]["match_tokens"].append("MUTATED")
    mf._route_zone_tokens()[0][2].append("MUTATED")
    assert mf._route_zones("uk_zones") == [zone]
    assert mf._route_zone_tokens()[0][2] == ["CASQUETS"]
    path.write_text('{"routes": {}}')
    assert mf._route_zones("uk_zones") == []
    assert mf._route_zone_tokens() == []
    assert len(reads) == 2


def test_route_registry_parse_failure_can_recover(tmp_path, monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    monkeypatch.setattr(mf, "config_dir", lambda: tmp_path)
    path = tmp_path / "route-zones.json"
    path.write_text("{bad")
    with pytest.raises(ValueError):
        mf._route_zones("uk_zones")
    path.write_text('{"routes": {}}')
    assert mf._route_zones("uk_zones") == []


def bms_response(rows=None, *, status=200, etag='"v1"', payload=None):
    from types import SimpleNamespace

    if payload is None:
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=list(ACTIVE_ROW), delimiter=";")
        writer.writeheader()
        writer.writerows([ACTIVE_ROW] if rows is None else rows)
        payload = gzip.compress(stream.getvalue().encode())
    return SimpleNamespace(
        status_code=status,
        headers={"ETag": etag} if etag else {},
        content=payload,
        raise_for_status=lambda: None,
    )


def test_etag_persists_and_304_reuses_source_but_recomputes_validity(monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    calls = []

    def get(url, **kwargs):
        calls.append(kwargs)
        return bms_response() if len(calls) == 1 else bms_response(status=304, payload=b"")

    monkeypatch.setattr(mf.requests, "get", get)
    assert fetch_live(NOW)["bulletins"]
    # Reload to ensure this is a disk cache, not process-local state.
    import importlib

    importlib.reload(mf)
    later = fetch_live(NOW + timedelta(days=3))
    assert later["feed_status"] == "ok"
    assert later["bulletins"] == []
    assert calls[1]["headers"]["If-None-Match"] == '"v1"'
    assert "daily" in later["coverage_note"]


def test_changed_etag_and_missing_etag_replace_cache(monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    calls = []
    responses = iter(
        [
            bms_response(),
            bms_response([], etag='W/"v2"'),
            bms_response(status=304, payload=b""),
            bms_response(etag=None),
            bms_response(),
        ]
    )

    def get(url, **kwargs):
        calls.append(kwargs.get("headers", {}))
        return next(responses)

    monkeypatch.setattr(mf.requests, "get", get)
    assert fetch_live(NOW)["bulletins"]
    assert fetch_live(NOW)["bulletins"] == []
    assert fetch_live(NOW)["feed_status"] == "ok"
    assert fetch_live(NOW)["bulletins"]
    assert fetch_live(NOW)["bulletins"]
    assert [call.get("If-None-Match") for call in calls] == [None, '"v1"', 'W/"v2"', 'W/"v2"', None]


def test_cache_is_separate_per_url_and_year(monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs.get("headers", {})))
        return bms_response([], etag=f'"{url}"')

    monkeypatch.setattr(mf.requests, "get", get)
    january = datetime(2027, 1, 1, tzinfo=timezone.utc)
    assert fetch_live(january)["feed_status"] == "ok"
    assert fetch_live(january)["feed_status"] == "ok"
    assert calls[2][1].get("If-None-Match") == f'"{calls[0][0]}"'
    assert calls[3][1].get("If-None-Match") == f'"{calls[1][0]}"'
    monkeypatch.setattr(mf, "BMS_URL_TEMPLATE", "https://example.test/{year}.gz")
    assert fetch_live(january)["feed_status"] == "ok"
    assert all(not headers for _, headers in calls[4:])


def test_bad_or_missing_cache_refetches_unconditionally(tmp_path, monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    calls = []

    def get(url, **kwargs):
        calls.append(kwargs.get("headers", {}))
        return bms_response()

    monkeypatch.setattr(mf.requests, "get", get)
    assert fetch_live(NOW)["feed_status"] == "ok"
    cached = list((tmp_path / "cache").rglob("*.json"))
    assert cached
    for path in cached:
        path.write_text("broken cache")
    assert fetch_live(NOW)["feed_status"] == "ok"
    for path in cached:
        path.unlink()
    assert fetch_live(NOW)["feed_status"] == "ok"
    assert all(not headers for headers in calls)


def test_network_failure_does_not_use_unvalidated_stale_cache(monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response())
    assert fetch_live(NOW)["bulletins"]

    def fail(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(mf.requests, "get", fail)
    doc = fetch_live(NOW)
    assert doc["feed_status"] == "unavailable" and doc["bulletins"] == []


def test_bad_download_does_not_poison_valid_cache(monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    calls = []
    responses = iter(
        [
            bms_response(),
            bms_response(etag='"bad"', payload=b"bad gzip"),
            bms_response(status=304, payload=b""),
        ]
    )

    def get(url, **kwargs):
        calls.append(kwargs.get("headers", {}))
        return next(responses)

    monkeypatch.setattr(mf.requests, "get", get)
    assert fetch_live(NOW)["bulletins"]
    assert fetch_live(NOW)["feed_status"] == "unavailable"
    assert fetch_live(NOW)["bulletins"]
    assert calls[2].get("If-None-Match") == '"v1"'


def test_outputs_retain_current_and_latest_47_snapshots_only(tmp_path):
    from deepweather_analysis import warnings_mf as mf

    out = tmp_path / "processed" / "warnings"
    out.mkdir(parents=True)
    for day in range(60):
        stamp = (NOW + timedelta(days=day)).strftime("%Y%m%dT%H%M%SZ")
        (out / f"{stamp}.json").write_text("historical")
    for name in ("notes.json", "20260230T120000Z.json", "20260101T120000Z.json.bak"):
        (out / name).write_text("keep")
    directory = out / "20260102T120000Z.json"
    directory.mkdir()
    link = out / "20260103T120000Z.json"
    link.symlink_to(out / "notes.json")
    doc = mf.synthetic_doc()
    doc["fetched_at"] = "2026-07-13T12:00:00Z"  # keep current even on a backdated run
    latest = mf.write_warnings(doc)
    assert json.loads(latest.read_text()) == doc
    assert json.loads((out / "20260713T120000Z.json").read_text()) == doc
    snapshots = [
        p
        for p in out.glob("2026*.json")
        if p.is_file() and not p.is_symlink() and p.name != "20260230T120000Z.json"
    ]
    assert len(snapshots) == 48
    assert not (out / "20260714T120000Z.json").exists()
    assert (out / "20260910T120000Z.json").exists()
    assert directory.is_dir()
    assert link.is_symlink()
    assert (out / "notes.json").read_text() == "keep"
    assert (out / "20260230T120000Z.json").read_text() == "keep"


def test_failed_publication_does_not_prune(tmp_path, monkeypatch):
    from pathlib import Path
    from deepweather_analysis import warnings_mf as mf

    out = tmp_path / "processed" / "warnings"
    out.mkdir(parents=True)
    old = out / "20200101T000000Z.json"
    old.write_text("preserve")
    for day in range(60):
        stamp = (NOW + timedelta(days=day)).strftime("%Y%m%dT%H%M%SZ")
        (out / f"{stamp}.json").write_text("historical")
    original = Path.write_text

    def write(path, *args, **kwargs):
        if path.name == "latest.json":
            raise OSError("publication failed")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", write)
    with pytest.raises(OSError, match="publication failed"):
        mf.write_warnings(mf.synthetic_doc())
    assert old.read_text() == "preserve"


@pytest.mark.parametrize("payload", [b"bad gzip", gzip.compress(b"wrong;columns\n")])
def test_unexpected_304_and_invalid_download_fail_closed(monkeypatch, payload):
    from deepweather_analysis import warnings_mf as mf

    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response(status=304))
    assert fetch_live(NOW)["feed_status"] == "unavailable"
    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response(payload=payload))
    assert fetch_live(NOW)["feed_status"] == "unavailable"


def test_failed_cache_replace_preserves_old_body_validator_pair(tmp_path, monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response())
    before = fetch_live(NOW)
    cache = next((tmp_path / "cache").rglob("*.json"))
    original = cache.read_bytes()

    def fail(*args):
        raise OSError("cache disk full")

    monkeypatch.setattr(mf.os, "replace", fail)
    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response([], etag='"v2"'))
    fresh = fetch_live(NOW)
    assert fresh["feed_status"] == "ok" and fresh["bulletins"] == []
    assert cache.read_bytes() == original
    assert not list(cache.parent.glob("*.tmp"))

    def unchanged(url, **kwargs):
        assert kwargs["headers"]["If-None-Match"] == '"v1"'
        return bms_response(status=304, payload=b"")

    monkeypatch.setattr(mf.requests, "get", unchanged)
    assert fetch_live(NOW)["bulletins"] == before["bulletins"]


def test_invalid_cached_csv_is_refetched(tmp_path, monkeypatch):
    from deepweather_analysis import warnings_mf as mf

    monkeypatch.setattr(mf.requests, "get", lambda *a, **kw: bms_response())
    assert fetch_live(NOW)["feed_status"] == "ok"
    cache = next((tmp_path / "cache").rglob("*.json"))
    doc = json.loads(cache.read_text())
    doc["text"] = "wrong;columns\n"
    cache.write_text(json.dumps(doc))

    def fresh(url, **kwargs):
        assert kwargs["headers"] == {}
        return bms_response()

    monkeypatch.setattr(mf.requests, "get", fresh)
    assert fetch_live(NOW)["bulletins"]
