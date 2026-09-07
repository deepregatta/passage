"""Synoptic feature layer: pressure-system detection/tracking,
named-regime pattern rules, and rendered synoptic charts.

All detection here is route-independent and runs once per model run;
front-like transition detection along routes lives in the TS engine.
Language stays cautious: structured facts, never a named front type.
"""

from .detect import detect_systems
from .regimes import detect_mistral
from .render import render_panels
from .track import track_systems

__all__ = ["detect_systems", "track_systems", "detect_mistral", "render_panels"]
