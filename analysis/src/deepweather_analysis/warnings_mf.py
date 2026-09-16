"""Official marine warnings (authority layer) — Météo-France BMS.

Live source (feed spike 2026-07-17): the portail-api.meteofrance.fr catalog has
NO marine-bulletins API (checked every category). What does exist is the
official open-data BMS archive on data.gouv.fr — an S3 mirror whose
current-year CSV is re-synced daily (~05:45 UTC) and carries the full bulletin
text (côte / large / grand large, FR+EN):
  https://www.data.gouv.fr/datasets/bulletin-meteorologique-special-annuel
The daily sync means up to ~24 h of lag: a BMS issued after the last sync is
not yet visible. That lag is disclosed in coverage_note; absence of a warning
must never read as absence of risk.

Modes:
  live       — data.gouv BMS mirror: filter route broadcast areas, match
               route zones by name in the bulletin text, parse validity;
               "unavailable" on fetch/CSV failure, "parse-degraded" for bad rows;
               cancellation notices are excluded from active bulletins
  synthetic  — clear conditions by default; --gale ZONE injects a gale bulletin
               (drives the warning_active verdict state end-to-end)
  manual     — parse a pasted bulletin text file (feed_status parse-degraded,
               raw text always preserved)
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import os
import re
import tempfile
import unicodedata
from collections.abc import Callable
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import requests

from .paths import cache_dir, config_dir, contracts_dir, processed_dir
from .providers import Mode, provider_mode
from .route_sources import fr_broadcast_areas
from .timeutil import parse_iso_utc

BMS_URL_TEMPLATE = os.environ.get(
    "DEEPWEATHER_BMS_URL_TEMPLATE",
    "https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BULLETINS/BMS/bms_{year}.csv.gz",
)

SEVERITY_WORDS = [
    ("OURAGAN", "hurricane"),
    ("FORTE TEMPETE", "violent-storm"),
    ("TEMPETE", "storm"),
    ("COUP DE VENT", "gale"),
    ("GRAND FRAIS", "near-gale"),
]
BMS_COLUMNS = {"date", "langue", "zone", "type", "contenu"}
CANCELLATION_RE = re.compile(
    r"\b(?:FIN\s+D['\s]*AVIS|LEVEE\s+(?:DE\s+L['\s]*AVIS|D['\s]*AVIS|DU\s+BMS))\b"
)

# "JUSQU'AU 13 A 18H UTC" (large) or "JUSQU'AU LUNDI 13 JUILLET A 22H00 UTC" (côte)
VALID_TO_RE = re.compile(
    r"JUSQU'?\s?AU\s+(?:[A-Z]+\s+)?(\d{1,2})(?:\s+([A-Z]+))?\s+A\s+(\d{1,2})\s*H\s*(\d{2})?\s*UTC"
)
# "VALABLE DU VENDREDI 5 JUIN A 20H00 UTC AU SAMEDI 6 JUIN A 06H00 UTC" (côte, range form)
VALID_RANGE_RE = re.compile(
    r"VALABLE\s+DU\s+(?:[A-Z]+\s+)?(\d{1,2})(?:\s+([A-Z]+))?\s+A\s+(\d{1,2})\s*H\s*(\d{2})?\s*UTC"
    r"\s+AU\s+(?:[A-Z]+\s+)?(\d{1,2})(?:\s+([A-Z]+))?\s+A\s+(\d{1,2})\s*H\s*(\d{2})?\s*UTC"
)

FR_MONTHS = {
    "JANVIER": 1,
    "FEVRIER": 2,
    "MARS": 3,
    "AVRIL": 4,
    "MAI": 5,
    "JUIN": 6,
    "JUILLET": 7,
    "AOUT": 8,
    "SEPTEMBRE": 9,
    "OCTOBRE": 10,
    "NOVEMBRE": 11,
    "DECEMBRE": 12,
}

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
    if CANCELLATION_RE.search(_normalize(raw_text)):
        # Preserve the pasted notice as context without an active bulletin.
        doc["coverage_note"] = raw_text.strip()
        return doc
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


def _normalize(text: str) -> str:
    """Uppercase and strip accents for tolerant matching against bulletin text."""
    stripped = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return stripped.upper()


@lru_cache(maxsize=8)
def _read_route_zones(path: Path, mtime_ns: int, size: int) -> dict:
    """Share one parse per file revision; exceptions are not cached."""
    return json.loads(path.read_text())


def _route_zones_doc() -> dict:
    path = (config_dir() / "route-zones.json").resolve()
    stat = path.stat()
    return _read_route_zones(path, stat.st_mtime_ns, stat.st_size)


def _route_zone_tokens() -> list[tuple[str, str, list[str]]]:
    """(zone_id, zone_name, match_tokens) for every FR zone in route-zones.json."""
    zones_doc = _route_zones_doc()
    out: list[tuple[str, str, list[str]]] = []
    seen: set[str] = set()
    for entry in zones_doc.get("routes", {}).values():
        for zone in entry.get("fr_zones", []):
            if zone["zone_id"] in seen:
                continue
            seen.add(zone["zone_id"])
            tokens = zone.get("match_tokens") or [_normalize(zone["zone_id"].replace("-", " "))]
            out.append((zone["zone_id"], zone.get("zone_name", zone["zone_id"]), list(tokens)))
    return out


def _resolve_day(
    day: int, month_word: str | None, hour: int, minute: int, issued: datetime
) -> str | None:
    year, month = issued.year, issued.month
    if month_word in FR_MONTHS:
        month = FR_MONTHS[month_word]
        if month < issued.month:  # year rollover (issued in December, valid into January)
            year += 1
    elif day < issued.day - 15:
        # no month word: same month as issue unless the day implies a rollover
        month += 1
        if month > 12:
            month, year = 1, year + 1
    try:
        resolved = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except ValueError:
        return None
    return resolved.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_validity(norm_text: str, issued: datetime) -> tuple[str | None, str | None, float]:
    """Best-effort (valid_from, valid_to, confidence) from the bulletin's VALABLE line."""
    range_match = VALID_RANGE_RE.search(norm_text)
    if range_match:
        d1, m1, h1, mi1, d2, m2, h2, mi2 = range_match.groups()
        valid_from = _resolve_day(int(d1), m1, int(h1), int(mi1 or 0), issued)
        valid_to = _resolve_day(int(d2), m2, int(h2), int(mi2 or 0), issued)
        if valid_from and valid_to:
            return valid_from, valid_to, 0.85
    match = VALID_TO_RE.search(norm_text)
    if match:
        day, month_word, hour, minute = match.groups()
        valid_to = _resolve_day(int(day), month_word, int(hour), int(minute or 0), issued)
        if valid_to:
            return None, valid_to, 0.85
    return None, None, 0.5


def _severity(norm_text: str) -> str | None:
    if CANCELLATION_RE.search(norm_text):
        return None
    for word, severity in SEVERITY_WORDS:
        if word in norm_text:
            return severity
    return None


def _csv_rows(text: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text), delimiter=";", strict=True)
    missing = BMS_COLUMNS - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"BMS CSV missing columns: {', '.join(sorted(missing))}")
    return list(reader)


def _fetch_bms_rows(url: str) -> list[dict]:
    """Revalidate a persistent, URL-specific source cache on every call.

    Cache the source, not bulletins: route selection and expiry must run again
    even on HTTP 304. Never serve cached data after a network/server failure.
    The ETag and CSV share one atomic file so interrupted/concurrent writers
    cannot pair an old body with a new validator. Cache I/O is best-effort.
    """
    path = cache_dir("warnings-mf") / f"{hashlib.sha256(url.encode()).hexdigest()}.json"
    cached_rows = None
    headers = {}
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if (
            isinstance(cached, dict)
            and cached.get("url") == url
            and isinstance(cached.get("etag"), str)
            and cached["etag"]
            and isinstance(cached.get("text"), str)
        ):
            cached_rows = _csv_rows(cached["text"])
            headers["If-None-Match"] = cached["etag"]
    except (OSError, ValueError, csv.Error):
        pass  # missing/corrupt cache: request the complete source

    response = requests.get(url, headers=headers, timeout=60)
    response.raise_for_status()
    if response.status_code == 304:
        if cached_rows is None:
            raise ValueError("BMS returned 304 without a usable cached source")
        return cached_rows
    text = gzip.decompress(response.content).decode("utf-8")
    rows = _csv_rows(text)
    temporary_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump({"url": url, "etag": response.headers.get("ETag"), "text": text}, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    except OSError:
        pass  # a read-only/full cache must not discard a successful live fetch
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
    return rows


def fetch_live(now: datetime | None = None) -> dict:
    """Live BMS from the official data.gouv mirror (daily-synced current-year CSV)."""
    now = now or datetime.now(timezone.utc)
    doc = _base_doc(Mode.LIVE, "Météo-France BMS (data.gouv daily mirror)")
    years = {now.year} | ({now.year - 1} if now.month == 1 else set())
    rows: list[dict] = []
    try:
        for year in sorted(years):
            rows.extend(_fetch_bms_rows(BMS_URL_TEMPLATE.format(year=year)))
    except Exception as error:  # any feed failure must degrade, not crash
        doc["feed_status"] = "unavailable"
        doc["coverage_note"] = f"live fetch failed: {error}"
        return doc

    last_issued: datetime | None = None
    zone_tokens = _route_zone_tokens()
    # BMS broadcast areas (the CSV `zone` column) that can carry bulletins for
    # any registered route — from config/route-sources.json.
    route_areas = fr_broadcast_areas()
    malformed_rows = 0
    for row in rows:
        try:
            # DictReader uses None for missing cells and surplus-column keys.
            if None in row or any(
                not isinstance(row[key], str) or not row[key].strip() for key in BMS_COLUMNS
            ):
                raise ValueError("BMS row has missing/empty cells or surplus columns")
            issued = datetime.strptime(row["date"], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc
            )
        except (KeyError, TypeError, ValueError):
            malformed_rows += 1
            continue
        if last_issued is None or issued > last_issued:
            last_issued = issued
        if row["langue"] != "FR" or row["zone"] not in route_areas:
            continue
        if issued < now - timedelta(days=7):
            continue
        norm = _normalize(row["contenu"])
        # A null severity still triggers the engine authority override: omit
        # cancellations entirely, before inventing a fallback validity window.
        if CANCELLATION_RE.search(norm):
            continue
        valid_from, valid_to, confidence = _parse_validity(norm, issued)
        if valid_from is None:
            valid_from = issued.strftime("%Y-%m-%dT%H:%M:%SZ")
        if valid_to is None:
            valid_to = (issued + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
        # drop bulletins that expired more than a day ago
        if parse_iso_utc(valid_to) < now - timedelta(hours=24):
            continue
        kind = f"BMS-{_normalize(row['type']).lower().replace(' ', '-')}"
        for zone_id, zone_name, tokens in zone_tokens:
            if not any(token in norm for token in tokens):
                continue
            doc["bulletins"].append(
                {
                    "zone_id": zone_id,
                    "zone_name": zone_name,
                    "kind": kind,
                    "severity": _severity(norm),
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                    "raw_text": row["contenu"].strip(),
                    "parse_confidence": confidence,
                }
            )

    freshness = last_issued.strftime("%Y-%m-%dT%H:%M:%SZ") if last_issued else "unknown"
    doc["coverage_note"] = (
        "FR Channel BMS via the official data.gouv mirror, synced daily (~05:45 UTC): "
        "bulletins issued after the last sync are not yet visible — absence of a "
        f"warning is not absence of risk. Newest bulletin in feed: {freshness}. "
        "UK shipping-forecast zones modeled but not fetched."
    )
    if malformed_rows:
        doc["feed_status"] = "parse-degraded"
        doc["coverage_note"] += (
            f" Skipped {malformed_rows} malformed BMS row(s); feed coverage is incomplete."
        )
    return doc


# Bound local history independently of fetch frequency; latest and the current
# snapshot are always retained, including backdated/manual publications.
WARNING_SNAPSHOT_KEEP = 48


def _prune_warning_snapshots(out_dir: Path, current: Path) -> None:
    snapshots = []
    for path in out_dir.glob("*.json"):
        if path.is_symlink() or not path.is_file():
            continue
        if not re.fullmatch(r"\d{8}T\d{6}Z\.json", path.name):
            continue
        try:
            datetime.strptime(path.stem, "%Y%m%dT%H%M%SZ")
        except ValueError:
            continue
        if path != current:
            snapshots.append(path)
    for path in sorted(snapshots, reverse=True)[WARNING_SNAPSHOT_KEEP - 1 :]:
        path.unlink(missing_ok=True)


def write_warnings(doc: dict) -> Path:
    from jsonschema import Draft202012Validator

    schema = json.loads((contracts_dir() / "warnings.schema.json").read_text())
    Draft202012Validator(schema).validate(doc)

    out_dir = processed_dir("warnings")
    stamp = doc["fetched_at"].replace("-", "").replace(":", "")
    snapshot = out_dir / f"{stamp}.json"
    snapshot.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    latest = out_dir / "latest.json"
    latest.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    _prune_warning_snapshots(out_dir, snapshot)
    return latest


def _route_zones(kind: str) -> list[dict]:
    """Union of one zone kind ('uk_zones' / 'us_zones') across all routes."""
    zones_doc = _route_zones_doc()
    out: list[dict] = []
    seen: set[str] = set()
    for entry in zones_doc.get("routes", {}).values():
        for zone in entry.get(kind, []):
            if zone["zone_id"] not in seen:
                seen.add(zone["zone_id"])
                out.append(deepcopy(zone))
    return out


def _merge_warning_feed(
    doc: dict,
    fetch_bulletins: Callable[[list[dict]], tuple[list[dict], str]],
    zone_kind: str,
    label: str,
    source_name: str,
    *,
    remove_note: str = "",
) -> dict:
    """Append one feed in place; preserve source order and degrade on fetch failure."""
    try:
        bulletins, note = fetch_bulletins(_route_zones(zone_kind))
    except Exception as error:  # any feed failure must degrade, not crash
        doc["feed_status"] = "parse-degraded"
        doc["coverage_note"] = (
            f"{doc.get('coverage_note', '')} {label} feed unavailable: {error}".strip()
        )
        return doc
    doc["bulletins"].extend(bulletins)
    doc["source"]["name"] = f"{doc['source'].get('name', '')} + {source_name}"
    base_note = doc.get("coverage_note", "")
    if remove_note:
        base_note = base_note.replace(remove_note, "").strip()
    doc["coverage_note"] = f"{base_note} {note}".strip()
    return doc


def _merge_uk_warnings(doc: dict) -> dict:
    """Append live UK gale bulletins (Met Office shipping forecast) to the FR doc."""
    from .warnings_uk import fetch_uk_gale_bulletins

    return _merge_warning_feed(
        doc,
        fetch_uk_gale_bulletins,
        "uk_zones",
        "UK",
        "Met Office shipping forecast",
        remove_note="UK shipping-forecast zones modeled but not fetched.",
    )


def _merge_us_warnings(doc: dict) -> dict:
    """Append live US bulletins (NWS api.weather.gov active alerts) to the doc."""
    from .warnings_us import fetch_us_bulletins

    return _merge_warning_feed(doc, fetch_us_bulletins, "us_zones", "US", "NWS active alerts")


def _merge_meteoalarm_warnings(doc: dict) -> dict:
    """Append live European bulletins (Meteoalarm CAP aggregation) to the doc."""
    from .warnings_meteoalarm import fetch_meteoalarm_bulletins

    return _merge_warning_feed(
        doc, fetch_meteoalarm_bulletins, "meteoalarm_zones", "Meteoalarm", "Meteoalarm CAP"
    )


def _merge_au_warnings(doc: dict) -> dict:
    """Append live Australian bulletins (BOM marine wind warning summaries) to the doc."""
    from .warnings_au import fetch_au_bulletins

    return _merge_warning_feed(
        doc, fetch_au_bulletins, "au_zones", "AU", "BOM marine wind warnings"
    )


def fetch_warnings(gale_zone: str | None = None, paste_file: str | None = None) -> Path:
    if paste_file:
        doc = parse_manual_bulletin(Path(paste_file).read_text(), zone_id=gale_zone or "casquets")
        return write_warnings(doc)
    mode = provider_mode("warnings_fr")
    doc = fetch_live() if mode is Mode.LIVE else synthetic_doc(gale_zone)
    if provider_mode("warnings_uk") is Mode.LIVE:
        doc = _merge_uk_warnings(doc)
    if provider_mode("warnings_us") is Mode.LIVE and _route_zones("us_zones"):
        doc = _merge_us_warnings(doc)
    if provider_mode("warnings_meteoalarm") is Mode.LIVE and _route_zones("meteoalarm_zones"):
        doc = _merge_meteoalarm_warnings(doc)
    if provider_mode("warnings_au") is Mode.LIVE and _route_zones("au_zones"):
        doc = _merge_au_warnings(doc)
    return write_warnings(doc)
