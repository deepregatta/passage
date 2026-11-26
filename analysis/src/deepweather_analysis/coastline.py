"""The browser router's global coastline outline (viewer/public/data/land/global-005.*).

GLOBE land (the global-land-mask package, 30 arc-second pixels, 6 x 6 per cell) is
sampled at the centres of a 0.05 degree grid, then grown by one cell, the buffer the
router keeps from the coast. The growth preserves the topology of the sampled outline:
a cell is added only when that neither splits the edge-connected sea nor joins two
separate land masses, so a channel narrower than the buffer keeps a one-cell lane,
while dead-end inlets are filled as plain growth would. Cells holding any GLOBE land
pixel are added first, and wherever topology allows.

Then native consistency: the router treats edge-adjacent sea cells as joined, so
every sea cell must hold native water at least three pixels wide (it survives one
3x3 erosion) and every two edge-adjacent sea cells must be joined by such water
inside those two cells (see native_tables). Any path of sea cells then has a native
water path at least three pixels wide inside its own cells. Cells that fail are
filled and the growth redone until none is left.

Grids are row-major with row 0 at the southern edge; longitude wraps, latitude
does not (rows beyond the grid count as sea; on the globe no cell within a row of
either pole is a growth candidate). The sea is 4-connected and land 8-connected,
the rule the router enforces (`segmentCrossesLand` rejects a leg through a
corner where two land cells meet diagonally).
"""

from __future__ import annotations

import gzip
import importlib.resources
import io
from importlib.metadata import version

import numpy as np
from scipy import ndimage

RESOLUTION = 0.05
LAT0 = -90.0
LON0 = -180.0
NLAT = 3601
NLON = 7200
PIXELS = 6  # GLOBE pixels per cell side (1/120 degree)
GROWTH_RULE = "topology-preserving-1-cell+globe-30s-native-consistency"

# The eight neighbours of a cell, (row, column) offsets; bit k of a neighbourhood code.
RING = ((-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1))


def _neighbour_components(
    cells: list[tuple[int, int]], diagonal: bool
) -> list[list[tuple[int, int]]]:
    seen: set[tuple[int, int]] = set()
    components = []
    for cell in cells:
        if cell in seen:
            continue
        seen.add(cell)
        component, stack = [cell], [cell]
        while stack:
            a = stack.pop()
            for b in cells:
                if b in seen:
                    continue
                d = abs(a[0] - b[0]) + abs(a[1] - b[1])
                if d == 1 or (diagonal and abs(a[0] - b[0]) == 1 and abs(a[1] - b[1]) == 1):
                    seen.add(b)
                    stack.append(b)
                    component.append(b)
        components.append(component)
    return components


def _addable_table() -> np.ndarray:
    """table[code]: whether a sea cell whose eight neighbours are `code` (bit k set when
    RING[k] is land) can become land without changing the topology: its land neighbours
    form one 8-connected group and its edge-adjacent sea neighbours one 4-connected group
    (a simple point), or it is a one-cell sea hole."""
    table = np.zeros(256, dtype=bool)
    for code in range(256):
        land = [RING[k] for k in range(8) if code >> k & 1]
        sea = [RING[k] for k in range(8) if not code >> k & 1]
        land_groups = len(_neighbour_components(land, diagonal=True))
        sea_groups = sum(
            1
            for group in _neighbour_components(sea, diagonal=False)
            if any(abs(a) + abs(b) == 1 for a, b in group)
        )
        table[code] = land_groups == 1 and sea_groups <= 1
    return table


ADDABLE = _addable_table()


def dilate1(land: np.ndarray) -> np.ndarray:
    """Plain one-cell (3x3) growth; longitude wraps, rows beyond the grid are sea."""
    grown = land.copy()
    for row_shift in (-1, 0, 1):
        rows = np.zeros_like(land)
        if row_shift == -1:
            rows[:-1] = land[1:]
        elif row_shift == 1:
            rows[1:] = land[:-1]
        else:
            rows = land
        grown |= rows | np.roll(rows, 1, axis=1) | np.roll(rows, -1, axis=1)
    return grown


def topo_grow(land: np.ndarray, target: np.ndarray, bands: list[np.ndarray]) -> np.ndarray:
    """Grow `land` toward `target` one topology-preserving cell at a time, until stable.

    Candidates (target cells still sea) are tried band by band, each band to stability;
    within a pass the four parity subfields (row % 2, column % 2) are tried in turn, all
    cells of a subfield at once: no two of them are neighbours, so adding them together
    is the same as adding them one by one."""
    ny, nx = land.shape
    padded = np.zeros((ny + 2, nx), dtype=bool)
    padded[1:-1] = land
    candidates = target & ~land
    for band in bands:
        rows, cols = np.nonzero(candidates & band)
        parity = (rows % 2) * 2 + cols % 2
        groups = [(rows[parity == s] + 1, cols[parity == s]) for s in range(4)]
        while True:
            added = 0
            for s, (gi, gj) in enumerate(groups):
                sea = ~padded[gi, gj]
                gi, gj = gi[sea], gj[sea]
                groups[s] = (gi, gj)
                if not len(gi):
                    continue
                code = np.zeros(len(gi), dtype=np.uint8)
                for k, (di, dj) in enumerate(RING):
                    code |= padded[gi + di, (gj + dj) % nx].astype(np.uint8) << k
                ok = ADDABLE[code]
                if ok.any():
                    padded[gi[ok], gj[ok]] = True
                    added += int(ok.sum())
            if not added:
                break
    return padded[1:-1].copy()


# --- native consistency -----------------------------------------------------------------
#
# Native water is GLOBE's water after `erode` 3x3 erosions, so a passage narrower than
# 2 * erode + 1 pixels does not count. Each sea cell near GLOBE land gets one "main"
# water component: the largest 4-connected component inside its own pixels, labelled over
# those pixels and `reach` pixels around them (reach 0: the cell alone). Two edge-adjacent
# sea cells must have their main components connected when labelled over the union of
# their two windows. A main component is a connected set inside its window, so it lies
# inside one component of any union holding that window: the pairwise connections chain,
# and any path of edge-adjacent sea cells has a native water path from the first cell's
# main component to the last one's, inside the path's windows. No cell can then join
# two separately labelled water bodies. Cells with no such water ("dry") and one cell of
# each failing pair (the one holding more GLOBE land pixels) are filled, the growth is
# redone, and so on until none is left; the tables depend on GLOBE only, so they are
# computed once.

_PLANE4 = np.zeros((3, 3, 3), dtype=bool)
_PLANE4[1] = ndimage.generate_binary_structure(2, 1)
_PLANE8 = np.zeros((3, 3, 3), dtype=bool)
_PLANE8[1] = True
ERODE = 1
REACH = 0  # pixels around a cell its native water is labelled over (0 = the cell alone)
MAX_LAND_PX: int | None = None
_CHUNK = 40_000


class CellAlignedWater:
    """Native water pixels laid out by cell, row 0 at the south: cell (i, j) holds rows
    [p*i, p*(i+1)) and columns [p*j, p*(j+1)). Columns wrap, rows past the edge repeat it."""

    def __init__(self, water: np.ndarray, pixels: int = PIXELS):
        self.water, self.pixels = water, pixels

    def rows(self, i0: np.ndarray, height: int, margin: int) -> np.ndarray:
        r = self.pixels * i0[:, None] - margin + np.arange(height)[None, :]
        return np.clip(r, 0, self.water.shape[0] - 1)

    def cols(self, j0: np.ndarray, width: int, margin: int) -> np.ndarray:
        c = self.pixels * j0[:, None] - margin + np.arange(width)[None, :]
        return c % self.water.shape[1]


class GlobeWater(CellAlignedWater):
    """GLOBE's own layout (row 0 at 90N, column 0 at 180W): cell (i, j) spans GLOBE rows
    [21597 - 6i, 21603 - 6i) and columns [6j - 3, 6j + 3), as in land_pixel_count."""

    def rows(self, i0: np.ndarray, height: int, margin: int) -> np.ndarray:
        south = self.water.shape[0] + 2 - self.pixels * i0[:, None] + margin
        return np.clip(south - np.arange(height)[None, :], 0, self.water.shape[0] - 1)

    def cols(self, j0: np.ndarray, width: int, margin: int) -> np.ndarray:
        c = self.pixels * j0[:, None] - self.pixels // 2 - margin + np.arange(width)[None, :]
        return c % self.water.shape[1]


def _water_windows(native, i0, j0, ni: int, nj: int, margin: int, erode: int) -> np.ndarray:
    """(N, ni*p + 2*margin, nj*p + 2*margin) native water of cells i0..i0+ni-1,
    j0..j0+nj-1 and `margin` pixels around them, south row first, eroded `erode` times
    (read with `erode` extra pixels, so the result is exact)."""
    p = native.pixels
    rows = native.rows(np.asarray(i0), ni * p + 2 * (margin + erode), margin + erode)
    cols = native.cols(np.asarray(j0), nj * p + 2 * (margin + erode), margin + erode)
    water = native.water[rows[:, :, None], cols[:, None, :]]
    if erode:
        water = ndimage.binary_erosion(water, structure=_PLANE8, iterations=erode, border_value=1)
        water = water[:, erode:-erode, erode:-erode]
    return water


def _main_water(native, ii, jj, reach, erode):
    """Per cell: its main component's first pixel (row, column in the cell, south first,
    -1 when dry) and how many of its own pixels are (eroded) water."""
    p, r = native.pixels, reach
    rep = np.full(len(ii), -1, dtype=np.int16)
    wet = np.zeros(len(ii), dtype=np.uint8)
    for a in range(0, len(ii), _CHUNK):
        i, j = ii[a : a + _CHUNK], jj[a : a + _CHUNK]
        labels, count = ndimage.label(_water_windows(native, i, j, 1, 1, r, erode), _PLANE4)
        own = labels[:, r : r + p, r : r + p].reshape(len(i), p * p)
        wet[a : a + len(i)] = (own > 0).sum(axis=1)
        n = np.repeat(np.arange(len(i)), p * p)[own.ravel() > 0]
        lab = own.ravel()[own.ravel() > 0].astype(np.int64)
        if not len(lab):
            continue
        keys, sizes = np.unique(n * (count + 1) + lab, return_counts=True)
        cell, label = keys // (count + 1), keys % (count + 1)
        order = np.lexsort((label, -sizes, cell))
        first = order[np.r_[True, cell[order][1:] != cell[order][:-1]]]
        main = np.zeros(len(i), dtype=np.int64)
        main[cell[first]] = label[first]
        hit = (own == main[:, None]) & (main[:, None] > 0)
        rep[a : a + len(i)] = np.where(hit.any(axis=1), hit.argmax(axis=1), -1)
    return rep, wet


def _pairs_joined(native, ci, cj, rep_c, rep_d, vertical: bool, reach, erode):
    """Whether each pair's two main components are connected over their union window."""
    p, r = native.pixels, reach
    ok = np.zeros(len(ci), dtype=bool)
    for a in range(0, len(ci), _CHUNK):
        i, j = ci[a : a + _CHUNK], cj[a : a + _CHUNK]
        rc, rd = rep_c[a : a + _CHUNK].astype(np.int64), rep_d[a : a + _CHUNK].astype(np.int64)
        shape = (2, 1) if vertical else (1, 2)
        labels, _ = ndimage.label(_water_windows(native, i, j, *shape, r, erode), _PLANE4)
        n = np.arange(len(i))
        lab_c = labels[n, r + rc // p, r + rc % p]
        lab_d = labels[n, r + (p if vertical else 0) + rd // p, r + (0 if vertical else p) + rd % p]
        ok[a : a + len(i)] = (lab_c == lab_d) & (lab_c > 0)
    return ok


def native_tables(
    native, sampled: np.ndarray, land_pixels: np.ndarray, reach: int = REACH, erode: int = ERODE
):
    """The mask-independent consistency tables: which cells are dry, how many of their own
    pixels are water, and the edge-adjacent pairs (c, d) whose main components do not
    connect. Only cells that can be sea (not centre-sampled land) and lie within two cells
    of a GLOBE land pixel are judged; every other cell's native water is its whole block."""
    ny, nx = sampled.shape
    p = native.pixels
    near = dilate1(dilate1(land_pixels > 0)) & ~sampled
    ii, jj = np.nonzero(near)
    rep_near, wet_near = _main_water(native, ii, jj, reach, erode)
    rep = np.full((ny, nx), (p // 2) * p + p // 2, dtype=np.int16)
    wet = np.full((ny, nx), p * p, dtype=np.uint8)
    rep[ii, jj], wet[ii, jj] = rep_near, wet_near
    dry = rep < 0
    failing = []
    can = ~sampled & ~dry
    for vertical in (False, True):
        if vertical:
            pair = np.zeros_like(can)
            pair[:-1] = can[:-1] & can[1:] & (near[:-1] | near[1:])
        else:
            pair = can & np.roll(can, -1, axis=1) & (near | np.roll(near, -1, axis=1))
        ci, cj = np.nonzero(pair)
        di, dj = (ci + 1, cj) if vertical else (ci, (cj + 1) % nx)
        ok = _pairs_joined(native, ci, cj, rep[ci, cj], rep[di, dj], vertical, reach, erode)
        failing.append(np.stack([ci[~ok], cj[~ok], di[~ok], dj[~ok]]))
    return dry, wet, np.concatenate(failing, axis=1)


def grow_outline(
    sampled: np.ndarray,
    land_pixels: np.ndarray,
    native,
    reach: int = REACH,
    erode: int = ERODE,
    max_land_px: int | None = MAX_LAND_PX,
) -> np.ndarray:
    """The published outline from the centre-sampled land, each cell's land-pixel count
    and the native water (a CellAlignedWater or GlobeWater)."""
    holds_land = land_pixels > 0
    target = dilate1(sampled) | holds_land
    bands = [holds_land, np.ones_like(holds_land)]
    dry, wet, (ci, cj, di, dj) = native_tables(native, sampled, land_pixels, reach, erode)
    if max_land_px is not None:
        dry = dry | (land_pixels > max_land_px)
    land = topo_grow(sampled, target, bands)
    while True:
        sea = ~land
        victims = sea & dry
        live = sea[ci, cj] & sea[di, dj]
        a, b = (ci[live], cj[live]), (di[live], dj[live])
        # Fill the cell holding more GLOBE land; on a tie, the one with less water; then d.
        ka = land_pixels[a].astype(int) * 64 + (63 - wet[a].astype(int))
        kb = land_pixels[b].astype(int) * 64 + (63 - wet[b].astype(int))
        first = ka > kb
        victims[a[0][first], a[1][first]] = True
        victims[b[0][~first], b[1][~first]] = True
        if not victims.any():
            return land
        land = topo_grow(land | victims, target, bands)


# --- GLOBE source -----------------------------------------------------------------------


GLOBE_FILE = "globe_combined_mask_compressed.npz"
GLOBE_SHAPE = (21600, 43200)


def load_globe() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The package's GLOBE water mask (True = water; row 0 at 90N, column 0 at 180W,
    1/120 degree) with its latitude and longitude axes, read from the data file the
    package ships rather than through its module-level copy. That file is not part of
    the package's API, so its name, shape and axes are checked and a mismatch stops the
    build with a clear error."""
    data = importlib.resources.files("global_land_mask") / GLOBE_FILE
    if not data.is_file():
        raise RuntimeError(
            f"global-land-mask {version('global-land-mask')} has no {GLOBE_FILE}; "
            "the coastline builder was written against 1.0.0"
        )
    with data.open("rb") as stream, np.load(stream) as npz:
        water, lat, lon = npz["mask"], npz["lat"], npz["lon"]
    expected = (
        water.shape == GLOBE_SHAPE
        and water.dtype == bool
        and lat.shape == (GLOBE_SHAPE[0],)
        and lon.shape == (GLOBE_SHAPE[1],)
        and np.isclose(lat[0], 90.0)
        and np.isclose(lat[1] - lat[0], -1 / 120)
        and np.isclose(lon[0], -180.0)
        and np.isclose(lon[1] - lon[0], 1 / 120)
    )
    if not expected:
        raise RuntimeError(
            f"{GLOBE_FILE} in global-land-mask {version('global-land-mask')} is not the "
            f"{GLOBE_SHAPE} 30-arc-second water mask from 90N, 180W the builder expects"
        )
    return water, lat, lon


def centre_sample(water: np.ndarray, lat_axis: np.ndarray, lon_axis: np.ndarray) -> np.ndarray:
    """GLOBE land at each cell centre, with global_land_mask 1.0's own index arithmetic
    (globe.lat_to_index / lon_to_index / is_land), in the former builder's 120-row chunks."""
    lons = LON0 + RESOLUTION * np.arange(NLON)
    land = np.empty((NLAT, NLON), dtype=bool)
    for start in range(0, NLAT, 120):
        stop = min(NLAT, start + 120)
        lats = LAT0 + RESOLUTION * np.arange(start, stop)
        lon_grid, lat_grid = np.meshgrid(lons, lats)
        lat_grid = np.clip(lat_grid, lat_axis.min(), lat_axis.max())
        lon_grid = np.clip(lon_grid, lon_axis.min(), lon_axis.max())
        lat_i = ((lat_grid - lat_axis[0]) / (lat_axis[1] - lat_axis[0])).astype("int")
        lon_i = ((lon_grid - lon_axis[0]) / (lon_axis[1] - lon_axis[0])).astype("int")
        land[start:stop] = np.logical_not(water[lat_i, lon_i])
    return land


def land_pixel_count(water: np.ndarray, chunk: int = 200) -> np.ndarray:
    """How many of the 6x6 GLOBE pixels inside each cell are land (0..36). Cell (i, j)
    spans GLOBE rows [21597 - 6i, 21603 - 6i) and columns [6j - 3, 6j + 3); rows past a
    pole repeat the pole row, columns wrap."""
    native_rows = water.shape[0]
    count = np.empty((NLAT, NLON), dtype=np.uint8)
    for a in range(0, NLAT, chunk):
        b = min(NLAT, a + chunk)
        rows = np.clip(
            np.arange(native_rows - 3 - PIXELS * (b - 1), native_rows + 3 - PIXELS * a),
            0,
            native_rows - 1,
        )
        land = np.roll(~water[rows], 3, axis=1)
        blocks = land.reshape(b - a, PIXELS, NLON, PIXELS).sum(axis=(1, 3), dtype=np.uint8)
        count[a:b] = blocks[::-1]
    return count


def pack(land: np.ndarray) -> bytes:
    """LSB-first bit packing, gzip level 9 with a fixed name and mtime: byte-reproducible."""
    out = io.BytesIO()
    with gzip.GzipFile(
        filename="global-005.bin", mode="wb", fileobj=out, compresslevel=9, mtime=0
    ) as stream:
        stream.write(np.packbits(land.reshape(-1), bitorder="little").tobytes())
    return out.getvalue()


def unpack(data: bytes, nlat: int = NLAT, nlon: int = NLON) -> np.ndarray:
    bits = np.unpackbits(np.frombuffer(gzip.decompress(data), dtype=np.uint8), bitorder="little")
    return bits[: nlat * nlon].reshape(nlat, nlon).astype(bool)


def metadata(generated_at: str, erode: int = ERODE, reach: int = REACH) -> dict:
    return {
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
        "growth_rule": GROWTH_RULE,
        "native_erosion_px": erode,
        "native_reach_px": reach,
        "encoding": "gzip",
        "generated_at": generated_at,
        "source": "global-land-mask GLOBE",
        "source_version": version("global-land-mask"),
    }
