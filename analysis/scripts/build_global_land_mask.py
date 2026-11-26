#!/usr/bin/env python3
"""Build the packed global coastline outline used by browser routing.

GLOBE land sampled at 0.05 degree cell centres, grown by one cell with the
topology-preserving rule of deepweather_analysis.coastline, then made consistent with
GLOBE's own 30" water (passages at least three pixels wide inside the cells). Writes
viewer/public/data/land/global-005.bin.gz (byte-reproducible) and
global-005.json (whose generated_at records when it was built).
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from deepweather_analysis import coastline


def main() -> None:
    repo = Path(__file__).resolve().parents[2]
    output = repo / "viewer" / "public" / "data" / "land"
    output.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    water, lat_axis, lon_axis = coastline.load_globe()
    sampled = coastline.centre_sample(water, lat_axis, lon_axis)
    land_pixels = coastline.land_pixel_count(water)
    outline = coastline.grow_outline(sampled, land_pixels, coastline.GlobeWater(water))
    (output / "global-005.bin.gz").write_bytes(coastline.pack(outline))
    generated_at = datetime.now(timezone.utc).isoformat()
    (output / "global-005.json").write_text(
        json.dumps(coastline.metadata(generated_at), indent=2) + "\n"
    )

    sea = ~outline
    print(f"built in {time.perf_counter() - started:.1f} s")
    print(f"land cells {int(outline.sum())}, sampled land {int(sampled.sum())}")
    print(f"sea cells on sampled land {int((sampled & sea).sum())} (must be 0)")
    print(f"sea cells holding GLOBE land pixels {int((sea & (land_pixels > 0)).sum())}")


if __name__ == "__main__":
    main()
