"""M11 land-mask tests: artifact shape, Channel sanity points, and non-destructive
latest.json registration."""

import json

import pytest

from deepweather_analysis.land_mask import CHANNEL_BOUNDS, publish_land_mask


@pytest.fixture(scope="module")
def published(tmp_path_factory):
    runs_dir = tmp_path_factory.mktemp("runs")
    # Pre-seed latest.json the way a concurrent publisher would have left it.
    (runs_dir / "latest.json").write_text(
        json.dumps(
            {
                "run_id": "cmems-ibi-test",
                "artifacts": {"current_grid": "runs/x/current_grid.json"},
            }
        )
    )
    path = publish_land_mask(runs_dir=runs_dir)
    return runs_dir, path, json.loads(path.read_text())


def _cell(artifact, lat, lon):
    i = round((lat - artifact["lat0"]) / artifact["dlat"])
    j = round((lon - artifact["lon0"]) / artifact["dlon"])
    assert 0 <= i < artifact["nlat"] and 0 <= j < artifact["nlon"]
    return i, j


def _is_land(artifact, lat, lon):
    i, j = _cell(artifact, lat, lon)
    return artifact["land"][i * artifact["nlon"] + j] == 1


def _is_land_or_near(artifact, lat, lon):
    i, j = _cell(artifact, lat, lon)
    nlat, nlon = artifact["nlat"], artifact["nlon"]
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            ii, jj = i + di, j + dj
            if 0 <= ii < nlat and 0 <= jj < nlon:
                if artifact["land"][ii * nlon + jj] == 1:
                    return True
    return False


def test_artifact_shape(published):
    _, _, artifact = published
    assert artifact["schema_version"] == 1
    assert artifact["kind"] == "land_mask"
    assert artifact["lat0"] == CHANNEL_BOUNDS["min_lat"]
    assert artifact["lon0"] == CHANNEL_BOUNDS["min_lon"]
    assert artifact["dlat"] == artifact["dlon"] == 0.02
    assert artifact["nlat"] == 111  # 49.0..51.2 inclusive at 0.02
    assert artifact["nlon"] == 301  # -6.0..0.0 inclusive at 0.02
    assert len(artifact["land"]) == artifact["nlat"] * artifact["nlon"]
    assert set(artifact["land"]) <= {0, 1}
    # Channel window contains both land and sea
    assert 0 < sum(artifact["land"]) < len(artifact["land"])
    assert artifact["generated_at"]
    assert artifact["source"] == {
        "mode": "live",
        "dataset_id": "global-land-mask GLOBE",
    }


def test_sanity_points(published):
    _, _, artifact = published
    # Cherbourg harbor: land or near-land
    assert _is_land_or_near(artifact, 49.64, -1.62)
    # Mid-Channel: sea
    assert not _is_land(artifact, 49.9, -2.9)
    # Plymouth city: land
    assert _is_land(artifact, 50.38, -4.14)


def test_latest_json_merged_without_dropping_keys(published):
    runs_dir, _, _ = published
    latest = json.loads((runs_dir / "latest.json").read_text())
    assert latest["run_id"] == "cmems-ibi-test"  # preserved
    assert latest["artifacts"]["current_grid"] == "runs/x/current_grid.json"  # preserved
    assert latest["artifacts"]["land_mask"] == "runs/land_mask.json"  # added


def test_latest_json_created_when_missing(tmp_path):
    publish_land_mask(
        bounds={"min_lat": 49.6, "max_lat": 49.7, "min_lon": -1.7, "max_lon": -1.6},
        resolution_deg=0.02,
        runs_dir=tmp_path,
    )
    latest = json.loads((tmp_path / "latest.json").read_text())
    assert latest["artifacts"]["land_mask"] == "runs/land_mask.json"
