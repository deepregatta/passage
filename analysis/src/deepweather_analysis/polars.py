# Vendored from coachregatta analysis/src/coachregatta_analysis/polars.py, 2026-07-12 — adapted for deepweather.
"""
ORC polar database loading, matching, and extraction.

Vendored pieces (see provenance header): load_orc_polars(), normalize_text(),
normalize_model() (incl. special cases), the match_polar() cascade, and
transform_orc_vpp(). Adaptations for deepweather:

- The user-override / race-scoped match tiers are dropped (no uploads yet).
  The cascade is: exact name+model -> exact model -> fuzzy nearest model
  (SequenceMatcher) -> generic defaults.
- Paths resolve through deepweather's paths helpers.

New for deepweather:

- extract_polar(query): match the ORC db (model-first, then name), transform
  to the contracts/polar.schema.json shape, validate, and write
  config/polars/<slug>.json, maintaining config/polars/index.json.
- search_orc(query): candidate {name, type} matches for a future picker.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from .paths import config_dir, contracts_dir, data_root

__all__ = [
    "load_orc_polars",
    "match_polar",
    "get_default_polars",
    "transform_orc_vpp",
    "normalize_text",
    "normalize_model",
    "extract_polar",
    "search_orc",
    "build_polar_db",
    "default_polars_file",
    "MatchResult",
]


# Default polars used when no ORC match is found
DEFAULT_POLARS: dict[float, dict[float, float]] = {
    6.0: {45.0: 5.0, 90.0: 7.0, 180.0: 6.0},
    10.0: {45.0: 6.5, 90.0: 8.5, 180.0: 7.5},
    14.0: {45.0: 7.2, 90.0: 9.5, 180.0: 8.5},
    20.0: {45.0: 7.5, 90.0: 11.0, 180.0: 10.0},
}


def default_polars_file() -> Path:
    """Location of the vendored ORC VPP database."""
    return data_root() / "raw" / "polars" / "ALL2025.json"


def default_output_dir() -> Path:
    """Where extracted polar artifacts are published."""
    return config_dir() / "polars"


class MatchResult:
    """Result of a polar match operation."""

    def __init__(
        self,
        polars: dict[float, dict[float, float]] | None,
        match_type: str,
        matched_value: str = "",
        orc_boat_type: str = "",
        polar_source: str = "none",
        polar_source_detail: str = "",
    ):
        """
        Initialize match result.

        Args:
            polars: The polar table in {TWS: {TWA: Speed}} format, or None if no match
            match_type: "name_and_model", "model", "name", "nearest_model", or "generic"
            matched_value: The value that was matched (boat name or model)
            orc_boat_type: The boat type from ORC data (if matched)
        """
        self.polars = polars
        self.match_type = match_type
        self.matched_value = matched_value
        self.orc_boat_type = orc_boat_type
        self.polar_source = polar_source
        self.polar_source_detail = polar_source_detail


def normalize_text(text: str) -> str:
    """
    Normalize text for matching.

    - Converts to uppercase
    - Removes spaces, hyphens, underscores, dots
    - Removes special characters
    - Strips leading/trailing whitespace

    Examples:
        "SUN FAST 3200" -> "SUNFAST3200"
        "J-99" -> "J99"
        "First 36.7" -> "FIRST367"
    """
    if not text:
        return ""

    # Convert to uppercase
    text = text.upper()

    # Remove common separators
    text = text.replace(" ", "").replace("-", "").replace("_", "").replace(".", "")

    # Remove special characters, keep only alphanumeric
    text = re.sub(r"[^A-Z0-9]", "", text)

    return text.strip()


def normalize_model(model: str) -> str:
    """
    Normalize boat model, removing version numbers and specs.

    Strategy:
    - Keep the core model name including primary numbers (e.g., "3200", "36", "46")
    - Remove draft/beam specs (any decimal number like 1.90, 2.20, 2.65)
    - Remove keel/config specs (Fin6, WB, T, OD, etc.)
    - Remove version suffixes (R2, MK2, CR, etc.)

    Examples:
        "SUN FAST 3200 R2 1.90" -> "SUNFAST3200"
        "J 99 2.00" -> "J99"
        "SWAN 46 2.65 MK2" -> "SWAN46"
        "FIRST 36.7 CR" -> "FIRST367"
        "SUN FAST 3600 2.20 Fin6" -> "SUNFAST3600"
        "JPK 10.10 1.98 T" -> "JPK1010"
    """
    if not model:
        return ""

    # Apply special case corrections FIRST (before any other processing)
    model_upper = model.upper().strip()

    # Special case: FIGARO II -> Figaro 2 (Roman numeral conversion)
    if "FIGARO" in model_upper and "II" in model_upper:
        model = "Figaro 2"

    # Special case: SIGMA 38 OOD -> Sigma 38 (OOD is one-design designation)
    if "SIGMA 38 OOD" in model_upper or "SIGMA38OOD" in model_upper.replace(" ", ""):
        model = "Sigma 38"

    # Special case: Sydney GTS 43 -> Sydney 43 GTS (word order)
    if "SYDNEY" in model_upper and "GTS" in model_upper and "43" in model_upper:
        model = "Sydney 43 GTS"

    # Special case: ELAN 400/E5 -> Elan 400 (take first variant before slash)
    if "ELAN" in model_upper and "/" in model_upper:
        # Split by slash and take first part
        model = model.split("/")[0].strip()

    # Special case: Xp 44 Sport -> Xp 44 (remove Sport suffix)
    if "XP" in model_upper and "SPORT" in model_upper:
        model = re.sub(r"\s+Sport\s*", " ", model, flags=re.IGNORECASE)

    # Special case: FARR 36M -> Mumm 36 (special mapping)
    if "FARR" in model_upper and "36M" in model_upper.replace(" ", ""):
        model = "Mumm 36"

    # Remove version/variant suffixes first (CR, OD, MK2, R2, SV, SP, etc.)
    # These appear after a number (model designation)
    model = re.sub(
        r"(\d)\s*(R\d+|MK\d+|MKII|MKIII|CR|OD|SV|SP|Ca|FRA|IK|LK)(\s+|$)",
        r"\1 ",
        model,
        flags=re.IGNORECASE,
    )

    # Remove common keel/configuration suffixes (these come after model number)
    # Fin6, Fin 6, WB, OD, CF, Sport, mod, etc. - but NOT "T" which might be part of words like "FAST"
    # Apply multiple times to catch chained suffixes like "Fin6 WB"
    for _ in range(3):  # Max 3 iterations to catch multiple suffixes
        # Handle "Fin 6" (with space) and "Fin6" (without space)
        model = re.sub(
            r"\s+(Fin\s*\d+|WB|CF|PbFe|Wing|rev counter Thr|MOD rudder|MOD|mod|Distinction|Sport)(\s+|$)",
            " ",
            model,
            flags=re.IGNORECASE,
        )

    # Handle single letter keel types that appear as separate words at the end (like " T" or " T ")
    # But only if they're preceded by a digit (like "1.98 T")
    model = re.sub(r"(\d)\s+([T])\s*$", r"\1", model, flags=re.IGNORECASE)

    # Remove all draft/beam specs (decimal numbers like 1.90, 2.20, 2.65, etc.)
    # BUT preserve decimals that are part of the main model number
    # Strategy: Remove any decimal that comes AFTER the main model name
    # Look for pattern: (letters+numbers) followed by space and then decimal
    model = re.sub(r"(\d)(\s+\d+\.\d+)+(\s|$)", r"\1 ", model)

    # Clean up multiple spaces
    model = re.sub(r"\s+", " ", model).strip()

    # Now normalize the text (removes spaces, dots, hyphens, etc.)
    normalized = normalize_text(model)

    return normalized


def _split_model_signature(normalized_model: str) -> tuple[str, str]:
    brand_match = re.match(r"[A-Z]+", normalized_model)
    brand = brand_match.group(0) if brand_match else ""
    digits = "".join(re.findall(r"\d+", normalized_model))
    return brand, digits


def _shared_prefix_length(left: str, right: str) -> int:
    length = 0
    for left_char, right_char in zip(left, right):
        if left_char != right_char:
            break
        length += 1
    return length


def _find_nearest_model_record(
    normalized_model: str, orc_index: dict[str, dict]
) -> tuple[dict, str] | None:
    if not normalized_model:
        return None

    brand, digits = _split_model_signature(normalized_model)
    if not brand:
        return None

    best_record = None
    best_model = ""
    best_score = 0.0

    for candidate_model, record in orc_index.get("by_model", {}).items():
        if not candidate_model or candidate_model == normalized_model:
            continue

        candidate_brand, candidate_digits = _split_model_signature(candidate_model)
        if candidate_brand and candidate_brand != brand:
            continue

        similarity = SequenceMatcher(None, normalized_model, candidate_model).ratio()
        if normalized_model in candidate_model or candidate_model in normalized_model:
            similarity += 0.08

        digit_bonus = 0.0
        if digits and candidate_digits:
            shared_digit_prefix = _shared_prefix_length(digits, candidate_digits)
            digit_bonus += (
                min(shared_digit_prefix, max(len(digits), len(candidate_digits))) * 0.05
            )
            if digits == candidate_digits:
                digit_bonus += 0.15

        score = similarity + digit_bonus
        if score > best_score:
            best_score = score
            best_record = record
            best_model = candidate_model

    if best_record is None or best_score < 0.86:
        return None

    return best_record, best_model


def transform_orc_vpp(orc_vpp: dict) -> dict[float, dict[float, float]]:
    """
    Transform ORC VPP format to internal polar format.

    ORC format:
        {
            'angles': [52, 60, 75, 90, 110, 120, 135, 150],
            'speeds': [4, 6, 8, 10, 12, 14, 16, 20, 24],
            52: [3.65, 4.9, 5.76, ...],
            60: [3.87, 5.14, 5.97, ...],
            ...
        }

    Internal format:
        {
            4.0: {52: 3.65, 60: 3.87, ...},
            6.0: {52: 4.9, 60: 5.14, ...},
            ...
        }
    """
    if "angles" not in orc_vpp or "speeds" not in orc_vpp:
        return {}

    angles = orc_vpp["angles"]
    speeds = orc_vpp["speeds"]

    result: dict[float, dict[float, float]] = {}

    # For each TWS (speeds)
    for speed_idx, tws in enumerate(speeds):
        result[float(tws)] = {}

        # For each TWA (angles)
        for twa in angles:
            # Get the speed array for this angle
            speed_array = orc_vpp.get(twa, [])
            if speed_idx < len(speed_array):
                boat_speed = speed_array[speed_idx]
                result[float(tws)][float(twa)] = float(boat_speed)

    return result


# Cache of loaded ORC indexes keyed by resolved file path (the db is a 12 MB
# Python-literal file; parsing it takes a couple of seconds).
_ORC_INDEX_CACHE: dict[str, dict[str, dict]] = {}


def load_orc_polars(polars_file: Path) -> dict[str, dict]:
    """
    Load ORC polar data from JSON file.

    Supports both JSON format and Python literal format (with single quotes).

    Returns a dictionary with normalized lookups:
        {
            'by_name': {normalized_name: orc_record},
            'by_model': {normalized_model: orc_record},
        }
    """
    if not polars_file.exists():
        return {"by_name": {}, "by_model": {}}

    cache_key = str(polars_file.resolve())
    cached = _ORC_INDEX_CACHE.get(cache_key)
    if cached is not None:
        return cached

    with open(polars_file, "r", encoding="utf-8") as f:
        content = f.read()

    # Try JSON first
    try:
        orc_data = json.loads(content)
    except json.JSONDecodeError:
        # Fall back to Python literal evaluation for single-quoted dicts
        import ast

        try:
            orc_data = ast.literal_eval(content)
        except (ValueError, SyntaxError) as e:
            raise ValueError(
                f"Could not parse polar file as JSON or Python literal: {e}"
            )

    by_name = {}
    by_model = {}

    for record in orc_data:
        # Extract boat name and model
        boat_name = record.get("name") or ""
        boat_type = record.get("boat", {}).get("type") or ""

        if boat_name:
            boat_name = boat_name.strip()
        if boat_type:
            boat_type = boat_type.strip()

        # Index by name if available
        if boat_name:
            norm_name = normalize_text(boat_name)
            if norm_name:
                by_name[norm_name] = record

        # Index by model/type if available
        if boat_type:
            norm_model = normalize_model(boat_type)
            if norm_model:
                # Store first occurrence (in case of duplicates)
                if norm_model not in by_model:
                    by_model[norm_model] = record

    index = {
        "by_name": by_name,
        "by_model": by_model,
    }
    _ORC_INDEX_CACHE[cache_key] = index
    return index


def _generic_match(query_or_model: str = "") -> MatchResult:
    """Terminal cascade tier: generic default polars."""
    return MatchResult(
        polars=get_default_polars(),
        match_type="generic",
        matched_value=query_or_model,
        orc_boat_type="",
        polar_source="generic",
        polar_source_detail="No ORC match found; using generic default polars.",
    )


def match_polar(
    boat_name: str,
    boat_model: str,
    orc_index: dict[str, dict],
) -> MatchResult:
    """
    Match a boat to its polar table using smart hybrid approach.

    Matching strategy (deepweather cascade — no user-override tiers):
    1. Try to match by BOTH name AND model (strict match)
    2. If no match, try by exact model
    3. If still no match, fuzzy nearest model via SequenceMatcher
    4. Fall back to generic default polars

    Args:
        boat_name: Boat name from route/boat setup
        boat_model: Boat model
        orc_index: ORC polar index from load_orc_polars()

    Returns:
        MatchResult with polars and match metadata (never None polars —
        the generic tier always applies).
    """
    # Step 1: Try to match by BOTH name AND model
    if boat_name and boat_model:
        norm_name = normalize_text(boat_name)
        norm_model = normalize_model(boat_model)

        # Check if we have a name match
        if norm_name in orc_index["by_name"]:
            orc_record = orc_index["by_name"][norm_name]
            orc_model = orc_record.get("boat", {}).get("type", "")
            norm_orc_model = normalize_model(orc_model)

            # Verify the model also matches
            if norm_orc_model == norm_model:
                vpp = orc_record.get("vpp", {})
                if vpp:
                    polars = transform_orc_vpp(vpp)
                    if polars:
                        return MatchResult(
                            polars=polars,
                            match_type="name_and_model",
                            matched_value=f"{boat_name} / {boat_model}",
                            orc_boat_type=orc_model,
                            polar_source="orc_match",
                            polar_source_detail="ORC polar matched by boat name and model.",
                        )

    # Step 2: Try to match by exact model
    if boat_model:
        norm_model = normalize_model(boat_model)
        if norm_model in orc_index["by_model"]:
            orc_record = orc_index["by_model"][norm_model]
            vpp = orc_record.get("vpp", {})
            if vpp:
                polars = transform_orc_vpp(vpp)
                if polars:
                    return MatchResult(
                        polars=polars,
                        match_type="model",
                        matched_value=boat_model,
                        orc_boat_type=orc_record.get("boat", {}).get("type", ""),
                        polar_source="orc_match",
                        polar_source_detail="ORC polar matched by boat model.",
                    )

    # Step 3: Try to nearest-match by similar model
    if boat_model:
        norm_model = normalize_model(boat_model)
        nearest = _find_nearest_model_record(norm_model, orc_index)
        if nearest:
            orc_record, _matched_model = nearest
            vpp = orc_record.get("vpp", {})
            if vpp:
                polars = transform_orc_vpp(vpp)
                if polars:
                    nearest_type = orc_record.get("boat", {}).get("type", "")
                    return MatchResult(
                        polars=polars,
                        match_type="nearest_model",
                        matched_value=boat_model,
                        orc_boat_type=nearest_type,
                        polar_source="orc_nearest",
                        polar_source_detail=f"ORC nearest-match polar using similar boat model {nearest_type}.",
                    )

    # Step 4: Generic defaults
    return _generic_match(boat_model or boat_name)


def get_default_polars() -> dict[float, dict[float, float]]:
    """Get the default polar table."""
    return DEFAULT_POLARS.copy()


# ---------------------------------------------------------------------------
# deepweather-specific: extraction to the contracts/polar.schema.json shape
# ---------------------------------------------------------------------------


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "polar"


def _interpolate_in_row(
    twa: float, known_angles: list[float], row: dict[float, float]
) -> float:
    """Linear interpolation of a missing TWA within one TWS row.

    Values outside the known angle range clamp to the nearest neighbour.
    """
    lower = max((a for a in known_angles if a < twa), default=None)
    upper = min((a for a in known_angles if a > twa), default=None)
    if lower is None and upper is None:
        return 0.0
    if lower is None:
        return float(row[upper])
    if upper is None:
        return float(row[lower])
    frac = (twa - lower) / (upper - lower)
    return float(row[lower]) + frac * (float(row[upper]) - float(row[lower]))


def polar_table_to_axes(
    polars: dict[float, dict[float, float]],
) -> tuple[list[float], list[float], list[list[float]]]:
    """Transform {tws: {twa: speed}} into sorted axes + a dense matrix.

    speeds[i][j] = boat speed at tws[i], twa[j]. Where a TWA is missing for
    some TWS row, it is linearly interpolated within the row from neighbours.
    """
    tws_axis = sorted(float(t) for t in polars)
    twa_set: set[float] = set()
    for row in polars.values():
        twa_set.update(float(a) for a in row)
    twa_axis = sorted(twa_set)

    matrix: list[list[float]] = []
    for tws in tws_axis:
        row = {float(a): float(s) for a, s in polars[tws].items()}
        known_angles = sorted(row)
        matrix.append(
            [
                round(row[twa] if twa in row else _interpolate_in_row(twa, known_angles, row), 3)
                for twa in twa_axis
            ]
        )
    return tws_axis, twa_axis, matrix


def _match_query(query: str, orc_index: dict[str, dict]) -> MatchResult:
    """Match a free-text query against the ORC db, model-first, then name."""
    norm_model = normalize_model(query)
    if norm_model and norm_model in orc_index["by_model"]:
        record = orc_index["by_model"][norm_model]
        polars = transform_orc_vpp(record.get("vpp", {}))
        if polars:
            boat_type = record.get("boat", {}).get("type", "")
            return MatchResult(
                polars=polars,
                match_type="model",
                matched_value=boat_type,
                orc_boat_type=boat_type,
                polar_source="orc_match",
                polar_source_detail=f"ORC polar matched by exact model for query '{query}'.",
            )

    norm_name = normalize_text(query)
    if norm_name and norm_name in orc_index["by_name"]:
        record = orc_index["by_name"][norm_name]
        polars = transform_orc_vpp(record.get("vpp", {}))
        if polars:
            boat_name = record.get("name", "").strip()
            return MatchResult(
                polars=polars,
                match_type="name",
                matched_value=boat_name,
                orc_boat_type=record.get("boat", {}).get("type", ""),
                polar_source="orc_match",
                polar_source_detail=f"ORC polar matched by boat name for query '{query}'.",
            )

    nearest = _find_nearest_model_record(norm_model, orc_index)
    if nearest:
        record, _matched_model = nearest
        polars = transform_orc_vpp(record.get("vpp", {}))
        if polars:
            boat_type = record.get("boat", {}).get("type", "")
            return MatchResult(
                polars=polars,
                match_type="nearest_model",
                matched_value=boat_type,
                orc_boat_type=boat_type,
                polar_source="orc_nearest",
                polar_source_detail=(
                    f"ORC nearest-match polar using similar boat model {boat_type} "
                    f"for query '{query}'."
                ),
            )

    return _generic_match(query)


def _update_index(index_path: Path, entry: dict) -> None:
    """Read-modify-write config/polars/index.json, replacing same polar_id."""
    data: dict = {"polars": []}
    if index_path.exists():
        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {"polars": []}
    polars_list = [
        item
        for item in data.get("polars", [])
        if item.get("polar_id") != entry["polar_id"]
    ]
    polars_list.append(entry)
    data["polars"] = sorted(polars_list, key=lambda item: item.get("polar_id", ""))
    index_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def extract_polar(
    query: str,
    polar_id: str | None = None,
    *,
    polars_file: Path | None = None,
    out_dir: Path | None = None,
) -> Path:
    """Extract a polar from the ORC db into a contract-shaped artifact.

    Matches model-first (query as model, then as boat name, then fuzzy
    nearest model, then generic defaults), transforms to the
    contracts/polar.schema.json shape, validates, writes
    <out_dir>/<slug>.json, and updates <out_dir>/index.json.

    Returns the path of the written artifact.
    """
    from jsonschema import Draft202012Validator

    orc_index = load_orc_polars(polars_file or default_polars_file())
    result = _match_query(query, orc_index)

    if result.match_type == "generic":
        label = f"Generic defaults ({query})"
        source_kind = "generic"
    else:
        label = result.orc_boat_type or result.matched_value or query
        source_kind = "orc_vpp"

    slug = _slugify(polar_id) if polar_id else _slugify(label)
    tws_kt, twa_deg, speeds_kt = polar_table_to_axes(result.polars)

    artifact = {
        "schema_version": 1,
        "polar_id": slug,
        "label": label,
        "tws_kt": tws_kt,
        "twa_deg": twa_deg,
        "speeds_kt": speeds_kt,
        "source": {
            "kind": source_kind,
            "match_type": result.match_type,
            "matched_value": result.matched_value or None,
            "detail": result.polar_source_detail or None,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    schema = json.loads(
        (contracts_dir() / "polar.schema.json").read_text(encoding="utf-8")
    )
    Draft202012Validator(schema).validate(artifact)

    target_dir = out_dir or default_output_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    out_path = target_dir / f"{slug}.json"
    out_path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")

    _update_index(
        target_dir / "index.json",
        {"polar_id": slug, "label": label, "source_kind": source_kind},
    )
    return out_path


def search_orc(
    query: str,
    limit: int = 8,
    *,
    polars_file: Path | None = None,
    orc_index: dict[str, dict] | None = None,
) -> list[dict[str, str]]:
    """Return candidate ORC matches for a query, for a future picker UI.

    Scores both model and boat-name indexes with SequenceMatcher (plus a
    containment boost) and returns up to `limit` [{name, type}] candidates,
    best first.
    """
    if orc_index is None:
        orc_index = load_orc_polars(polars_file or default_polars_file())

    norm_model_q = normalize_model(query)
    norm_text_q = normalize_text(query)
    if not norm_text_q:
        return []

    scored: dict[tuple[str, str], float] = {}

    def _consider(normalized_query: str, candidate_key: str, record: dict) -> None:
        if not normalized_query or not candidate_key:
            return
        score = SequenceMatcher(None, normalized_query, candidate_key).ratio()
        if normalized_query in candidate_key or candidate_key in normalized_query:
            score += 0.15
        boat_name = str(record.get("name") or "").strip()
        boat_type = str(record.get("boat", {}).get("type") or "").strip()
        key = (boat_name, boat_type)
        if score > scored.get(key, 0.0):
            scored[key] = score

    for candidate_model, record in orc_index.get("by_model", {}).items():
        _consider(norm_model_q, candidate_model, record)
    for candidate_name, record in orc_index.get("by_name", {}).items():
        _consider(norm_text_q, candidate_name, record)

    ranked = sorted(scored.items(), key=lambda item: item[1], reverse=True)
    return [{"name": name, "type": boat_type} for (name, boat_type), _ in ranked[:limit]]


# ---------------------------------------------------------------------------
# Full-database publication: every ORC boat type + length-bucket generics
# ---------------------------------------------------------------------------

# LOA buckets for generic cruiser polars (metres); each generic is the
# per-cell median across every certificate in the bucket (one uniform
# angles×speeds grid across the whole 2025 db).
LOA_BUCKETS_M: list[tuple[float, float]] = [
    (0.0, 8.0),
    (8.0, 9.0),
    (9.0, 10.0),
    (10.0, 11.0),
    (11.0, 12.0),
    (12.0, 14.0),
    (14.0, 99.0),
]


def _bucket_label(lo: float, hi: float) -> str:
    to_ft = 3.28084
    if lo <= 0:
        return f"Generic cruiser under {hi:g} m (under {round(hi * to_ft)} ft)"
    if hi >= 99:
        return f"Generic cruiser over {lo:g} m (over {round(lo * to_ft)} ft)"
    return f"Generic cruiser {lo:g}–{hi:g} m ({round(lo * to_ft)}–{round(hi * to_ft)} ft)"


def default_db_output_dir() -> Path:
    """Where the published full polar database lives (served at /data/polars)."""
    return data_root() / "processed" / "polars"


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _artifact(polar_id: str, label: str, polars: dict, source: dict) -> dict:
    tws_kt, twa_deg, speeds_kt = polar_table_to_axes(polars)
    return {
        "schema_version": 1,
        "polar_id": polar_id,
        "label": label,
        "tws_kt": tws_kt,
        "twa_deg": twa_deg,
        "speeds_kt": speeds_kt,
        "source": source,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def build_polar_db(
    *,
    polars_file: Path | None = None,
    out_dir: Path | None = None,
) -> dict:
    """Publish the whole vendored ORC db for the viewer.

    - one artifact per boat TYPE (median-GPH certificate of the group) under
      <out_dir>/boats/<slug>.json
    - generic cruiser polars per LOA bucket (median of every certificate in
      the bucket) under <out_dir>/boats/
    - a compact search index at <out_dir>/index.json

    Returns summary counts.
    """
    from jsonschema import Draft202012Validator

    source_file = polars_file or default_polars_file()
    with open(source_file, "r", encoding="utf-8") as f:
        content = f.read()
    try:
        records = json.loads(content)
    except json.JSONDecodeError:
        import ast

        records = ast.literal_eval(content)

    schema = json.loads(
        (contracts_dir() / "polar.schema.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema)

    target = out_dir or default_db_output_dir()
    boats_dir = target / "boats"
    boats_dir.mkdir(parents=True, exist_ok=True)

    # ---- group certificates by normalized boat type ----
    groups: dict[str, list[dict]] = {}
    for record in records:
        boat_type = str(record.get("boat", {}).get("type") or "").strip()
        if not boat_type or not record.get("vpp"):
            continue
        groups.setdefault(normalize_model(boat_type), []).append(record)

    index_entries: list[dict] = []
    seen_slugs: set[str] = set()
    written = 0

    for norm_type, group in groups.items():
        # display label: most common raw casing in the group
        casings: dict[str, int] = {}
        for record in group:
            raw = str(record["boat"]["type"]).strip()
            casings[raw] = casings.get(raw, 0) + 1
        label = max(casings.items(), key=lambda item: (item[1], item[0]))[0]

        # representative certificate: median GPH (typical performance for the type)
        rated = sorted(group, key=lambda r: r.get("rating", {}).get("gph") or 0.0)
        rep = rated[len(rated) // 2]

        slug = _slugify(label)
        while slug in seen_slugs:  # rare cross-type collisions after slugify
            slug = f"{slug}-{norm_type[:6].lower() or 'x'}"
        seen_slugs.add(slug)

        polars = transform_orc_vpp(rep["vpp"])
        if not polars:
            continue
        artifact = _artifact(
            slug,
            label,
            polars,
            {
                "kind": "orc_vpp",
                "match_type": "type_group",
                "matched_value": label,
                "detail": f"median-GPH certificate of {len(group)} ORC 2025 cert(s)",
            },
        )
        validator.validate(artifact)
        (boats_dir / f"{slug}.json").write_text(
            json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        written += 1

        sizes = rep.get("boat", {}).get("sizes", {})
        index_entries.append(
            {
                "polar_id": slug,
                "label": label,
                "kind": "orc_vpp",
                "loa_m": round(float(sizes.get("loa") or 0.0), 2) or None,
                "builder": str(rep["boat"].get("builder") or "").strip() or None,
                "year": rep["boat"].get("year") or None,
                "certs": len(group),
            }
        )

    # ---- generic length-bucket polars ----
    generics = 0
    for lo, hi in LOA_BUCKETS_M:
        bucket = [
            r
            for r in records
            if r.get("vpp") and lo <= float(r.get("boat", {}).get("sizes", {}).get("loa") or 0.0) < hi
        ]
        if len(bucket) < 5:
            continue
        tables = [transform_orc_vpp(r["vpp"]) for r in bucket]
        first = tables[0]
        median_table = {
            tws: {
                twa: round(_median([t[tws][twa] for t in tables if tws in t and twa in t[tws]]), 3)
                for twa in row
            }
            for tws, row in first.items()
        }
        label = _bucket_label(lo, hi)
        slug = _slugify(label)
        artifact = _artifact(
            slug,
            label,
            median_table,
            {
                "kind": "generic",
                "match_type": "loa_bucket",
                "matched_value": f"{lo:g}-{hi:g} m",
                "detail": f"median of {len(bucket)} ORC 2025 certificates in this length range",
            },
        )
        validator.validate(artifact)
        (boats_dir / f"{slug}.json").write_text(
            json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        index_entries.append(
            {
                "polar_id": slug,
                "label": label,
                "kind": "generic",
                "loa_m": round((lo + min(hi, 20.0)) / 2, 1),
                "builder": None,
                "year": None,
                "certs": len(bucket),
            }
        )
        generics += 1

    index_entries.sort(key=lambda item: (item["kind"] != "generic", item["label"].lower()))
    (target / "index.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "ORC 2025 VPP database (vendored)",
                "polars": index_entries,
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )

    return {"types": written, "generics": generics, "certs": len(records)}
