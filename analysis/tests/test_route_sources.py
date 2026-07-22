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


def test_channel_live_tide_source_stays_cmems():
    assert rs.tides_live_source() == {"kind": "cmems_ssh"}
    assert rs.live_observations_source_name() == "ndbc-realtime2 (Met Office GTS buoys)"


def test_newport_newyork_route_registered():
    route = rs.route_sources("newport-newyork-v1")
    assert route["region"] == "us-northeast"

    assert rs.tides_live_source("newport-newyork-v1") == {"kind": "noaa_coops"}
    ports = rs.tide_ports("newport-newyork-v1")
    assert list(ports) == ["newport", "montauk", "sandy-hook", "the-battery"]
    # every US port needs a CO-OPS station id for the live path
    assert all("coops_station" in port for port in ports.values())
    assert ports["newport"]["coops_station"] == "8452660"
    assert rs.tides_artifact_name("newport-newyork-v1") == "newport-newyork"

    stations = [s["station_id"] for s in rs.live_stations("newport-newyork-v1")]
    assert stations == ["NWPR1", "44097", "44025", "44065"]
    assert "NOAA NDBC" in rs.live_observations_source_name("newport-newyork-v1")

    bounds = rs.currents_bounds("newport-newyork-v1")
    assert bounds["min_lon"] < -74.0 and bounds["max_lat"] > 41.5

    # no FR broadcast areas — and the cross-route union stays purely Channel
    assert rs.fr_broadcast_areas("newport-newyork-v1") == set()
    assert rs.fr_broadcast_areas() == rs.fr_broadcast_areas("cherbourg-plymouth-v1")


def test_us_route_currents_bounds_resolve_to_global_model():
    from deepweather_analysis.environment_fetcher import detect_region

    assert detect_region(rs.currents_bounds("newport-newyork-v1")) == "GLO"
    # the Channel corridor must keep resolving to the finer IBI model
    assert detect_region(rs.currents_bounds("cherbourg-plymouth-v1")) == "IBI"


def test_palma_barcelona_route_registered():
    route = rs.route_sources("palma-barcelona-v1")
    assert route["region"] == "med-west"

    tides = rs.tides_live_source("palma-barcelona-v1")
    assert tides["kind"] == "cmems_ssh"
    # Med sibling of the IBI SSH dataset — recent Med model versions carry explicit tides
    assert tides["dataset"] == "cmems_mod_med_phy-ssh_anfc_4.2km_PT15M-i"
    assert list(rs.tide_ports("palma-barcelona-v1")) == ["palma", "barcelona"]
    assert rs.tides_artifact_name("palma-barcelona-v1") == "palma-barcelona"

    observations = rs.observations_live_source("palma-barcelona-v1")
    assert observations["kind"] == "cmems_insitu_nrt"
    assert observations["base_url"].startswith("https://")
    stations = rs.live_stations("palma-barcelona-v1")
    assert [s["station_id"] for s in stations] == ["6100430", "6100280", "barcelona-coast"]
    # the In Situ TAC file prefix is what the fetcher joins with the date
    assert all("file_prefix" in s for s in stations)

    # NDBC routes default to the ndbc kind without a registry entry
    assert rs.observations_live_source("cherbourg-plymouth-v1") == {"kind": "ndbc"}
    assert rs.observations_live_source("newport-newyork-v1") == {"kind": "ndbc"}


def test_med_route_currents_bounds_resolve_to_ibi():
    """The Palma–Barcelona corridor sits west of 5°E, inside the finer IBI box."""
    from deepweather_analysis.environment_fetcher import detect_region

    assert detect_region(rs.currents_bounds("palma-barcelona-v1")) == "IBI"
    # a corridor east of IBI's 5°E cut (e.g. Corsica) must resolve to MED
    assert (
        detect_region({"min_lat": 41.5, "max_lat": 43.2, "min_lon": 6.0, "max_lon": 9.5}) == "MED"
    )


def test_brisbane_gladstone_route_registered():
    route = rs.route_sources("brisbane-gladstone-v1")
    assert route["region"] == "au-queensland"

    tides = rs.tides_live_source("brisbane-gladstone-v1")
    assert tides["kind"] == "qld_msq"
    assert tides["utc_offset_hours"] == 10  # AEST, Queensland keeps no DST
    ports = rs.tide_ports("brisbane-gladstone-v1")
    assert list(ports) == ["brisbane-bar", "mooloolaba", "burnett-heads", "gladstone"]
    # every QLD port needs its open-data package name for the live path
    assert all("qld_package" in port for port in ports.values())
    assert ports["gladstone"]["qld_package"].startswith("gladstone-auckland-point")
    assert rs.tides_artifact_name("brisbane-gladstone-v1") == "brisbane-gladstone"

    observations = rs.observations_live_source("brisbane-gladstone-v1")
    assert observations["kind"] == "qld_waves"
    assert observations["base_url"].startswith("https://")
    assert "waves and SST only" in rs.live_observations_source_name("brisbane-gladstone-v1")


def test_au_route_currents_bounds_resolve_to_global_model():
    from deepweather_analysis.environment_fetcher import detect_region

    assert detect_region(rs.currents_bounds("brisbane-gladstone-v1")) == "GLO"


def test_pt15m_datasets_are_resolvable_currents():
    """MED anfc publishes currents only as PT15M-i — the resolver must accept it."""
    from deepweather_analysis.environment_fetcher import (
        _format_temporal_resolution,
        _temporal_resolution_from_dataset_id,
    )

    assert (
        _temporal_resolution_from_dataset_id("cmems_mod_med_phy-cur_anfc_4.2km_PT15M-i") == "15-min"
    )
    assert (
        _temporal_resolution_from_dataset_id("cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m")
        == "hourly"
    )
    assert _format_temporal_resolution(0.25, "fallback") == "15-min"


def test_feed_modules_expose_registry_backed_constants():
    from deepweather_analysis.grids_prep import CHANNEL_BOUNDS
    from deepweather_analysis.observations import LIVE_STATIONS, STATIONS
    from deepweather_analysis.tides import PORTS

    assert CHANNEL_BOUNDS == rs.currents_bounds()
    assert LIVE_STATIONS == rs.live_stations()
    assert STATIONS == rs.synthetic_stations()
    assert PORTS == rs.tide_ports()
