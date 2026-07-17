"""Copernicus In Situ TAC NRT parsing, on the real Dragonera buoy daily file
(IR_TS_MO_6100430, 2026-07-16): hourly WSPD/WDIR/ATMS/VHM0, no gust sensor."""

from pathlib import Path

from deepweather_analysis.observations import records_from_insitu_nc

FIXTURE = Path(__file__).parent / "fixtures" / "insitu-dragonera-2026-07-16.nc"


def test_parse_real_dragonera_file():
    records = records_from_insitu_nc(FIXTURE)
    assert len(records) == 24  # hourly daily file
    assert records[0]["time"] == "2026-07-16T00:00:00Z"
    assert records[-1]["time"] == "2026-07-16T23:00:00Z"
    assert [r["time"] for r in records] == sorted(r["time"] for r in records)

    first = records[0]
    # WSPD arrives in m/s and converts to knots
    assert 0.0 <= first["wind_kt"] <= 60.0
    assert 0.0 <= first["wind_dir_deg"] < 360.0
    assert 950.0 <= first["pressure_hpa"] <= 1050.0
    assert 0.0 <= first["hs_m"] <= 10.0
    # Dragonera carries no gust sensor — the field is honestly absent, not faked
    assert "gust_kt" not in first


def test_records_fit_observations_schema():
    from deepweather_analysis.observations import validate_observations

    doc = {
        "schema_version": 1,
        "generated_at": "2026-07-17T00:00:00Z",
        "source": {"mode": "live", "name": "cmems-insitu-nrt"},
        "stations": [
            {
                "station_id": "6100430",
                "name": "Dragonera buoy",
                "lat": 39.56,
                "lon": 2.09,
                "quality_flags": ["insitu-nrt"],
                "records": records_from_insitu_nc(FIXTURE),
            }
        ],
    }
    validate_observations(doc)
