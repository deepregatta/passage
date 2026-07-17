"""Route-sources registry: the Channel entry must reproduce the previously
hardcoded values exactly (regional expansion step 1 is a pure refactor)."""

import pytest

from deepweather_analysis import route_sources as rs


def test_default_route_is_channel():
    assert rs.DEFAULT_ROUTE_ID == "cherbourg-plymouth-v1"
    assert rs.route_sources() is rs.route_sources("cherbourg-plymouth-v1")


def test_unknown_route_raises_with_known_routes():
    with pytest.raises(KeyError, match="config/route-sources.json"):
        rs.route_sources("nowhere-v1")


def test_live_stations_match_previous_hardcode():
    assert rs.live_stations() == (
        {"station_id": "62103", "name": "Channel Lightship", "lat": 49.9, "lon": -2.9},
        {"station_id": "62050", "name": "E1 buoy (Plymouth approach)", "lat": 50.0, "lon": -4.4},
    )


def test_synthetic_stations_match_previous_hardcode():
    assert [s["station_id"] for s in rs.synthetic_stations()] == [
        "casquets-buoy",
        "mid-channel",
        "plymouth-approach",
    ]
    assert rs.synthetic_observations_source_name() == "synthetic-channel-stations"


def test_tide_ports_match_previous_hardcode():
    ports = rs.tide_ports()
    assert list(ports) == ["cherbourg", "st-helier", "brest", "plymouth"]
    cherbourg = ports["cherbourg"]
    assert (cherbourg["lat"], cherbourg["lon"], cherbourg["z0"]) == (49.65, -1.63, 3.8)
    # constituents arrive as (amplitude, phase) tuples, as tides.py consumes them
    assert cherbourg["constituents"]["M2"] == (1.9, 220)
    assert rs.tide_ports()["st-helier"]["constituents"]["S2"] == (1.3, 235)
    assert rs.tides_artifact_name() == "channel"


def test_currents_bounds_match_previous_hardcode():
    assert rs.currents_bounds() == {
        "min_lat": 49.3,
        "max_lat": 50.6,
        "min_lon": -5.0,
        "max_lon": -1.2,
    }
    # callers may mutate their copy without corrupting the registry
    bounds = rs.currents_bounds()
    bounds["min_lat"] = 0.0
    assert rs.currents_bounds()["min_lat"] == 49.3


def test_fr_broadcast_areas_match_previous_hardcode():
    expected = {
        "Proche Atlantique et Manche Ouest",
        "Manche Est et Sud Mer du Nord",
        "Casquet/Antifer",
        "Baie de Somme/Cap de la Hague",
        "Cap de la Hague/Penmarc'h",
    }
    assert rs.fr_broadcast_areas() == expected
    assert rs.fr_broadcast_areas("cherbourg-plymouth-v1") == expected


def test_feed_modules_expose_registry_backed_constants():
    from deepweather_analysis.grids_prep import CHANNEL_BOUNDS
    from deepweather_analysis.observations import LIVE_STATIONS, STATIONS
    from deepweather_analysis.tides import PORTS

    assert CHANNEL_BOUNDS == rs.currents_bounds()
    assert LIVE_STATIONS == rs.live_stations()
    assert STATIONS == rs.synthetic_stations()
    assert PORTS == rs.tide_ports()
