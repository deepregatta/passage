"""Live observations: NDBC realtime2 parsing and fetch, on the real 2026-07-17 file."""

import json
from pathlib import Path
from unittest.mock import patch

import jsonschema

from deepweather_analysis import observations as obs
from deepweather_analysis.paths import contracts_dir
from deepweather_analysis.verification.match import match_snapshot

FIXTURE = (Path(__file__).parent / "fixtures" / "ndbc-62103-2026-07-17.txt").read_text()


class TestParseRealtime2:
    def test_parses_real_file_chronological(self):
        records = obs.parse_realtime2(FIXTURE)
        assert len(records) == 25  # 2026-07-16 14:00 .. 2026-07-17 14:00, hourly
        assert records[0]["time"] == "2026-07-16T14:00:00Z"
        assert records[-1]["time"] == "2026-07-17T14:00:00Z"

    def test_units_and_missing(self):
        newest = obs.parse_realtime2(FIXTURE)[-1]
        # 2.1 m/s -> 4.1 kt; WDIR 230; PRES 1018.7; GST/WVHT are 'MM' -> None
        assert newest["wind_kt"] == 4.1
        assert newest["wind_dir_deg"] == 230
        assert newest["pressure_hpa"] == 1018.7
        assert newest["gust_kt"] is None
        assert newest["hs_m"] is None

    def test_ignores_headers_and_garbage(self):
        assert obs.parse_realtime2("#header only\n#units\n") == []
        assert obs.parse_realtime2("not a data line at all\n") == []


class _Resp:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


class TestFetchLive:
    def test_live_doc_schema_and_labelling(self):
        with patch("requests.get", return_value=_Resp(FIXTURE)):
            doc = obs.fetch_live("2026-07-17T00:00:00Z", "2026-07-17T12:00:00Z")
        schema = json.loads((contracts_dir() / "observations.schema.json").read_text())
        jsonschema.validate(instance=doc, schema=schema)
        assert doc["source"]["mode"] == "live"
        assert [s["station_id"] for s in doc["stations"]] == ["62103", "62050"]
        for station in doc["stations"]:
            assert "synthetic" not in station["quality_flags"]

    def test_window_filter_with_matcher_slack(self):
        with patch("requests.get", return_value=_Resp(FIXTURE)):
            doc = obs.fetch_live("2026-07-17T01:00:00Z", "2026-07-17T03:00:00Z")
        times = [r["time"] for r in doc["stations"][0]["records"]]
        # 40-min slack around the window pulls in nothing extra at hourly cadence
        assert times == [
            "2026-07-17T01:00:00Z",
            "2026-07-17T02:00:00Z",
            "2026-07-17T03:00:00Z",
        ]

    def test_future_window_yields_empty_records_not_failure(self):
        with patch("requests.get", return_value=_Resp(FIXTURE)):
            doc = obs.fetch_live("2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z")
        assert all(s["records"] == [] for s in doc["stations"])

    def test_all_fetches_failed_raises(self):
        import requests

        with patch("requests.get", side_effect=requests.ConnectionError("down")):
            try:
                obs.fetch_live("2026-07-17T00:00:00Z", "2026-07-17T12:00:00Z")
            except RuntimeError as exc:
                assert "all NDBC station fetches failed" in str(exc)
            else:
                raise AssertionError("expected RuntimeError")

    def test_dispatcher_degrades_to_badged_synthetic(self):
        import requests

        with patch("requests.get", side_effect=requests.ConnectionError("down")):
            doc = obs.fetch_observations("2026-07-17T00:00:00Z", "2026-07-17T02:00:00Z")
        assert doc["source"]["mode"] == "synthetic"
        assert "live fetch failed" in doc["source"]["name"]


class TestLiveVerification:
    def test_live_pairs_are_not_emulated(self):
        """A leg-hour near the Channel Lightship verifies for real (§9)."""
        findings = {
            "snapshot_id": "s-live",
            "generated_at": "2026-07-16T12:00:00Z",
            "legs": [
                {
                    "leg_id": "mid-channel",
                    "sample_point": {"lat": 49.92, "lon": -2.93},
                    "hours": [{"valid_time": "2026-07-17T06:00:00Z", "wind_kt": 5.0}],
                }
            ],
        }
        with patch("requests.get", return_value=_Resp(FIXTURE)):
            doc = obs.fetch_live("2026-07-17T00:00:00Z", "2026-07-17T12:00:00Z")
        result = match_snapshot(findings, doc)
        assert result["source_mode"] == "live"
        (pair,) = result["pairs"]
        assert pair["coverage_class"] == "verified_near_observation"
        assert pair["observed"] == 5.1  # 2.6 m/s at 06:00 UTC
