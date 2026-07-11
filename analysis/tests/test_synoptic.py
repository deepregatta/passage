"""M8 tests: synoptic detection, tracking, and named-regime rules.

Pure functions only — synthetic MSLP/wind fields, no network, no files.
"""

from __future__ import annotations

import numpy as np
import pytest

from deepweather_analysis.synoptic.detect import detect_systems
from deepweather_analysis.synoptic.regimes import detect_mistral
from deepweather_analysis.synoptic.track import track_systems

# =============================================================================
# Field builders
# =============================================================================

LATS = np.arange(35.0, 65.01, 0.5)
LONS = np.arange(-35.0, 10.01, 0.5)


def gaussian_field(
    base_hpa: float,
    centers: list[tuple[float, float, float, float]],
    lats: np.ndarray = LATS,
    lons: np.ndarray = LONS,
) -> np.ndarray:
    """base + sum of gaussians; centers = (lat, lon, amplitude_hpa, sigma_deg)."""
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    field = np.full(lat_grid.shape, base_hpa, dtype=float)
    for clat, clon, amp, sigma in centers:
        r2 = (lat_grid - clat) ** 2 + ((lon_grid - clon) * np.cos(np.radians(clat))) ** 2
        field += amp * np.exp(-r2 / (2.0 * sigma**2))
    return field


# =============================================================================
# detect_systems
# =============================================================================


class TestDetectSystems:
    def test_single_gaussian_low_detected(self):
        field = gaussian_field(1015.0, [(50.0, -15.0, -30.0, 3.0)])
        systems = detect_systems(field, LATS, LONS)
        lows = [s for s in systems if s["kind"] == "low"]
        assert len(lows) == 1
        low = lows[0]
        assert abs(low["lat"] - 50.0) <= 0.5
        assert abs(low["lon"] - (-15.0)) <= 0.5
        assert abs(low["center_hpa"] - 985.0) <= 1.0
        assert low["closed_contour"] is True

    def test_no_spurious_highs_around_a_low(self):
        field = gaussian_field(1015.0, [(50.0, -15.0, -30.0, 3.0)])
        systems = detect_systems(field, LATS, LONS)
        assert [s["kind"] for s in systems] == ["low"]

    def test_flat_field_yields_nothing(self):
        field = np.full((LATS.size, LONS.size), 1015.0)
        assert detect_systems(field, LATS, LONS) == []

    def test_shallow_dimple_rejected(self):
        # 2 hPa dimple < 3 hPa prominence floor.
        field = gaussian_field(1015.0, [(50.0, -15.0, -2.0, 3.0)])
        assert detect_systems(field, LATS, LONS) == []

    def test_edge_low_rejected(self):
        # Depression centred on the domain edge: the minimum sits in the
        # edge-guard band and interior cells are not local minima.
        field = gaussian_field(1015.0, [(35.0, -15.0, -30.0, 3.0)])
        assert detect_systems(field, LATS, LONS) == []

    def test_high_detected_with_kind(self):
        field = gaussian_field(1012.0, [(50.0, -15.0, +18.0, 4.0)])
        systems = detect_systems(field, LATS, LONS)
        highs = [s for s in systems if s["kind"] == "high"]
        assert len(highs) == 1
        assert highs[0]["center_hpa"] == pytest.approx(1030.0, abs=1.0)

    def test_two_separated_lows_both_found(self):
        field = gaussian_field(
            1015.0, [(55.0, -25.0, -25.0, 3.0), (42.0, -5.0, -15.0, 3.0)]
        )
        lows = [s for s in detect_systems(field, LATS, LONS) if s["kind"] == "low"]
        assert len(lows) == 2


# =============================================================================
# track_systems
# =============================================================================


def _low(lat: float, lon: float, hpa: float) -> dict:
    return {"kind": "low", "lat": lat, "lon": lon, "center_hpa": hpa, "closed_contour": True}


class TestTrackSystems:
    def test_moving_low_tracked_with_motion_and_deepening(self):
        step0 = [_low(50.0, -10.0, 990.0)]
        step1 = [_low(50.0, -8.5, 987.0)]  # 1.5 deg east, 3 hPa deeper
        systems = track_systems([step0, step1], [0, 3])
        assert len(systems) == 1
        low = systems[0]
        assert low["system_id"] == "L1"
        assert len(low["track"]) == 2
        assert low["track"][1]["step_h"] == 3
        # Due-east motion at 1.5 deg lon / 3 h at 50N ~ 19 kt.
        assert low["motion"]["dir_deg"] == pytest.approx(90.0, abs=2.0)
        assert low["motion"]["speed_kt"] == pytest.approx(19.3, abs=1.0)
        # -3 hPa over 3 h -> -24 hPa/24h (negative = deepening).
        assert low["deepening_hpa_per_24h"] == pytest.approx(-24.0, abs=0.5)

    def test_distant_new_low_gets_its_own_id(self):
        # Low A crawls east; low B appears far away at step 1 and persists.
        steps = [
            [_low(50.0, -10.0, 990.0)],
            [_low(50.0, -9.5, 989.0), _low(40.0, 5.0, 1000.0)],
            [_low(50.0, -9.0, 988.0), _low(40.0, 5.5, 999.0)],
        ]
        systems = track_systems(steps, [0, 3, 6])
        assert len(systems) == 2
        by_id = {s["system_id"]: s for s in systems}
        # Deepest low is L1; B never merges into A's track.
        assert len(by_id["L1"]["track"]) == 3
        assert len(by_id["L2"]["track"]) == 2
        assert by_id["L2"]["track"][0]["step_h"] == 3
        assert all(p["lat"] < 45 for p in by_id["L2"]["track"])

    def test_single_step_appearance_dropped(self):
        steps = [
            [_low(50.0, -10.0, 990.0)],
            [_low(50.0, -9.5, 989.0), _low(40.0, 5.0, 1000.0)],
        ]
        systems = track_systems(steps, [0, 3])
        assert [s["system_id"] for s in systems] == ["L1"]

    def test_displacement_gate_blocks_teleporting(self):
        # 10 deg jump in 3 h exceeds the 6 deg gate: two fragments, both
        # single-step -> nothing survives.
        steps = [[_low(50.0, -10.0, 990.0)], [_low(50.0, 0.0, 990.0)]]
        assert track_systems(steps, [0, 3]) == []

    def test_kind_never_mixes(self):
        high = {"kind": "high", "lat": 50.0, "lon": -10.5, "center_hpa": 1030.0, "closed_contour": True}
        steps = [[_low(50.0, -10.0, 990.0)], [high]]
        assert track_systems(steps, [0, 3]) == []


# =============================================================================
# detect_mistral
# =============================================================================

RLATS = np.arange(38.0, 50.01, 0.25)
RLONS = np.arange(-12.0, 12.01, 0.25)


def mistral_pattern(wind_ms: float = 8.0):
    """Biscay high + Genoa low + uniform NW wind of the given component size."""
    mslp = gaussian_field(
        1016.0,
        [(45.0, -5.0, +16.0, 5.0), (43.5, 9.0, -14.0, 3.0)],
        RLATS,
        RLONS,
    )
    shape = (RLATS.size, RLONS.size)
    u10 = np.full(shape, +wind_ms)   # eastward
    v10 = np.full(shape, -wind_ms)   # southward -> wind FROM 315 (NW)
    return mslp, u10, v10


class TestDetectMistral:
    def test_pattern_detected_as_mistral(self):
        mslp, u10, v10 = mistral_pattern(wind_ms=8.0)  # ~22 kt
        result = detect_mistral(mslp, u10, v10, RLATS, RLONS)
        assert result is not None
        assert result["regime_id"] == "mistral"
        assert result["rule_id"] == "R-MISTRAL-01"
        evidence = result["pattern_evidence"]
        assert evidence["biscay_mean_mslp_hpa"] >= 1020.0
        assert evidence["genoa_mean_mslp_hpa"] <= 1012.0
        assert evidence["lion_mean_wind_kt"] >= 18.0
        assert evidence["lion_mean_dir_from_deg"] == pytest.approx(315.0, abs=5.0)

    def test_weak_wind_returns_none(self):
        mslp, u10, v10 = mistral_pattern(wind_ms=4.0)  # ~11 kt < 18 kt
        assert detect_mistral(mslp, u10, v10, RLATS, RLONS) is None

    def test_missing_biscay_high_returns_none(self):
        mslp = gaussian_field(1016.0, [(43.5, 9.0, -14.0, 3.0)], RLATS, RLONS)
        _, u10, v10 = mistral_pattern(wind_ms=8.0)
        assert detect_mistral(mslp, u10, v10, RLATS, RLONS) is None

    def test_wrong_direction_returns_none(self):
        mslp, _, _ = mistral_pattern()
        shape = (RLATS.size, RLONS.size)
        u10 = np.full(shape, -8.0)  # wind FROM the east/southeast
        v10 = np.full(shape, +8.0)
        assert detect_mistral(mslp, u10, v10, RLATS, RLONS) is None

    def test_stronger_west_component_in_corridor_labels_tramontane(self):
        mslp, u10, v10 = mistral_pattern(wind_ms=8.0)
        # Boost the westerly component in the Tramontane corridor
        # (42.5-43.5N, 2.5-4E) and nudge the mean direction into 290-340.
        ii = np.nonzero((RLATS >= 42.5) & (RLATS <= 43.5))[0]
        jj = np.nonzero((RLONS >= 2.5) & (RLONS <= 4.0))[0]
        u10[np.ix_(ii, jj)] += 6.0
        result = detect_mistral(mslp, u10, v10, RLATS, RLONS)
        assert result is not None
        assert result["regime_id"] == "tramontane"

    def test_grid_not_covering_boxes_returns_none(self):
        # Channel-only grid: Mediterranean boxes absent -> no rule firing.
        lats = np.arange(49.0, 51.01, 0.25)
        lons = np.arange(-6.0, 0.01, 0.25)
        shape = (lats.size, lons.size)
        mslp = np.full(shape, 1025.0)
        u10 = np.full(shape, 8.0)
        v10 = np.full(shape, -8.0)
        assert detect_mistral(mslp, u10, v10, lats, lons) is None
