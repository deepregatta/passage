"""The coastline outline's growth rule on small synthetic worlds (deepweather_analysis.coastline).

Each world is drawn north row first, '#' land and '.' sea, one cell per character; its
native pixels (6x6 per cell) copy the cell unless a test changes some. Sea is
4-connected and land 8-connected, as the router reads the outline."""

import numpy as np
from scipy import ndimage

from deepweather_analysis import coastline

P = coastline.PIXELS
FOUR = ndimage.generate_binary_structure(2, 1)
EIGHT = ndimage.generate_binary_structure(2, 2)


def world(*rows: str) -> np.ndarray:
    """Native water pixels, row 0 at the south, for a picture drawn north row first."""
    land = np.array([[c == "#" for c in row] for row in reversed(rows)])
    return ~np.kron(land, np.ones((P, P), dtype=bool)).astype(bool)


def sample(water: np.ndarray):
    sampled = ~water[P // 2 :: P, P // 2 :: P]
    count = (~water).reshape(water.shape[0] // P, P, water.shape[1] // P, P).sum(axis=(1, 3))
    return sampled, count


def grow(water: np.ndarray, **rule):
    sampled, count = sample(water)
    native = coastline.CellAlignedWater(water)
    return sampled, count, coastline.grow_outline(sampled, count, native, **rule)


def labels(mask: np.ndarray, structure) -> np.ndarray:
    """Components with the longitude seam joined."""
    lab, n = ndimage.label(mask, structure=structure)
    parent = list(range(n + 1))

    def find(x):
        while parent[x] != x:
            x = parent[x]
        return x

    seam = [(lab[i, -1], lab[i, 0]) for i in range(mask.shape[0])]
    if structure is EIGHT:
        rows = mask.shape[0]
        seam += [
            (lab[i, -1], lab[k, 0]) for i in range(rows) for k in (i - 1, i + 1) if 0 <= k < rows
        ]
    for a, b in seam:
        if a and b:
            parent[find(a)] = find(b)
    return np.array([find(x) for x in range(n + 1)])[lab]


def joined(outline: np.ndarray, a: tuple[int, int], b: tuple[int, int]) -> bool:
    lab = labels(~outline, FOUR)
    return bool(lab[a] and lab[a] == lab[b])


def native_consistent(water: np.ndarray, outline: np.ndarray, erode: int = 1) -> bool:
    """The guarantee, checked globally and independently of the builder: inside each sea
    component of the outline, one 4-connected component of eroded native water (counting
    only pixels inside the component's cells) reaches every one of its cells."""
    eroded = water
    if erode:
        padded = np.pad(water, ((erode, erode), (0, 0)), mode="edge")
        padded = np.pad(padded, ((0, 0), (erode, erode)), mode="wrap")
        eroded = ndimage.binary_erosion(padded, structure=EIGHT, iterations=erode, border_value=1)
        eroded = eroded[erode:-erode, erode:-erode]
    cells = labels(~outline, FOUR)
    for component in np.unique(cells[cells > 0]):
        inside = np.kron(cells == component, np.ones((P, P), dtype=bool)).astype(bool)
        lab = labels(eroded & inside, FOUR)
        per_cell = lab.reshape(outline.shape[0], P, outline.shape[1], P).transpose(0, 2, 1, 3)
        members = np.argwhere(cells == component)
        shared = None
        for i, j in members:
            here = set(np.unique(per_cell[i, j])) - {0}
            shared = here if shared is None else shared & here
            if not shared:
                return False
    return True


def strait(width: int, column: int = 10, columns: int = 24) -> list[str]:
    """Two seas (south rows 0-3, north rows 12-15) parted by a land band all round the
    globe except a channel `width` cells wide."""
    band = "".join("." if column <= j < column + width else "#" for j in range(columns))
    return ["." * columns] * 4 + [band] * 8 + ["." * columns] * 4


SOUTH, NORTH = (1, 5), (14, 5)


def two_bodies(columns: int = 24) -> np.ndarray:
    """A west and an east sea (columns 2-9 and 12-21, rows 2-13) between land at the top,
    the bottom and columns 0-1 and 22-23; columns 10-11 are open water that a test parts
    with a thin native land line, which centre sampling cannot see."""
    rows = ["#" * columns] * 2 + ["##" + "." * (columns - 4) + "##"] * 12 + ["#" * columns] * 2
    return world(*rows)


WEST, EAST = (7, 5), (7, 18)


def test_one_two_and_three_cell_channels_stay_edge_connected():
    for width in (1, 2, 3):
        *_, outline = grow(world(*strait(width)))
        assert joined(outline, SOUTH, NORTH), width
    # The three-cell channel keeps its buffer: its sides grow, its middle stays sea.
    *_, outline = grow(world(*strait(3)))
    assert outline[5:11, 10].all() and outline[5:11, 12].all()
    assert not outline[4:12, 11].any()


def test_plain_growth_closes_the_narrow_channels_the_rule_keeps():
    for width in (1, 2):
        sampled, _, _ = grow(world(*strait(width)))
        assert not joined(coastline.dilate1(sampled), SOUTH, NORTH)


def test_a_dead_end_inlet_is_filled():
    inlet = "#" * 10 + "." + "#" * 13
    rows = ["#" * 24] * 6 + [inlet] * 6 + ["." * 24] * 4
    sampled, _, outline = grow(world(*rows))
    assert not sampled[4:10, 10].any()
    assert outline[4:10, 10].all()


def test_a_native_land_bridge_across_a_lane_is_filled():
    water = world(*strait(1))
    water[7 * P + 1, 10 * P : 11 * P] = False  # a pixel row of land across the lane cell
    sampled, _, outline = grow(water)
    assert not sampled[7, 10]
    assert outline[7, 10]
    assert not joined(outline, SOUTH, NORTH)


def test_a_lane_opens_only_through_a_native_gap_three_pixels_wide():
    for gap, expected in ((1, False), (2, False), (3, True), (4, True)):
        water = world(*strait(1))
        water[7 * P + 1, 10 * P : 11 * P] = False
        water[7 * P + 1, 10 * P + 1 : 10 * P + 1 + gap] = True
        *_, outline = grow(water)
        assert joined(outline, SOUTH, NORTH) is expected, gap
        assert native_consistent(water, outline)
    # Without the erosion a one-pixel gap is a passage.
    water = world(*strait(1))
    water[7 * P + 1, 10 * P : 11 * P] = False
    water[7 * P + 1, 10 * P + 2] = True
    *_, outline = grow(water, erode=0)
    assert joined(outline, SOUTH, NORTH)


def wall(water: np.ndarray, path: list[tuple[int, int]]) -> None:
    """Draw a one-pixel land line through native pixels (row, column), 8-connected."""
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        n = max(abs(r1 - r0), abs(c1 - c0))
        for t in range(n + 1):
            water[round(r0 + (r1 - r0) * t / n), round(c0 + (c1 - c0) * t / n)] = False


def test_a_spit_running_diagonally_through_two_side_by_side_cells_parts_the_seas():
    water = two_bodies()
    # Up column 60 to row 7's south edge, diagonally through cells (7, 10) and (7, 11),
    # then up column 71 to the top: no cell's centre pixel is on it.
    wall(water, [(12, 61), (42, 61), (47, 66), (48, 71), (84, 71)])
    sampled, _, outline = grow(water)
    assert not sampled[2:14, 10:12].any()
    assert not joined(outline, WEST, EAST)
    assert native_consistent(water, outline)


def test_a_cell_with_a_single_sea_side_is_judged():
    water = two_bodies()
    # Cell (7, 21) is an inlet off the east sea (land north, south and east of it) whose
    # own water is a pond walled off inside it: it touches the sea on one side only.
    water[6 * P : 9 * P, 21 * P : 22 * P] = False
    water[7 * P + 1 : 7 * P + 5, 21 * P + 1 : 21 * P + 5] = True
    sampled, count, outline = grow(water)
    assert not sampled[7, 21]
    _, _, failing = coastline.native_tables(coastline.CellAlignedWater(water), sampled, count)
    assert [7, 20, 7, 21] in failing.T.tolist()
    assert outline[7, 21]
    assert native_consistent(water, outline)


def test_a_cell_joined_to_the_other_sea_only_by_a_corner_of_water_is_filled():
    water = two_bodies()
    # The line runs down column 66 (inside cell column 11) but cuts across the north-west
    # corner of cell (8, 11): that corner's water belongs to the west sea.
    wall(water, [(12, 66), (47, 66), (50, 69), (53, 66), (84, 66)])
    _, _, outline = grow(water)
    assert not joined(outline, WEST, EAST)
    assert native_consistent(water, outline)


def test_a_spit_across_the_longitude_seam_parts_the_seas():
    rows = ["#" * 24] * 2 + ["." * 10 + "####" + "." * 10] * 12 + ["#" * 24] * 2
    water = world(*rows)
    wall(water, [(12, 0), (84, 0)])  # the line on the seam's east side, column 0
    _, _, outline = grow(water)
    assert not joined(outline, (7, 3), (7, 20))
    assert native_consistent(water, outline)
    open_seam = world(*rows)
    *_, outline = grow(open_seam)
    assert joined(outline, (7, 3), (7, 20))


def random_world(seed: int, shape=(30, 40), land=0.42) -> np.ndarray:
    """Random land, with open sea in the two rows at each pole: rows beyond the grid
    count as sea to the growth, as at the real north pole (and the south pole is land)."""
    rng = np.random.default_rng(seed)
    cells = rng.random(shape) < land
    cells[:2] = cells[-2:] = False
    return ~np.kron(cells, np.ones((P, P), dtype=bool)).astype(bool)


def test_on_random_worlds_no_sea_on_sampled_land_no_sea_split_no_land_merged():
    for seed in range(12):
        sampled, count, outline = grow(random_world(seed))
        assert not (sampled & ~outline).any()
        assert not (outline & ~(coastline.dilate1(sampled) | (count > 0))).any()
        # No sea component of the sampled outline is split...
        before, after = labels(~sampled, FOUR), labels(~outline, FOUR)
        for component in np.unique(before[before > 0]):
            pieces = np.unique(after[(before == component) & ~outline])
            assert len(pieces) <= 1, (seed, component)
        # ...and no two of its land masses are joined.
        before, after = labels(sampled, EIGHT), labels(outline, EIGHT)
        for mass in np.unique(after[after > 0]):
            sources = np.unique(before[(after == mass) & sampled])
            assert len(sources) <= 1, (seed, mass)


def test_on_random_worlds_with_sub_cell_land_the_outline_is_native_consistent():
    rng = np.random.default_rng(7)
    for _ in range(8):
        water = random_world(int(rng.integers(1000)))
        water &= ~(rng.random(water.shape) < 0.02)
        sampled, count, outline = grow(water)
        assert not (sampled & ~outline).any()
        assert native_consistent(water, outline)


def test_longitude_wraps():
    # A one-cell channel on the seam (column 0, between land at columns 23 and 1) stays open.
    *_, outline = grow(world(*strait(1, column=0)))
    assert joined(outline, SOUTH, NORTH)
    # Land at column 0 grows into column 23 across the seam.
    rows = ["." * 24] * 16
    rows[8] = "#" + "." * 23
    _, _, outline = grow(world(*rows))
    assert outline[6:9, 23].all() and outline[6:9, 1].all()


def test_the_build_is_deterministic():
    water = random_world(3)
    water &= ~(np.random.default_rng(3).random(water.shape) < 0.02)
    first = coastline.pack(grow(water)[2])
    second = coastline.pack(grow(water)[2])
    assert first == second
    assert first[4:8] == b"\0\0\0\0"  # gzip mtime 0


def test_the_addable_table():
    def code(*neighbours):
        return sum(1 << coastline.RING.index(n) for n in neighbours)

    assert not coastline.ADDABLE[0]  # no land neighbour: a new island
    assert coastline.ADDABLE[255]  # a one-cell sea hole
    assert coastline.ADDABLE[code((-1, -1), (-1, 0), (-1, 1))]  # straight coast
    assert not coastline.ADDABLE[code((-1, 0), (1, 0))]  # a lane between two land masses
    assert not coastline.ADDABLE[code((-1, -1), (-1, 0), (-1, 1), (1, -1), (1, 0), (1, 1))]
    assert coastline.ADDABLE[code((-1, -1))]  # meets one land cell at a corner
    assert not coastline.ADDABLE[code((-1, -1), (1, 1))]  # would join two masses at a pinch
