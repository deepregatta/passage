#!/usr/bin/env python3
"""Print one row per GRIB message: parameter, level, times, grid, range, spot value.

Manual check for Passage's GRIB export (docs/grib-export.md), decoded with
ecCodes like most sailing apps' readers:

    cd analysis && uv run python scripts/inspect_grib.py <file.grb2> [--point 49.65,-1.62]
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import eccodes
import numpy as np


def _point(text: str) -> tuple[float, float]:
    lat, lon = (float(part) for part in text.split(","))
    return lat, lon


def _valid_time(gid) -> str:
    date = eccodes.codes_get(gid, "dataDate")
    time = eccodes.codes_get(gid, "dataTime")
    step = eccodes.codes_get(gid, "forecastTime")
    ref = datetime.strptime(f"{date}{time:04d}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return f"{ref:%Y-%m-%dT%H}Z+{step:03d}h={ref + timedelta(hours=step):%Y-%m-%dT%H:%MZ}"


def describe(path: Path, point: tuple[float, float] | None) -> list[str]:
    rows = []
    with path.open("rb") as handle:
        while True:
            gid = eccodes.codes_grib_new_from_file(handle)
            if gid is None:
                break
            try:
                get = eccodes.codes_get
                values = eccodes.codes_get_values(gid)
                missing = get(gid, "numberOfMissing")
                present = values[values != get(gid, "missingValue")] if missing else values
                param = (
                    f"{get(gid, 'shortName', str):>6} "
                    f"{get(gid, 'discipline')}/{get(gid, 'parameterCategory')}/"
                    f"{get(gid, 'parameterNumber')}"
                )
                level = f"lev {get(gid, 'typeOfFirstFixedSurface')}/{get(gid, 'level')}"
                grid = (
                    f"{get(gid, 'Ni')}x{get(gid, 'Nj')} "
                    f"({get(gid, 'latitudeOfFirstGridPointInDegrees'):.4f},"
                    f"{get(gid, 'longitudeOfFirstGridPointInDegrees'):.4f})->"
                    f"({get(gid, 'latitudeOfLastGridPointInDegrees'):.4f},"
                    f"{get(gid, 'longitudeOfLastGridPointInDegrees'):.4f}) "
                    f"d={get(gid, 'iDirectionIncrementInDegrees'):.6f}"
                )
                spread = (
                    f"min {np.min(present):8.3f} max {np.max(present):8.3f}"
                    if len(present)
                    else "all missing"
                )
                row = (
                    f"{param} {level:>11} {_valid_time(gid)} centre {get(gid, 'centre', str)} "
                    f"{grid} missing {missing:>6} {spread}"
                )
                if point:
                    nearest = eccodes.codes_grib_find_nearest(gid, *point)[0]
                    value = (
                        "missing"
                        if missing and nearest.value == get(gid, "missingValue")
                        else f"{nearest.value:.3f}"
                    )
                    row += f" @({nearest.lat:.4f},{nearest.lon:.4f}) {value}"
                rows.append(row)
            finally:
                eccodes.codes_release(gid)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", type=Path)
    parser.add_argument("--point", type=_point, help="lat,lon for a nearest-point value")
    args = parser.parse_args()
    rows = describe(args.file, args.point)
    for row in rows:
        print(row)
    print(f"{len(rows)} messages")


if __name__ == "__main__":
    main()
