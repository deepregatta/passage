"""deepweather-analysis CLI.

Preparation and verification subcommands:
  prepare-run     fetch model cycle, detect synoptic features, publish artifacts
  fetch-currents  CMEMS forecast currents -> region grid
  fetch-warnings  marine bulletins -> warnings.json
  tides           HW/LW series at reference ports
  extract-polar   ORC database -> config/polars/<slug>.json
  scenario        synthetic scenario bundles
  corpus          archived-case replay + review sheet
"""

from __future__ import annotations

import argparse
import json
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
        bounds=bounds, start=args.start, end=args.end, force=args.force, route_id=args.route
    )
    print(f"published {path}")
    return 0


def cmd_prepare_run(args: argparse.Namespace) -> int:
    from .synoptic_prep import prepare_synoptic

    summary = prepare_synoptic(cycle=args.cycle, force=args.force, prefer_long=args.long)
    print(f"prepared run {summary.get('run_id')}")
    for key in ("systems", "charts", "publication_lag_min"):
        if key in summary:
            print(f"  {key}: {summary[key]}")
    return 0


def cmd_fetch_warnings(args: argparse.Namespace) -> int:
    from .warnings_mf import fetch_warnings

    path = fetch_warnings(gale_zone=args.gale, paste_file=args.paste)
    doc = json.loads(path.read_text())
    print(f"wrote {path} — feed_status={doc['feed_status']}, bulletins={len(doc['bulletins'])}")
    return 0


def cmd_tides(args: argparse.Namespace) -> int:
    from .tides import prepare_tides

    path = prepare_tides(start_iso=args.start, hours=args.hours, route_id=args.route)
    mode = json.loads(path.read_text())["source"]["mode"]
    print(f"wrote {path} (source mode: {mode})")
    return 0


def cmd_corpus(args: argparse.Namespace) -> int:
    from .verification.corpus import run_corpus

    case_ids = args.cases.split(",") if args.cases else None
    summary = run_corpus(case_ids=case_ids, fetch=not args.no_fetch)
    print(f"corpus review: {summary.get('review_sheet')}")
    print(
        f"  pass={summary.get('pass')} fail={summary.get('fail')} pending={summary.get('pending')}"
    )
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    from pathlib import Path

    from .observations import fetch_observations
    from .paths import processed_dir
    from .verification.calibration import accumulate_calibration
    from .verification.match import match_snapshot, write_verification

    snapshots = sorted(
        Path(processed_dir("snapshots")).glob("*/findings.json"), key=lambda p: p.stat().st_mtime
    )
    if not snapshots:
        print("no snapshots to verify")
        return 1
    target = snapshots[-1]
    if args.snapshot:
        candidates = [p for p in snapshots if args.snapshot in str(p)]
        if not candidates:
            print(f"snapshot matching '{args.snapshot}' not found")
            return 1
        target = candidates[-1]
    findings = json.loads(target.read_text())
    first_hour = findings["legs"][0]["hours"][0]["valid_time"]
    last_hour = findings["legs"][-1]["hours"][-1]["valid_time"]
    observations = fetch_observations(first_hour, last_hour, route_id=args.route)
    verification = match_snapshot(findings, observations)
    verification_path = write_verification(verification)
    calibration_path = accumulate_calibration([verification])
    source = observations["source"]
    print(f"verified {findings['snapshot_id']}")
    print(f"  observations: {source['mode'].upper()} ({source.get('name', '?')})")
    print(f"  pairs: {len(verification['pairs'])} | coverage: {verification['coverage_summary']}")
    print(f"  verification: {verification_path}")
    print(f"  calibration: {calibration_path}")
    return 0


def cmd_scenario(args: argparse.Namespace) -> int:
    from .scenarios import SCENARIOS, generate_all, generate_scenario

    if args.name == "all":
        for path in generate_all(args.departure, route_id=args.route):
            print(f"generated {path}")
    elif args.name in SCENARIOS:
        print(f"generated {generate_scenario(args.name, args.departure, route_id=args.route)}")
    else:
        print(f"unknown scenario '{args.name}' — choose from: all, {', '.join(SCENARIOS)}")
        return 1
    return 0


def cmd_extract_polar(args: argparse.Namespace) -> int:
    from .polars import extract_polar

    path = extract_polar(args.query, args.id)
    print(f"polar: {path}")
    return 0


def cmd_build_polar_db(_args: argparse.Namespace) -> int:
    from .polars import build_polar_db, default_db_output_dir

    summary = build_polar_db()
    print(
        f"polar db: {summary['types']} boat types + {summary['generics']} length generics "
        f"from {summary['certs']} ORC certificates -> {default_db_output_dir()}"
    )
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
    currents_parser.add_argument(
        "--route", default=None, help="route id in config/route-sources.json (default route)"
    )
    currents_parser.set_defaults(func=cmd_fetch_currents)

    prepare_parser = subparsers.add_parser(
        "prepare-run", help="ECMWF cycle -> synoptic features + charts + wind grid + manifest"
    )
    prepare_parser.add_argument("--cycle", default=None, help="e.g. 20260712T00Z (default latest)")
    prepare_parser.add_argument(
        "--long",
        action="store_true",
        help="use the latest 00Z/12Z cycle (10-day horizon) instead of the freshest cycle (~4 days on 06Z/18Z)",
    )
    prepare_parser.add_argument("--force", action="store_true")
    prepare_parser.set_defaults(func=cmd_prepare_run)

    warnings_parser = subparsers.add_parser(
        "fetch-warnings", help="marine warnings -> data/processed/warnings/latest.json"
    )
    warnings_parser.add_argument("--gale", help="synthetic mode: inject a gale bulletin for ZONE")
    warnings_parser.add_argument("--paste", help="manual mode: parse a pasted bulletin text file")
    warnings_parser.set_defaults(func=cmd_fetch_warnings)

    tides_parser = subparsers.add_parser(
        "tides", help="HW/LW predictions at reference ports (live CMEMS SSH; synthetic fallback)"
    )
    tides_parser.add_argument("--start", default=None, help="window start ISO UTC (default now)")
    tides_parser.add_argument("--hours", type=int, default=96)
    tides_parser.add_argument(
        "--route", default=None, help="route id in config/route-sources.json (default route)"
    )
    tides_parser.set_defaults(func=cmd_tides)

    corpus_parser = subparsers.add_parser(
        "corpus", help="retrospective corpus: replay synoptic detection on ERA5 (review sheet)"
    )
    corpus_parser.add_argument("--cases", default=None, help="comma-separated case ids")
    corpus_parser.add_argument("--no-fetch", action="store_true", help="cached ERA5 only")
    corpus_parser.set_defaults(func=cmd_corpus)

    verify_parser = subparsers.add_parser(
        "verify", help="match a snapshot against observations -> coverage classes + calibration"
    )
    verify_parser.add_argument(
        "--snapshot", default=None, help="snapshot id substring (default latest)"
    )
    verify_parser.add_argument(
        "--route", default=None, help="route id in config/route-sources.json (default route)"
    )
    verify_parser.set_defaults(func=cmd_verify)

    extract_parser = subparsers.add_parser(
        "extract-polar", help="ORC database -> config/polars/<slug>.json"
    )
    extract_parser.add_argument("query", help="boat model or name, e.g. 'SUN FAST 3200'")
    extract_parser.add_argument("--id", default=None, help="override the polar slug")
    extract_parser.set_defaults(func=cmd_extract_polar)

    polar_db_parser = subparsers.add_parser(
        "build-polar-db",
        help="publish the whole ORC db: per-type polars + length generics + search index",
    )
    polar_db_parser.set_defaults(func=cmd_build_polar_db)

    scenario_parser = subparsers.add_parser(
        "scenario", help="generate synthetic scenario bundles (verdict-state harness)"
    )
    scenario_parser.add_argument("name", help="scenario name or 'all'")
    scenario_parser.add_argument(
        "--departure", default="2026-07-20T06:00:00Z", help="departure ISO UTC"
    )
    scenario_parser.add_argument("--route", default=None, help="route id in config/routes")
    scenario_parser.set_defaults(func=cmd_scenario)

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
