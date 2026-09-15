"""UTC timestamp parsing and formatting shared by factory inputs, feeds, and caches."""

from datetime import datetime, timezone


def parse_iso_utc(value: str | datetime) -> datetime:
    """Return an aware UTC datetime; offset-less inputs are UTC, never host local time.

    Explicit offsets are converted to UTC. Invalid ISO strings raise ValueError
    so callers retain their own feed-degradation or input-validation policy.
    """
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_z(dt: datetime) -> str:
    """Format a datetime as UTC to whole seconds, preserving the factory format.

    Factory callers supply aware datetimes; parse offset-less input with
    parse_iso_utc before formatting. Fractional seconds are truncated.
    """
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def optional_iso_utc(value: str | None) -> str | None:
    """Format an optional feed timestamp, retaining the empty-value fallback."""
    return iso_z(parse_iso_utc(value)) if value else None
