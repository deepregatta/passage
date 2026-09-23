"""Consumer contract for Passage's browser GRIB2 export (docs/grib-export.md).

The engine writes the golden files in engine/test/fixtures/grib/ and a
byte-match test pins them there. This side decodes every committed file with
ecCodes, the reference GRIB library behind most sailing apps' readers, and
checks identification keys, grid geometry and values against the
independently derived `<name>.expected.json`.
"""

from __future__ import annotations

import json
from pathlib import Path

import eccodes
import numpy as np
import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "engine/test/fixtures/grib"
NAMES = sorted(p.name.removesuffix(".grb2") for p in FIXTURES.glob("*.grb2"))

# Degrees are micro-degree integers in the file; ecCodes divides by 1e6.
DEGREE_KEYS = {
    "latitudeOfFirstGridPointInDegrees",
    "longitudeOfFirstGridPointInDegrees",
    "latitudeOfLastGridPointInDegrees",
    "longitudeOfLastGridPointInDegrees",
    "iDirectionIncrementInDegrees",
    "jDirectionIncrementInDegrees",
}


def _decode(path: Path) -> list[dict]:
    messages = []
    with path.open("rb") as handle:
        while True:
            gid = eccodes.codes_grib_new_from_file(handle)
            if gid is None:
                break
            try:
                values = eccodes.codes_get_values(gid)
                bitmap = (
                    eccodes.codes_get_array(gid, "bitmap", int)
                    if eccodes.codes_get(gid, "bitmapPresent")
                    else np.ones(len(values), dtype=int)
                )
                messages.append(
                    {
                        "values": values,
                        "bitmap": bitmap,
                        "lats": eccodes.codes_get_array(gid, "latitudes"),
                        "lons": eccodes.codes_get_array(gid, "longitudes"),
                    }
                )
            finally:
                eccodes.codes_release(gid)
    return messages


def _key(gid, key: str, expected):
    """Read a key typed like its expectation."""
    if isinstance(expected, str):
        return eccodes.codes_get(gid, key, str)
    if key in DEGREE_KEYS:
        return eccodes.codes_get(gid, key, float)
    return eccodes.codes_get(gid, key, int)


def _lon_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


@pytest.fixture(scope="module", params=NAMES)
def fixture(request):
    name = request.param
    expected = json.loads((FIXTURES / f"{name}.expected.json").read_text())
    return name, expected


def test_fixture_set_is_complete():
    assert NAMES == ["currents-glo12", "waves-greenwich", "wind-gfs-golden", "wind-south"]
    for name in NAMES:
        assert (FIXTURES / f"{name}.expected.json").is_file()


def test_decodes_every_message_with_the_expected_keys(fixture):
    name, expected = fixture
    path = FIXTURES / expected["file"]
    assert path.stat().st_size == expected["bytes"]
    with path.open("rb") as handle:
        count = 0
        while True:
            gid = eccodes.codes_grib_new_from_file(handle)
            if gid is None:
                break
            try:
                assert count < len(expected["messages"]), f"{name}: more messages than expected"
                want = expected["messages"][count]
                assert eccodes.codes_get(gid, "edition") == 2
                for key, value in want["keys"].items():
                    got = _key(gid, key, value)
                    if key in DEGREE_KEYS:
                        assert got == pytest.approx(value, abs=1e-6), f"{name} #{count} {key}"
                    else:
                        assert got == value, f"{name} #{count} {key}: {got!r} != {value!r}"
            finally:
                eccodes.codes_release(gid)
            count += 1
    assert count == len(expected["messages"])


def test_values_land_on_the_expected_points(fixture):
    name, expected = fixture
    decoded = _decode(FIXTURES / expected["file"])
    assert len(decoded) == len(expected["messages"])
    for index, (message, want) in enumerate(zip(decoded, expected["messages"], strict=True)):
        lats, lons, values, bitmap = (
            message["lats"],
            message["lons"],
            message["values"],
            message["bitmap"],
        )
        assert int(bitmap.sum()) == len(values) - want["keys"]["numberOfMissing"]
        for point in want["points"]:
            # Locate the point through ecCodes' own geometry (row order, 0-360 wrap).
            distance = np.abs(lats - point["lat"]) + np.array(
                [_lon_diff(lon, point["lon"]) for lon in lons]
            )
            k = int(np.argmin(distance))
            label = f"{name} #{index} {want['variable']} {want['time']} ({point['lat']}, {point['lon']})"
            assert distance[k] < 1e-3, f"{label}: no grid point within 0.001°"
            if point["written"] is None:
                assert bitmap[k] == 0, f"{label}: expected missing"
                continue
            assert bitmap[k] == 1, f"{label}: unexpectedly missing"
            assert values[k] == pytest.approx(point["written"], abs=1e-6), label
            assert abs(values[k] - point["source"]) <= point["tolerance"] + 1e-9, label


def test_grid_geometry_matches_the_lattice(fixture):
    name, expected = fixture
    decoded = _decode(FIXTURES / expected["file"])
    for message, want in zip(decoded, expected["messages"], strict=True):
        keys = want["keys"]
        lats, lons = message["lats"], message["lons"]
        ni, nj = keys["Ni"], keys["Nj"]
        assert len(lats) == ni * nj
        # Scanning mode 0: first point is the NW corner, rows run north to south.
        assert lats[0] == pytest.approx(keys["latitudeOfFirstGridPointInDegrees"], abs=1e-6)
        assert lats[-1] == pytest.approx(keys["latitudeOfLastGridPointInDegrees"], abs=1e-6)
        assert np.all(np.diff(lats.reshape(nj, ni)[:, 0]) < 0), name
        step = keys["iDirectionIncrementInDegrees"]
        row = lons.reshape(nj, ni)[0]
        steps = [(b - a) % 360.0 for a, b in zip(row[:-1], row[1:], strict=True)]
        assert steps == pytest.approx([step] * (ni - 1), abs=1e-6), name
