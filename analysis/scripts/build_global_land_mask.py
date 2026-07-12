#!/usr/bin/env python3
"""Build the packed, dilated global coastline asset used by browser routing."""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from global_land_mask import globe

RESOLUTION = 0.05
LAT0 = -90.0
LON0 = -180.0
NLAT = 3601
NLON = 7200


def main() -> None:
    repo = Path(__file__).resolve().parents[2]
    output = repo / "viewer" / "public" / "data" / "land"
    output.mkdir(parents=True, exist_ok=True)

    lons = LON0 + RESOLUTION * np.arange(NLON)
    land = np.empty((NLAT, NLON), dtype=bool)
    for start in range(0, NLAT, 120):
        stop = min(NLAT, start + 120)
        lats = LAT0 + RESOLUTION * np.arange(start, stop)
        lon_grid, lat_grid = np.meshgrid(lons, lats)
        land[start:stop] = globe.is_land(lat_grid, lon_grid)

    dilated = land.copy()
    for row_shift in (-1, 0, 1):
        rows = np.zeros_like(land)
        if row_shift == -1:
            rows[:-1] = land[1:]
        elif row_shift == 1:
            rows[1:] = land[:-1]
        else:
            rows = land
        dilated |= rows | np.roll(rows, 1, axis=1) | np.roll(rows, -1, axis=1)

    packed = np.packbits(dilated.reshape(-1), bitorder="little").tobytes()
    with gzip.GzipFile(
        filename="global-005.bin", mode="wb", fileobj=(output / "global-005.bin.gz").open("wb"),
        compresslevel=9, mtime=0,
    ) as stream:
        stream.write(packed)

    metadata = {
        "schema_version": 1,
        "kind": "packed_land_mask",
        "lat0": LAT0,
        "lon0": LON0,
        "dlat": RESOLUTION,
        "dlon": RESOLUTION,
        "nlat": NLAT,
        "nlon": NLON,
        "bit_order": "lsb",
        "dilated_cells": 1,
        "encoding": "gzip",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "global-land-mask GLOBE",
    }
    (output / "global-005.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
