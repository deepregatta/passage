"""Tide artifacts are discoverable by exact route, never a Channel fallback."""

import json

from deepweather_analysis import route_sources, tides
from deepweather_analysis.providers import Mode


def test_publisher_indexes_only_existing_registered_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(tides, "processed_dir", lambda _: tmp_path)
    monkeypatch.setattr(tides, "provider_mode", lambda _: Mode.SYNTHETIC)
    published = {}
    for route_id, entry in route_sources.load_route_sources()["routes"].items():
        output = tides.prepare_tides("2026-07-20T06:00:00Z", hours=24, route_id=route_id)
        assert output.name == entry["tides"]["artifact_name"] + ".json"
        published[route_id] = output.name
        index = json.loads((tmp_path / "index.json").read_text())
        assert index == {"schema_version": 1, "routes": published}
        doc = json.loads(output.read_text())
        assert {p["port_id"] for p in doc["ports"]} == set(entry["tides"]["ports"])
        assert doc["source"]["mode"] == "synthetic"

    # Rebuilds drop artifacts removed from the warehouse, ignore stray JSON.
    (tmp_path / "channel.json").unlink()
    (tmp_path / "unregistered.json").write_text("{}")
    tides.prepare_tides("2026-07-20T06:00:00Z", hours=24, route_id="newport-newyork-v1")
    published.pop("cherbourg-plymouth-v1")
    assert json.loads((tmp_path / "index.json").read_text())["routes"] == published


def test_default_route_is_published_under_its_registry_id(tmp_path, monkeypatch):
    monkeypatch.setattr(tides, "processed_dir", lambda _: tmp_path)
    monkeypatch.setattr(tides, "provider_mode", lambda _: Mode.SYNTHETIC)
    tides.prepare_tides("2026-07-20T06:00:00Z", hours=24)
    assert json.loads((tmp_path / "index.json").read_text())["routes"] == {
        route_sources.DEFAULT_ROUTE_ID: "channel.json"
    }
