"""UTC timestamp parsing shared by factory inputs, feeds, and caches."""

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
