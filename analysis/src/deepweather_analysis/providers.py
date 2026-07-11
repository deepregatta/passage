"""Provider-mode framework: every external feed runs as live | fixture | synthetic.

Synthetic values MUST be labeled: any artifact produced by a synthetic provider
carries source.mode == "synthetic" and downstream evidence entries use
source_kind == "emulated". Contract tests reject unlabeled synthetic sources.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from .paths import config_dir


class Mode(str, Enum):
    LIVE = "live"
    FIXTURE = "fixture"
    SYNTHETIC = "synthetic"


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    mode: Mode
    note: str | None = None


def load_providers(path: Path | None = None) -> dict[str, ProviderConfig]:
    config_path = path or config_dir() / "providers.json"
    raw = json.loads(config_path.read_text())
    providers: dict[str, ProviderConfig] = {}
    for name, entry in raw["providers"].items():
        providers[name] = ProviderConfig(
            name=name,
            mode=Mode(entry["mode"]),
            note=entry.get("note"),
        )
    return providers


def provider_mode(name: str, providers: dict[str, ProviderConfig] | None = None) -> Mode:
    table = providers if providers is not None else load_providers()
    if name not in table:
        raise KeyError(f"Unknown provider '{name}' — declare it in config/providers.json")
    return table[name].mode
