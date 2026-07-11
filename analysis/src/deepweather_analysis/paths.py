"""Warehouse path conventions (mirrors coachregatta's paths helper).

All paths resolve relative to the repo root unless DEEPWEATHER_DATA_ROOT is set.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def data_root() -> Path:
    override = os.environ.get("DEEPWEATHER_DATA_ROOT")
    return Path(override) if override else REPO_ROOT / "data"


def cache_dir(kind: str) -> Path:
    path = data_root() / "cache" / kind
    path.mkdir(parents=True, exist_ok=True)
    return path


def processed_dir(*parts: str) -> Path:
    path = data_root() / "processed"
    for part in parts:
        path = path / part
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_dir() -> Path:
    return REPO_ROOT / "config"


def contracts_dir() -> Path:
    return REPO_ROOT / "contracts"
