"""M13 tests: observations generator, snapshot/observation matcher, and
calibration accumulator. No network; writes only under tmp_path.
"""

from __future__ import annotations

import json
import jsonschema
import pytest

from deepweather_analysis.observations import (
    STATIONS,
    generate_observations,
    window_label,
)
from deepweather_analysis.paths import contracts_dir
from deepweather_analysis.verification.calibration import (
    LEAD_BANDS,
    accumulate_calibration,
)
from deepweather_analysis.verification.match import haversine_km, match_snapshot

WINDOW_START = "2026-07-12T06:00:00Z"
WINDOW_END = "2026-07-12T09:00:00Z"


# =============================================================================
# Fixture builders
# =============================================================================


def findings_doc(legs) -> dict:
    return {
        "schema_version": 1,
        "snapshot_id": "20260712T060000Z_test_snapshot",
        "generated_at": "2026-07-12T00:00:00Z",
        "departure_utc": "2026-07-12T06:00:00Z",
        "legs": legs,
    }


def leg(leg_id: str, lat: float, lon: float, hours) -> dict:
    return {"leg_id": leg_id, "sample_point": {"lat": lat, "lon": lon}, "hours": hours}


def hour(valid_time: str, wind_kt: float) -> dict:
    return {"valid_time": valid_time, "wind_kt": wind_kt}


def obs_doc(mode: str, stations) -> dict:
    return {
        "schema_version": 1,
        "generated_at": "2026-07-13T00:00:00Z",
        "source": {"mode": mode, "name": "test-obs"},
        "stations": stations,
    }


def station(station_id: str, lat: float, lon: float, records) -> dict:
    return {"station_id": station_id, "lat": lat, "lon": lon, "records": records}


# Casquets synthetic station location, used as the anchor everywhere.
CASQ = {"lat": 49.72, "lon": -2.34}


# =============================================================================
# observations.py
# =============================================================================


class TestObservations:
    def test_schema_valid(self):
        doc = generate_observations(WINDOW_START, WINDOW_END)
        schema = json.loads((contracts_dir() / "observations.schema.json").read_text())
        jsonschema.validate(instance=doc, schema=schema)  # explicit, not just internal

    def test_synthetic_labelling(self):
        doc = generate_observations(WINDOW_START, WINDOW_END)
        assert doc["source"]["mode"] == "synthetic"
        assert all("synthetic" in s["quality_flags"] for s in doc["stations"])

    def test_deterministic(self):
        a = generate_observations(WINDOW_START, WINDOW_END, generated_at="2026-01-01T00:00:00Z")
        b = generate_observations(WINDOW_START, WINDOW_END, generated_at="2026-01-01T00:00:00Z")
        assert a == b

    def test_station_set_and_cadence(self):
        doc = generate_observations(WINDOW_START, WINDOW_END)
        assert [s["station_id"] for s in doc["stations"]] == [
            s["station_id"] for s in STATIONS
        ]
        records = doc["stations"][0]["records"]
        # 3 h window at 10-min cadence, both ends inclusive.
        assert len(records) == 19
        assert records[0]["time"] == WINDOW_START
        assert records[-1]["time"] == WINDOW_END

    def test_base_series_followed_with_bounded_noise(self):
        base = {
            s["station_id"]: {"wind_kt": [20.0, 20.0, 20.0, 20.0]} for s in STATIONS
        }
        doc = generate_observations(WINDOW_START, WINDOW_END, base_series=base)
        for st in doc["stations"]:
            for record in st["records"]:
                assert abs(record["wind_kt"] - 20.0) <= 2.0  # noise + bias stays small

    def test_window_label(self):
        assert window_label(WINDOW_START, WINDOW_END) == "20260712T0600Z-20260712T0900Z"


# =============================================================================
# match.py
# =============================================================================


class TestMatchSnapshot:
    def test_near_pair_classed_verified_when_live(self):
        findings = findings_doc(
            [leg("L1", CASQ["lat"] + 0.01, CASQ["lon"], [hour("2026-07-12T06:00:00Z", 18.0)])]
        )
        obs = obs_doc(
            "live",
            [
                station(
                    "casquets-buoy",
                    CASQ["lat"],
                    CASQ["lon"],
                    [{"time": "2026-07-12T06:10:00Z", "wind_kt": 16.0}],
                )
            ],
        )
        result = match_snapshot(findings, obs)
        assert len(result["pairs"]) == 1
        pair = result["pairs"][0]
        assert pair["coverage_class"] == "verified_near_observation"
        assert pair["distance_km"] < 10.0
        assert pair["time_offset_min"] == 10.0
        assert pair["error"] == pytest.approx(2.0)
        assert pair["lead_h"] == pytest.approx(6.0)
        assert result["coverage_summary"] == {"verified_near_observation": 1}

    def test_far_pair_classed_partially_observed(self):
        # ~0.15 deg lat away: > 10 km but < 25 km.
        findings = findings_doc(
            [leg("L1", CASQ["lat"] + 0.15, CASQ["lon"], [hour("2026-07-12T06:00:00Z", 18.0)])]
        )
        obs = obs_doc(
            "live",
            [
                station(
                    "casquets-buoy",
                    CASQ["lat"],
                    CASQ["lon"],
                    [{"time": "2026-07-12T06:00:00Z", "wind_kt": 16.0}],
                )
            ],
        )
        result = match_snapshot(findings, obs)
        assert result["pairs"][0]["coverage_class"] == "partially_observed"

    def test_synthetic_obs_forced_emulated(self):
        """§9: fake observations can never claim real verification."""
        findings = findings_doc(
            [leg("L1", CASQ["lat"], CASQ["lon"], [hour("2026-07-12T06:00:00Z", 18.0)])]
        )
        obs = obs_doc(
            "synthetic",
            [
                station(
                    "casquets-buoy",
                    CASQ["lat"],
                    CASQ["lon"],
                    [{"time": "2026-07-12T06:00:00Z", "wind_kt": 16.0}],
                )
            ],
        )
        result = match_snapshot(findings, obs)
        # Distance 0, offset 0 — would be verified_near_observation, but synthetic.
        assert result["pairs"][0]["coverage_class"] == "emulated"
        assert result["source_mode"] == "synthetic"

    def test_leg_without_coverage_listed(self):
        findings = findings_doc(
            [
                leg("L1", CASQ["lat"], CASQ["lon"], [hour("2026-07-12T06:00:00Z", 18.0)]),
                leg("L9", 45.0, -10.0, [hour("2026-07-12T06:00:00Z", 22.0)]),  # nowhere near
            ]
        )
        obs = obs_doc(
            "live",
            [
                station(
                    "casquets-buoy",
                    CASQ["lat"],
                    CASQ["lon"],
                    [{"time": "2026-07-12T06:00:00Z", "wind_kt": 16.0}],
                )
            ],
        )
        result = match_snapshot(findings, obs)
        assert result["not_independently_observed"] == ["L9"]
        assert result["coverage_summary"]["not_independently_observed"] == 1

    def test_record_outside_time_window_not_paired(self):
        findings = findings_doc(
            [leg("L1", CASQ["lat"], CASQ["lon"], [hour("2026-07-12T06:00:00Z", 18.0)])]
        )
        obs = obs_doc(
            "live",
            [
                station(
                    "casquets-buoy",
                    CASQ["lat"],
                    CASQ["lon"],
                    [{"time": "2026-07-12T07:30:00Z", "wind_kt": 16.0}],  # 90 min off
                )
            ],
        )
        result = match_snapshot(findings, obs)
        assert result["pairs"] == []
        assert result["not_independently_observed"] == ["L1"]

    def test_haversine_sanity(self):
        assert haversine_km(50.0, -3.0, 50.0, -3.0) == 0.0
        # One degree of latitude ~ 111 km.
        assert haversine_km(50.0, -3.0, 51.0, -3.0) == pytest.approx(111.2, abs=0.5)


# =============================================================================
# calibration.py
# =============================================================================


def verification_doc(pairs) -> dict:
    return {"snapshot_id": "s", "observation_source": "era5", "pairs": pairs}


def cal_pair(lead_h: float, error: float, coverage_class: str = "reanalysis_referenced") -> dict:
    return {
        "variable": "wind_kt",
        "lead_h": lead_h,
        "error": error,
        "coverage_class": coverage_class,
    }


class TestCalibration:
    def test_lead_bands_and_hand_checked_stats(self, tmp_path):
        docs = [
            verification_doc([cal_pair(6.0, 1.0), cal_pair(7.0, 3.0)]),
            verification_doc([cal_pair(18.0, -2.0)]),
        ]
        out = accumulate_calibration(docs, path=tmp_path / "calibration.json")
        by_band = {tuple(r["lead_band_h"]): r for r in out["records"]}
        assert set(by_band) == {(0, 12), (12, 24)}

        early = by_band[(0, 12)]
        assert early["n_pairs"] == 2
        assert early["bias"] == pytest.approx(2.0)  # mean(1, 3)
        assert early["spread"] == pytest.approx(1.0)  # population std of (1, 3)
        assert early["coverage_classes"] == {"reanalysis_referenced": 2}
        assert early["area"] == "channel"

        late = by_band[(12, 24)]
        assert late["n_pairs"] == 1
        assert late["bias"] == pytest.approx(-2.0)
        assert late["spread"] == pytest.approx(0.0)

    def test_merge_with_existing_file_is_exact(self, tmp_path):
        path = tmp_path / "calibration.json"
        accumulate_calibration([verification_doc([cal_pair(6.0, 1.0)])], path=path)
        out = accumulate_calibration([verification_doc([cal_pair(6.0, 3.0)])], path=path)
        record = next(r for r in out["records"] if r["lead_band_h"] == [0, 12])
        assert record["n_pairs"] == 2
        assert record["bias"] == pytest.approx(2.0)
        assert record["spread"] == pytest.approx(1.0)  # same as one-shot accumulation
        assert record["coverage_classes"] == {"reanalysis_referenced": 2}

    def test_schema_valid_and_persisted(self, tmp_path):
        path = tmp_path / "calibration.json"
        accumulate_calibration([verification_doc([cal_pair(6.0, 1.0)])], path=path)
        doc = json.loads(path.read_text())
        schema = json.loads((contracts_dir() / "calibration.schema.json").read_text())
        jsonschema.validate(instance=doc, schema=schema)
        assert doc["records"][0]["n_pairs"] == 1  # §9: sample size always present

    def test_out_of_band_pairs_skipped_not_counted(self, tmp_path):
        out = accumulate_calibration(
            [verification_doc([cal_pair(6.0, 1.0), cal_pair(60.0, 5.0), cal_pair(-1.0, 5.0)])],
            path=tmp_path / "calibration.json",
        )
        assert sum(r["n_pairs"] for r in out["records"]) == 1
        assert out["skipped_pairs"] == 2

    def test_band_edges(self):
        # [lo, hi): 12 belongs to the second band, 48 to none.
        assert LEAD_BANDS == ((0, 12), (12, 24), (24, 48))

    def test_coverage_class_counts_accumulate(self, tmp_path):
        out = accumulate_calibration(
            [
                verification_doc(
                    [
                        cal_pair(6.0, 1.0, "verified_near_observation"),
                        cal_pair(6.0, 2.0, "partially_observed"),
                        cal_pair(6.0, 3.0, "emulated"),
                    ]
                )
            ],
            path=tmp_path / "calibration.json",
        )
        record = next(r for r in out["records"] if r["lead_band_h"] == [0, 12])
        assert record["coverage_classes"] == {
            "verified_near_observation": 1,
            "partially_observed": 1,
        }
        assert record["n_pairs"] == 2

    def test_emulated_documents_are_excluded_from_skill_claims(self, tmp_path):
        doc = {"snapshot_id": "demo", "observation_source": "emulated", "pairs": [cal_pair(6.0, 99.0)]}
        out = accumulate_calibration([doc], path=tmp_path / "calibration.json")
        assert out["records"] == []
        assert out["skipped_pairs"] == 1
