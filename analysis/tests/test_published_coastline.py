"""The published coastline outline (viewer/public/data/land/global-005.*) against GLOBE.

Reads the committed files. Centre sampling goes through global_land_mask's public is_land,
independently of the builder's arithmetic; the native-consistency check reads GLOBE's
pixels through the builder's loader but labels them with its own code. About 2 GB of
memory (the GLOBE array is held twice: by the package, which test_land_mask also loads,
and by this check) and well under a minute."""

import json
from pathlib import Path

import numpy as np
import pytest
from scipy import ndimage

from deepweather_analysis import coastline

LAND = Path(__file__).resolve().parents[2] / "viewer" / "public" / "data" / "land"
FOUR = ndimage.generate_binary_structure(2, 1)
P = 6


@pytest.fixture(scope="module")
def published():
    metadata = json.loads((LAND / "global-005.json").read_text())
    outline = coastline.unpack(
        (LAND / "global-005.bin.gz").read_bytes(), metadata["nlat"], metadata["nlon"]
    )
    return metadata, outline


@pytest.fixture(scope="module")
def sampled():
    from global_land_mask import globe

    lons = coastline.LON0 + coastline.RESOLUTION * np.arange(coastline.NLON)
    land = np.empty((coastline.NLAT, coastline.NLON), dtype=bool)
    for start in range(0, coastline.NLAT, 120):
        stop = min(coastline.NLAT, start + 120)
        lats = coastline.LAT0 + coastline.RESOLUTION * np.arange(start, stop)
        lon_grid, lat_grid = np.meshgrid(lons, lats)
        land[start:stop] = globe.is_land(lat_grid, lon_grid)
    return land


def cell(lat: float, lon: float) -> tuple[int, int]:
    return (
        round((lat - coastline.LAT0) / coastline.RESOLUTION),
        round((lon - coastline.LON0) / coastline.RESOLUTION),
    )


def test_metadata_keeps_the_loader_fields(published):
    metadata, outline = published
    assert metadata["schema_version"] == 1
    assert (metadata["lat0"], metadata["lon0"], metadata["dlat"], metadata["dlon"]) == (
        -90.0,
        -180.0,
        0.05,
        0.05,
    )
    assert (metadata["nlat"], metadata["nlon"]) == outline.shape == (3601, 7200)
    assert metadata["bit_order"] == "lsb" and metadata["encoding"] == "gzip"
    assert metadata["growth_rule"] == coastline.GROWTH_RULE
    assert (metadata["native_erosion_px"], metadata["native_reach_px"]) == (1, 0)


def test_no_sea_cell_on_centre_sampled_land(published, sampled):
    _, outline = published
    assert int((sampled & ~outline).sum()) == 0


def native_windows(water, i, j, height, width):
    """GLOBE water for cells starting at (i, j), `height` x `width` cells, with a one-pixel
    margin, south row first: GLOBE row 21602 - 6i - p, column 6j - 3 + q (wrapping)."""
    rows = 21602 - P * i[:, None] + 1 - np.arange(P * height + 2)[None, :]
    cols = (P * j[:, None] - 3 - 1 + np.arange(P * width + 2)[None, :]) % water.shape[1]
    return water[np.clip(rows, 0, water.shape[0] - 1)[:, :, None], cols[:, None, :]]


def eroded_labels(windows):
    """Erode once (3x3), drop the margin, label 4-connected water in each window apart."""
    plane = np.zeros((3, 3, 3), dtype=bool)
    plane[1] = True
    water = ndimage.binary_erosion(windows, structure=plane, border_value=1)[:, 1:-1, 1:-1]
    cross = np.zeros((3, 3, 3), dtype=bool)
    cross[1] = FOUR
    return ndimage.label(water, structure=cross)[0]


def largest_components(own):
    """own: (N, 36) labels of each cell's own pixels. Returns, per cell, the pixel index of
    one most frequent label (-1 when the cell has no water) and whether that label ties."""
    n, width = own.shape
    rows = np.repeat(np.arange(n), width)[own.ravel() > 0]
    labels = own.ravel()[own.ravel() > 0].astype(np.int64)
    keys, sizes = np.unique(rows * (int(own.max()) + 1) + labels, return_counts=True)
    cells, labs = keys // (int(own.max()) + 1), keys % (int(own.max()) + 1)
    best = np.zeros(n, dtype=np.int64)
    np.maximum.at(best, cells, sizes)
    top = sizes == best[cells]
    ties = np.bincount(cells[top], minlength=n) > 1
    choice = np.zeros(n, dtype=np.int64)
    choice[cells[top]] = labs[top]
    hit = own == choice[:, None]
    pixel = np.where(hit.any(axis=1) & (choice > 0), hit.argmax(axis=1), -1)
    return pixel, ties


def test_edge_adjacent_sea_cells_share_native_water_three_pixels_wide(published):
    """Every sea cell within a cell of GLOBE land holds water that survives one erosion, and
    for every two edge-adjacent sea cells a largest such component of each is joined to the
    other's inside the two cells: so any path of sea cells has native water at least three
    pixels wide inside those cells."""
    _, outline = published
    water, _, _ = coastline.load_globe()
    count = coastline.land_pixel_count(water)
    sea = ~outline
    near = coastline.dilate1(count > 0)
    pixel = np.full(sea.shape, (P // 2) * P + P // 2, dtype=np.int16)  # far from land: centre
    tied = np.zeros(sea.shape, dtype=bool)
    ii, jj = np.nonzero(sea & near)
    for a in range(0, len(ii), 50_000):
        i, j = ii[a : a + 50_000], jj[a : a + 50_000]
        own = eroded_labels(native_windows(water, i, j, 1, 1)).reshape(len(i), -1)
        pixel[i, j], tied[i, j] = largest_components(own)
    dry = np.argwhere(sea & (pixel < 0))
    assert dry.tolist() == [], "sea cells with no native water three pixels wide"
    failures = []
    for vertical in (False, True):
        if vertical:
            pair = np.zeros_like(sea)
            pair[:-1] = sea[:-1] & sea[1:] & (near[:-1] | near[1:])
        else:
            pair = sea & np.roll(sea, -1, axis=1) & (near | np.roll(near, -1, axis=1))
        pi, pj = np.nonzero(pair)
        for a in range(0, len(pi), 50_000):
            i, j = pi[a : a + 50_000], pj[a : a + 50_000]
            di, dj = (i + 1, j) if vertical else (i, (j + 1) % coastline.NLON)
            lab = eroded_labels(native_windows(water, i, j, *((2, 1) if vertical else (1, 2))))
            n = np.arange(len(i))
            pc, pd = pixel[i, j].astype(np.int64), pixel[di, dj].astype(np.int64)
            lab_c = lab[n, pc // P, pc % P]
            lab_d = lab[n, pd // P + (P if vertical else 0), pd % P + (0 if vertical else P)]
            bad = (lab_c != lab_d) & ~tied[i, j] & ~tied[di, dj]
            failures += [(int(x), int(y), vertical) for x, y in zip(i[bad], j[bad])]
    assert failures == []


# Window (min lat, max lat, min lon, max lon) and two sea cells, one each side.
OPEN_STRAITS = {
    "Great Belt": ((54.55, 55.75, 10.55, 11.40), (54.65, 10.9), (55.5, 10.9)),
    "Øresund": ((55.3, 56.3, 12.3, 13.1), (55.5, 12.6), (56.25, 12.35)),
    "Bab-el-Mandeb": ((12.25, 12.95, 42.95, 43.75), (12.35, 43.6), (12.85, 43.25)),
    "Gibraltar": ((35.7, 36.25, -6.3, -5.0), (36.0, -6.0), (36.0, -5.25)),
    "Bonifacio": ((41.15, 41.55, 8.8, 9.6), (41.35, 9.0), (41.35, 9.55)),
    "Pentland Firth": ((58.55, 58.76, -3.6, -2.8), (58.7, -3.55), (58.7, -2.85)),
    "Long Island Sound east entrances": (
        (40.95, 41.35, -72.5, -71.7),
        (41.2, -72.45),
        (41.15, -71.75),
    ),
    "Singapore Strait": ((0.95, 1.5, 103.4, 104.5), (1.2, 103.5), (1.25, 104.2)),
}


def connected_in_window(outline, window, a, b) -> bool:
    """Whether sea within one cell of `a` and of `b` is edge-connected inside the window."""
    (i0, j0), (i1, j1) = cell(window[0], window[2]), cell(window[1], window[3])
    sea = ~outline[i0 : i1 + 1, j0 : j1 + 1]
    lab, _ = ndimage.label(sea, structure=FOUR)

    def near(point):
        i, j = cell(*point)
        cells = [(i + di - i0, j + dj - j0) for di in (-1, 0, 1) for dj in (-1, 0, 1)]
        inside = [(a, b) for a, b in cells if 0 <= a < lab.shape[0] and 0 <= b < lab.shape[1]]
        return {int(lab[c]) for c in inside} - {0}

    return bool(near(a) & near(b))


@pytest.mark.parametrize("name", list(OPEN_STRAITS))
def test_straits_closed_only_by_plain_growth_are_open(published, name):
    window, a, b = OPEN_STRAITS[name]
    assert connected_in_window(published[1], window, a, b)


def test_no_lane_across_the_south_fork_of_long_island(published):
    # GLOBE at cell centres misses the narrow South Fork near 72.05W; GLOBE at 30" has it.
    _, outline = published
    for lat in (40.95, 41.0):
        for lon in (-72.1, -72.05, -72.0):
            assert outline[cell(lat, lon)], (lat, lon)
    assert not connected_in_window(
        outline, (40.85, 41.15, -72.3, -71.95), (41.05, -72.1), (40.85, -72.1)
    )


def test_the_curonian_lagoon_is_not_joined_to_the_baltic(published):
    # GLOBE draws the Curonian Spit as unbroken land between the Baltic and the lagoon.
    _, outline = published
    for site in ((55.05, 20.65), (55.05, 20.7), (55.25, 20.95)):
        assert outline[cell(*site)], site
    lab, _ = ndimage.label(~outline, structure=FOUR)  # the seam is far away
    lagoon, baltic = cell(55.2, 21.05), cell(55.2, 20.5)
    assert lab[lagoon] and lab[baltic] and lab[lagoon] != lab[baltic]


@pytest.mark.parametrize(
    "name, cells",
    [
        ("Giens tombolo", [(43.05, 6.1), (43.05, 6.15), (43.05, 6.2), (43.05, 6.25)]),
        ("Kinburn spit", [(46.55, 31.7), (46.55, 31.75)]),
        ("Outer Banks at Oregon Inlet", [(35.75, -75.5), (36.1, -75.8)]),
    ],
)
def test_thin_land_globe_draws_is_not_crossed(published, name, cells):
    _, outline = published
    for site in cells:
        assert outline[cell(*site)], (name, site)
