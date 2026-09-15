"""Stable ASCII slugs for stored bulletin and polar identifiers."""

import re


def slugify(text: str) -> str:
    """Lowercase and collapse non-ASCII-alphanumeric runs; may return empty.

    Keep fallback identifiers (such as 'polar') at the domain-specific caller.
    Do not transliterate: existing stored identifiers rely on this behavior.
    """
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
