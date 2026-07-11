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


def cmd_fetch_currents(args: argparse.Namespace) -> int:
    from .grids_prep import prepare_current_grid

    bounds = None
    if args.bounds:
        try:
            min_lat, max_lat, min_lon, max_lon = (float(v) for v in args.bounds.split(","))
        except ValueError:
            print("--bounds must be 'min_lat,max_lat,min_lon,max_lon'")
            return 1
        bounds = {
            "min_lat": min_lat,
            "max_lat": max_lat,
            "min_lon": min_lon,
            "max_lon": max_lon,
        }
    path = prepare_current_grid(
        bounds=bounds, start=args.start, end=args.end, force=args.force
    )
    print(f"published {path}")
    return 0


def cmd_prepare_run(args: argparse.Namespace) -> int:
    from .synoptic_prep import prepare_synoptic

    summary = prepare_synoptic(cycle=args.cycle, force=args.force)
    print(f"prepared run {summary.get('run_id')}")
    for key in ("systems", "charts", "publication_lag_min"):
        if key in summary:
            print(f"  {key}: {summary[key]}")
    return 0


def cmd_fetch_warnings(args: argparse.Namespace) -> int:
    from .warnings_mf import fetch_warnings

    path = fetch_warnings(gale_zone=args.gale, paste_file=args.paste)
    doc = __import__("json").loads(path.read_text())
    print(f"wrote {path} — feed_status={doc['feed_status']}, bulletins={len(doc['bulletins'])}")
    return 0


def cmd_tides(args: argparse.Namespace) -> int:
    from .tides import prepare_tides

    path = prepare_tides(start_iso=args.start, hours=args.hours)
    print(f"wrote {path} (SYNTHETIC constituents — badged emulated downstream)")
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

    currents_parser = subparsers.add_parser(
        "fetch-currents", help="CMEMS forecast currents -> region grid artifact"
    )
    currents_parser.add_argument(
        "--start", default=None, help="window start ISO UTC (default: now)"
    )
    currents_parser.add_argument(
        "--end", default=None, help="window end ISO UTC (default: start + 72h)"
    )
    currents_parser.add_argument(
        "--bounds",
        default=None,
        help="override box as 'min_lat,max_lat,min_lon,max_lon' (default: Channel window)",
    )
    currents_parser.add_argument(
        "--force", action="store_true", help="re-fetch even if a fresh cache exists"
    )
    currents_parser.set_defaults(func=cmd_fetch_currents)

    prepare_parser = subparsers.add_parser(
        "prepare-run", help="ECMWF cycle -> synoptic features + charts + wind grid + manifest"
    )
    prepare_parser.add_argument("--cycle", default=None, help="e.g. 20260712T00Z (default latest)")
    prepare_parser.add_argument("--force", action="store_true")
    prepare_parser.set_defaults(func=cmd_prepare_run)

    warnings_parser = subparsers.add_parser(
        "fetch-warnings", help="marine warnings -> data/processed/warnings/latest.json"
    )
    warnings_parser.add_argument("--gale", help="synthetic mode: inject a gale bulletin for ZONE")
    warnings_parser.add_argument("--paste", help="manual mode: parse a pasted bulletin text file")
    warnings_parser.set_defaults(func=cmd_fetch_warnings)

    tides_parser = subparsers.add_parser(
        "tides", help="HW/LW predictions at reference ports (synthetic harmonics)"
    )
    tides_parser.add_argument("--start", default=None, help="window start ISO UTC (default now)")
    tides_parser.add_argument("--hours", type=int, default=96)
    tides_parser.set_defaults(func=cmd_tides)

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
