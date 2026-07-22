"""QLD Coastal Data System wave-buoy parsing, on the real 2026-07-17
Mooloolaba datastore response (30-min cadence; Seconds is UTC epoch while
DateTime is local AEST — the parser must use Seconds)."""

import json
from pathlib import Path

from deepweather_analysis.observations import records_from_qld_waves

RESPONSE = json.loads(
    (Path(__file__).parent / "fixtures" / "qld-waves-mooloolaba-2026-07-17.json").read_text()
)
ROWS = RESPONSE["result"]["records"]


def test_parse_real_rows_uses_utc_epoch():
    records = records_from_qld_waves(ROWS)
    assert len(records) == len(ROWS)
    # Seconds 1783692000 == 2026-07-10T14:00:00Z (DateTime says 2026-07-11T00:00 local)
    assert records[0]["time"] == "2026-07-10T14:00:00Z"
    assert records[0]["hs_m"] == 1.17
    # waves only: no wind fields ever appear
    assert all(set(r) == {"time", "hs_m"} for r in records)
    times = [r["time"] for r in records]
    assert times == sorted(times)


def test_missing_sentinel_drops_record():
    rows = json.loads(json.dumps(ROWS))
    rows[0]["Hsig"] = "-99.90"
    rows[1]["Hsig"] = "not-a-number"
    records = records_from_qld_waves(rows)
    assert len(records) == len(ROWS) - 2


def test_registry_station_sites_are_consistent():
    from deepweather_analysis import route_sources as rs

    source = rs.observations_live_source("brisbane-gladstone-v1")
    assert source["kind"] == "qld_waves"
    assert source["resource_id"]
    stations = rs.live_stations("brisbane-gladstone-v1")
    assert [s["station_id"] for s in stations] == [
        "north-moreton-bay",
        "mooloolaba",
        "wide-bay",
        "bundaberg",
        "gladstone",
    ]
    # the Site column value is what the datastore filter joins on
    assert all("site" in s for s in stations)
