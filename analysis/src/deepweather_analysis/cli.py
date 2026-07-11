"""deepweather-analysis CLI.

Subcommands land milestone by milestone:
  prepare-run     M6/M8: fetch model cycle, detect synoptic features, publish artifacts
  fetch-currents  M7:    CMEMS forecast currents -> region grid
  fetch-warnings  M9:    marine bulletins -> warnings.json
  tides           M10:   HW/LW series at reference ports
  extract-polar   M11:   ORC database -> config/polars/<slug>.json
  scenario        M5:    synthetic scenario bundles
  corpus          M13:   archived-case replay + review sheet
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .providers import load_providers


def cmd_providers(_args: argparse.Namespace) -> int:
    for provider in load_providers().values():
        note = f"  ({provider.note})" if provider.note else ""
        print(f"{provider.name:22s} {provider.mode.value}{note}")
    return 0


def cmd_scenario(args: argparse.Namespace) -> int:
    from .scenarios import SCENARIOS, generate_all, generate_scenario

    if args.name == "all":
        for path in generate_all(args.departure):
            print(f"generated {path}")
    elif args.name in SCENARIOS:
        print(f"generated {generate_scenario(args.name, args.departure)}")
    else:
        print(f"unknown scenario '{args.name}' — choose from: all, {', '.join(SCENARIOS)}")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="deepweather-analysis")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command")

    providers_parser = subparsers.add_parser("providers", help="show provider modes")
    providers_parser.set_defaults(func=cmd_providers)

    scenario_parser = subparsers.add_parser(
        "scenario", help="generate synthetic scenario bundles (verdict-state harness)"
    )
    scenario_parser.add_argument("name", help="scenario name or 'all'")
    scenario_parser.add_argument(
        "--departure", default="2026-07-20T06:00:00Z", help="departure ISO UTC"
    )
    scenario_parser.set_defaults(func=cmd_scenario)

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
