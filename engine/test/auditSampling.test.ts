/**
 * The audit's sample points and hours (auditSampling.ts), the missing-neighbour
 * rule of a point read (interpolateAtPoint), and what reads the expected timing
 * (passage-audit-4). The end-to-end defects are in auditReading.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_SAMPLE_SPACING_NM, auditSamplePoints, expectedPointIndex, legHourCandidates, pointHours, pointWindowMs, stretchCount,
} from '../src/auditSampling.js';
import { interpolateAtPoint, roundToward } from '../src/forecast/tileStore.js';
import { computeRouteSchedules, parseUtc } from '../src/eta.js';
import { haversineNm } from '../src/geo.js';
import { deriveLegs } from '../src/route.js';
import { runAnalysis } from '../src/analyze.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { expectedTimingHour, nominalPassageHours, routeSummary } from '../src/routeSummary.js';
import { passageLimitHours } from '../src/window.js';
import { buildFixtureRun } from './helpers/fixtureRun.js';
import { assembleFindings } from '../src/findings.js';
import type { Findings, LimitsProfile, Route } from '../src/types.js';

const NM_PER_DEG_LON_49 = 60 * Math.cos((49 * Math.PI) / 180);

function route(points: Array<[number, number]>, extra: Partial<Route> = {}): Route {
  return {
    schema_version: 1, route_id: 'r', name: 'r', mode: 'user', timing: { basis: 'through_water' },
    speeds_kt: { slow: 4.5, nominal: 5.5, fast: 6.5 },
    waypoints: points.map(([lat, lon], k) => ({ id: `w${k}`, lat, lon })),
    ...extra,
  } as Route;
}

describe('audit sample points', () => {
  it('cuts each leg into stretches of at most 10 nm and reads the middle of each', () => {
    expect(AUDIT_SAMPLE_SPACING_NM).toBe(10);
    expect([0, 0.4, 9.99, 10, 10.01, 20, 20.01, 57, 321].map(stretchCount)).toEqual([1, 1, 1, 1, 2, 2, 3, 6, 33]);
    const r = route([[49, -7], [49, -7 + 3 / NM_PER_DEG_LON_49], [49 + 47 / 60, -7 + 3 / NM_PER_DEG_LON_49]]);
    const legs = deriveLegs(r);
    const points = auditSamplePoints(legs);
    // a 3 nm leg keeps its midpoint; a 47 nm leg gets five stretches
    expect(points.map((p) => p.point_id)).toEqual(['L1.1', 'L2.1', 'L2.2', 'L2.3', 'L2.4', 'L2.5']);
    expect(points[0]).toMatchObject({ leg_index: 0, from_fraction: 0, to_fraction: 1 });
    const mid = { lat: (legs[0]!.from.lat + legs[0]!.to.lat) / 2, lon: (legs[0]!.from.lon + legs[0]!.to.lon) / 2 };
    expect(points[0]!.lat).toBeCloseTo(mid.lat, 4);
    expect(points[0]!.lon).toBeCloseTo(mid.lon, 4);
    const leg2 = points.filter((p) => p.leg_id === 'L2');
    for (let k = 1; k < leg2.length; k++) {
      expect(haversineNm(leg2[k - 1]!.lat, leg2[k - 1]!.lon, leg2[k]!.lat, leg2[k]!.lon)).toBeLessThanOrEqual(10);
    }
    // each end of the leg within half a spacing of a point
    expect(haversineNm(legs[1]!.from.lat, legs[1]!.from.lon, leg2[0]!.lat, leg2[0]!.lon)).toBeLessThanOrEqual(5);
    expect(haversineNm(legs[1]!.to.lat, legs[1]!.to.lon, leg2.at(-1)!.lat, leg2.at(-1)!.lon)).toBeLessThanOrEqual(5);
    // deterministic, and never rounded to a forecast lattice
    expect(auditSamplePoints(deriveLegs(r))).toEqual(points);
    expect(points.some((p) => Math.abs(p.lat * 4 - Math.round(p.lat * 4)) > 1e-3)).toBe(true);
  });

  it('places the same points for a track cut into legs on stretch boundaries', () => {
    const dLon = 57 / NM_PER_DEG_LON_49;
    const one = auditSamplePoints(deriveLegs(route([[49, -7], [49, -7 + dLon]])));
    const six = auditSamplePoints(deriveLegs(route(Array.from({ length: 7 }, (_, k) => [49, -7 + (dLon * k) / 6] as [number, number]))));
    expect(six).toHaveLength(one.length);
    six.forEach((p, k) => {
      expect(p.lat).toBeCloseTo(one[k]!.lat, 4);
      expect(p.lon).toBeCloseTo(one[k]!.lon, 4);
    });
  });
});

describe('audit sample hours', () => {
  const r = route([[49, -7], [49, -7 + 60 / NM_PER_DEG_LON_49]]);
  const schedule = computeRouteSchedules(r, '2026-07-20T00:00:00Z')[0]!;
  const points = auditSamplePoints(deriveLegs(r));

  it('judges a point from the earliest entry to the latest exit of its stretch, in whole hours', () => {
    const last = points.at(-1)!;
    const { fromMs, toMs } = pointWindowMs(last, schedule);
    // the leg derives as 60.04 nm, so seven stretches: the last starts 6/7 along, reached at 6.5 kt at the earliest
    const d = deriveLegs(r)[0]!.distance_nm;
    expect(d).toBe(60.04);
    expect(points).toHaveLength(7);
    // (the schedule keeps whole seconds)
    expect(Math.abs(fromMs - (parseUtc('2026-07-20T00:00:00Z') + ((d * 6) / 7 / 6.5) * 3_600_000))).toBeLessThan(1000);
    expect(toMs).toBeCloseTo(parseUtc(schedule.exit.slow), -2);
    const hours = pointHours(last, schedule);
    expect(hours[0]).toBe('2026-07-20T07:00:00Z');
    expect(hours.at(-1)).toBe('2026-07-20T14:00:00Z');
    // the first point is never judged after the boat must have left its stretch
    expect(pointHours(points[0]!, schedule).at(-1)).toBe('2026-07-20T02:00:00Z'); // 8.6 nm at 4.5 kt: 01:54
  });

  it('gives every leg hour at least one point, and no point an hour outside the leg', () => {
    const candidates = legHourCandidates(points, schedule);
    expect([...candidates.keys()]).toEqual(schedule.occupancy_hours);
    for (const [, list] of candidates) expect(list.length).toBeGreaterThan(0);
    // ordered along the leg
    for (const [, list] of candidates) expect([...list].sort((a, b) => a - b)).toEqual(list);
  });

  it('places the boat in one stretch on the nominal timing, clamped to the leg', () => {
    const nominal = { enterMs: 0, exitMs: 6 * 3_600_000 };
    expect([-1, 0, 0.99, 1, 3.5, 5.99, 6, 9].map((h) => expectedPointIndex(6, nominal, h * 3_600_000))).toEqual([0, 0, 0, 1, 3, 5, 5, 5]);
    expect(expectedPointIndex(1, nominal, 99)).toBe(0);
  });
});

describe('interpolateAtPoint: the missing-neighbour rule', () => {
  const w = [0.4, 0.3, 0.2, 0.1]; // nearest first
  it('is the weighted mean when every neighbour has a value', () => {
    const [v] = interpolateAtPoint([[[10]], [[20]], [[30]], [[40]]], w);
    expect(v![0]).toBeCloseTo(0.4 * 10 + 0.3 * 20 + 0.2 * 30 + 0.1 * 40, 9);
  });
  it('is the nearest valid neighbour when any is missing, and missing when none is', () => {
    expect(interpolateAtPoint([[[null]], [[20]], [[30]], [[40]]], w)[0]).toEqual([20]);
    expect(interpolateAtPoint([[[10]], [[20]], null as never, [[40]]].map((c) => c ?? [null]), w)[0]).toEqual([10]);
    expect(interpolateAtPoint([[[null]], [[null]], [[null]], [[null]]], w)[0]).toEqual([null]);
  });
  it('keeps variables read together from the same neighbours (wind u and v)', () => {
    // the nearest neighbour lacks v at this time: both u and v come from the second
    const out = interpolateAtPoint([[[1], [null]], [[2], [5]], [[3], [6]], [[4], [7]]], w);
    expect(out.map((s) => s[0])).toEqual([2, 5]);
  });
});

describe('the expected timing reads the boat\'s expected position', () => {
  const CYCLE = '2026-07-20T00:00Z';
  const lon0 = -7, span = 60 / NM_PER_DEG_LON_49;
  // wind from the north rising evenly eastward along a 60 nm leg, 10 to 24 kt
  const speed = (lon: number) => 10 + (14 * (lon - lon0)) / span;
  const offsets = Array.from({ length: 49 }, (_, h) => h);
  const store = () => new TileForecastStore({
    transport: buildFixtureRun([{
      layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { hourly: { base: CYCLE, offsets_h: offsets } },
      variables: [
        { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 0 },
        { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: (_m, _t, _i, j, g) => -speed(g.lon0 + j * g.dlon) },
        { name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: (_m, _t, _i, j, g) => speed(g.lon0 + j * g.dlon) },
      ],
      tiles: [[40, -10]],
    }, {
      layer: 'ensemble', model: 'gefs_0p50', cycle: CYCLE, resolution_deg: 0.5, member_count: 2,
      time_axes: { s: { base: CYCLE, offsets_h: offsets.filter((h) => h % 3 === 0) } },
      variables: [
        { name: 'wind_kt_mean', axis: 's', dtype: 'i16', scale: 0.01, value: (_m, _t, _i, j, g) => speed(g.lon0 + j * g.dlon) },
        { name: 'wind_kt_anom', axis: 's', dtype: 'i8', scale: 0.2, per_member: true, value: () => 0 },
      ],
      tiles: [[40, -10]],
    }]),
    now: () => parseUtc('2026-07-20T04:00:00Z'),
  });
  const profile = {
    schema_version: 1, profile_id: 'flat', label: 'flat', declared: true,
    max_sustained_kt: { default: 20, upwind: 20, reach: 20, downwind: 20 }, max_gust_kt: 99, approaching_ratio: 0.75,
  } as LimitsProfile;
  const r = route([[49.1, lon0], [49.1, lon0 + span]]);

  const analysis = () => runAnalysis({ route: r, profile, departureUtc: '2026-07-20T00:00:00Z', store: store(), now: () => 0 });
  async function findings(): Promise<Findings> {
    return (await analysis()).findings;
  }

  it('the ensemble plume follows the boat\'s expected position along the leg', async () => {
    const { findings: f, plume } = await analysis();
    const leg = f.legs[0]!;
    const nominal = { enterMs: parseUtc(leg.enter_range.nominal), exitMs: parseUtc(leg.eta_range.nominal) };
    const line = plume.legs[0]!;
    let compared = 0;
    line.times.forEach((t, k) => {
      const value = line.wind_members[0]![k];
      if (value === null || value === undefined) return;
      const point = leg.sample_points![expectedPointIndex(6, nominal, parseUtc(t))]!;
      expect(value).toBeCloseTo(speed(point.lon), 0);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(5);
    // before the nominal entry the first point, after the nominal arrival the last
    expect(new Set(line.wind_members[0]!.filter((v) => v !== null)).size).toBe(6);
  });

  it('records the reading at the expected position beside each row, which is the worst of the stretch', async () => {
    const f = await findings();
    const leg = f.legs[0]!;
    expect(leg.sample_points).toHaveLength(6);
    const nominalEnter = parseUtc(leg.enter_range.nominal), nominalExit = parseUtc(leg.eta_range.nominal);
    for (const hour of leg.hours) {
      expect(hour.expected).toBeDefined();
      const k = expectedPointIndex(6, { enterMs: nominalEnter, exitMs: nominalExit }, parseUtc(hour.valid_time));
      const point = leg.sample_points![k]!;
      expect(hour.expected!.sample_point_id).toBe(point.point_id);
      expect(hour.expected!.wind_kt).toBeCloseTo(speed(point.lon), 1);
      // the row is the worst point the boat can be at, never below the expected one
      expect(hour.wind_kt!).toBeGreaterThanOrEqual(hour.expected!.wind_kt! - 1e-9);
    }
    // somewhere the worst of the stretch is well above where the boat is expected to be
    expect(leg.hours.some((h) => h.wind_kt! - h.expected!.wind_kt! > 1)).toBe(true);
  });

  it('route summary and the expected hours over a limit use it; the arrival range uses the rows', async () => {
    const f = await findings();
    const nominal = nominalPassageHours(f);
    expect(nominal.length).toBeGreaterThan(0);
    for (const { hour } of nominal) {
      expect(hour.wind_kt).toBe(hour.expected!.wind_kt);
      expect(hour.limit_status).toEqual(hour.expected!.limit_status);
    }
    const expectedOver = nominal.filter(({ hour }) => hour.expected!.limit_status.sustained === 'exceeded').length;
    const rowsOver = f.legs[0]!.hours.filter((h) => parseUtc(h.valid_time) >= parseUtc(f.legs[0]!.enter_range.nominal) &&
      parseUtc(h.valid_time) < parseUtc(f.legs[0]!.eta_range.nominal) && h.limit_status.sustained === 'exceeded').length;
    const figures = passageLimitHours(f);
    expect(figures.expected_hours_over_limit).toBe(expectedOver);
    expect(expectedOver).toBeLessThan(rowsOver);
    expect(figures.arrival_hours_over_limit).toBeGreaterThanOrEqual(rowsOver);
    const summary = routeSummary(f)!;
    const bands = nominal.map(({ hour }) => hour.wind_kt!);
    expect(summary.by_wind_band.from_20_to_25).toBe(bands.filter((x) => x >= 20 && x < 25).length);
  });

  it('a row without an expected reading (single-point legs, older findings) is read as it is', () => {
    const hour = { valid_time: '2026-07-20T00:00:00Z', wind_kt: 12, gust_kt: 15, wind_dir_deg: 0, twa_deg: 90, point_of_sail: 'reach' as const,
      limit_status: { sustained: 'ok' as const, gust: 'ok' as const } };
    expect(expectedTimingHour(hour)).toBe(hour);
  });
});

describe('every sample point of an hour counts (review round 1)', () => {
  // one 19 nm leg read at two points; both are read in the middle hours of the leg
  const lonPerNm = 1 / NM_PER_DEG_LON_49;
  const r = route([[49, -5], [49, -5 + 19 * lonPerNm]]);
  const profile = {
    schema_version: 1, profile_id: 'f', label: 't', declared: true,
    max_sustained_kt: { default: 22, upwind: 22, reach: 22, downwind: 22 }, max_gust_kt: 30, approaching_ratio: 0.75, scenario_fraction_floor: 0.3,
  } as LimitsProfile;
  const points = auditSamplePoints(deriveLegs(r));
  const times = Array.from({ length: 10 }, (_, h) => `2026-07-20T${String(4 + h).padStart(2, '0')}:00:00Z`);
  const det = points.map((p) => ({ lat: p.lat, lon: p.lon, times, wind_kt: times.map(() => 10), gust_kt: times.map(() => 12), wind_dir_deg: times.map(() => 0) }));
  const meta = [{ source: 'fixture' as const, layer: 'weather', model: 'gfs_0p25', run_id: 'r', cycle: '2026-07-20T00:00Z', resolution_deg: 0.25, tiles: [], fetched_at: 'x', cached_tiles: 0, points: 2 }];
  const base = { route: r, profile, departureUtc: '2026-07-20T06:00:00Z', nowMs: 1, engineVersion: 't', requestMeta: meta, pointForecasts: det };
  const both = (hour: string) => {
    const s = computeRouteSchedules(r, base.departureUtc)[0]!;
    return legHourCandidates(points, s).get(hour)!;
  };

  it('flags models disagreeing near the limit at one point although another point spreads more in light wind', () => {
    expect(points).toHaveLength(2);
    expect(both('2026-07-20T08:00:00Z')).toEqual([0, 1]);
    const hz = (p: typeof points[number], wind: (t: string) => number) => ({ lat: p.lat, lon: p.lon, times, wind_kt: times.map(wind), gust_kt: times.map(() => 12),
      wind_dir_deg: times.map(() => 0), visibility_m: times.map(() => 20000), cape_jkg: times.map(() => 0), temp_c: times.map(() => 15), dew_point_c: times.map(() => 5), precip_mm: times.map(() => 0) });
    const at8 = (t: string) => t.startsWith('2026-07-20T08');
    // A: 2 against 12 kt every hour (a 10 kt spread in light wind); B at 08:00: 17 against 25 kt (8 kt, over 0.8 x 22 kt)
    const byModel = {
      gfs_0p25: [hz(points[0]!, () => 2), hz(points[1]!, (t) => (at8(t) ? 17 : 10))],
      ecmwf_ifs025: [hz(points[0]!, () => 12), hz(points[1]!, (t) => (at8(t) ? 25 : 10))],
    };
    const f = assembleFindings({ ...base, multiModel: { byModel, meta } });
    expect(f.verdict.state).toBe('insufficient');
    const at = f.legs[0]!.divergent_hours!.find((h) => h.valid_time === '2026-07-20T08:00:00Z')!;
    expect(at.values).toEqual({ gfs_0p25: 17, ecmwf_ifs025: 25 });
    const evidence = f.evidence.find((e) => e.rule_id === 'D-DIVERGE-01')!;
    expect(evidence.sample_point_id).toBe(points[1]!.point_id);
  });

  it('counts a forecast scenario that exceeds the limit at any point the boat can be at in the hour', () => {
    // 51 members: 15 exceed the gust limit only at A, another 15 only at B, at every hour
    const members = (exceeding: (m: number) => boolean) => Array.from({ length: 51 }, (_, m) => times.map(() => (exceeding(m) ? 35 : 20)));
    const ens = (p: typeof points[number], exceeding: (m: number) => boolean) => ({
      lat: p.lat, lon: p.lon, times, wind_kt_members: members(() => false), gust_kt_members: members(exceeding),
    });
    const pointEnsembles = [ens(points[0]!, (m) => m < 15), ens(points[1]!, (m) => m >= 15 && m < 30)];
    const ensembleMeta = { ...meta[0]!, layer: 'ensemble', model: 'gefs', member_count: 51 };
    const f = assembleFindings({ ...base, pointEnsembles, ensembleMeta });
    const hour = f.legs[0]!.hours.find((h) => h.valid_time === '2026-07-20T08:00:00Z')!;
    // the largest single-point count is 15 of 51 (29 %, under the 0.3 floor); 30 of 51 exceed somewhere the boat can be
    expect(hour.exceedance!.gust).toEqual({ exceed: 30, total: 51 });
    const firstHour = f.legs[0]!.hours[0]!; // only A is read then
    expect(firstHour.exceedance!.gust).toEqual({ exceed: 15, total: 51 });
    const evidence = f.evidence.find((e) => e.rule_id === 'W-GUST-03')!;
    expect(evidence.member_fraction).toEqual({ exceed: 30, total: 51 });
    // a count across points names no single point
    expect(evidence.sample_point_id).toBeUndefined();
    expect(f.verdict.state).not.toBe('within');
  });
});

describe('point reads are stored at the published precision', () => {
  it('rounds interpolated and time-resampled values to a fixed precision (0.01, or the tile scale for visibility)', async () => {
    const CYCLE = '2026-07-20T00:00Z';
    const odd = (i: number, j: number) => 10 + i * 0.37 + j * 0.53; // node values off any coarse grid
    const transport = buildFixtureRun([{
      layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { s: { base: CYCLE, offsets_h: [0, 3, 6, 9, 12] } },
      variables: [
        { name: 'wind_u_kt', axis: 's', dtype: 'i16', scale: 0.01, value: (_m, t, i, j) => odd(i, j) + t },
        { name: 'wind_v_kt', axis: 's', dtype: 'i16', scale: 0.01, value: (_m, _t, i) => 1 + i * 0.11 },
        { name: 'gust_kt', axis: 's', dtype: 'i16', scale: 0.1, value: (_m, t, i, j) => odd(i, j) * 1.3 + t },
        { name: 'visibility_m', axis: 's', dtype: 'i16', scale: 50, value: (_m, t, i) => 8000 + 333 * i + 50 * t },
      ],
      tiles: [[40, -10]],
    }, {
      layer: 'ensemble', model: 'gefs_0p50', cycle: CYCLE, resolution_deg: 0.5, member_count: 3,
      time_axes: { s: { base: CYCLE, offsets_h: [0, 6, 12] } },
      variables: [
        { name: 'wind_kt_mean', axis: 's', dtype: 'i16', scale: 0.01, value: (_m, t, i, j) => odd(i, j) + t },
        { name: 'wind_kt_anom', axis: 's', dtype: 'i8', scale: 0.2, per_member: true, value: (m) => m - 1 },
      ],
      tiles: [[40, -10]],
    }]);
    const store = new TileForecastStore({ transport, now: () => parseUtc('2026-07-20T04:00:00Z') });
    const p = [{ lat: 45.13, lon: -5.07 }];
    const start = parseUtc('2026-07-20T00:00Z'), end = parseUtc('2026-07-20T12:00Z');
    const det = (await store.getPointForecasts(p, start, end)).forecasts[0]!;
    const ens = (await store.getEnsembleForecasts(p, start, end))!.forecasts[0]!;
    const hz = (await store.getHazardForecasts(p, start, end))!.byModel.gfs_0p25![0]!;
    // exactly a multiple of the step, written with no more decimals than the step has
    const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    const onStep = (values: Array<number | null>, step: number) => values.filter((v): v is number => v !== null)
      .every((v) => v === Number((Math.round(v / step) * step).toFixed(decimals(step))));
    expect(det.gust_kt.filter((v) => v !== null).length).toBeGreaterThan(10);
    // compared quantities at 0.01, rounded up (see 'rounding never makes a value less hazardous')
    expect(onStep(det.gust_kt, 0.01)).toBe(true);
    expect(onStep(det.wind_kt, 0.01)).toBe(true);
    expect(onStep(det.wind_dir_deg, 0.1)).toBe(true);
    for (const member of ens.wind_kt_members) expect(onStep(member, 0.01)).toBe(true);
    expect(onStep(hz.visibility_m, 50)).toBe(true);
    // still interpolated: not the value of any single grid point
    expect(new Set(det.gust_kt).size).toBeGreaterThan(5);
  });
});

describe('rounding never makes a value less hazardous (review round 2)', () => {
  it('rounds compared quantities toward the hazardous side by less than one step', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let k = 0; k < 20000; k++) {
      const v = rnd() * 60;
      const [up] = roundToward([v], 0.01, 'up');
      const [down] = roundToward([v * 300], 50, 'down');
      const [capeUp] = roundToward([v * 40], 1, 'up');
      // never under the unrounded value (beyond float noise), less than one step above it
      expect(up!).toBeGreaterThanOrEqual(v - 1e-5); // float noise: a thousandth of a step
      expect(up! - v).toBeLessThan(0.01);
      expect(down!).toBeLessThanOrEqual(v * 300 + 0.05);
      expect(v * 300 - down!).toBeLessThan(50);
      expect(capeUp!).toBeGreaterThanOrEqual(v * 40 - 1e-3);
      // every limit comparison: over (>) and approaching (>=) never turn off
      for (const limit of [Math.floor(v * 10) / 10, Math.floor(v * 100) / 100, 17.8, 22]) {
        if (v > limit + 1e-5) expect(up! > limit).toBe(true);
        if (v >= 0.75 * limit) expect(up! >= 0.75 * limit - 1e-9).toBe(true);
      }
      // visibility below a minimum stays below it
      for (const min of [1852, 3704, 5556]) if (v * 300 < min - 0.05) expect(down! < min).toBe(true);
    }
    // a value already on the 0.01 lattice within float noise stays on it
    expect(roundToward([17.800000000000001, 0.1 + 0.2, 16.3], 0.01, 'up')).toEqual([17.8, 0.3, 16.3]);
    expect(roundToward([17.808], 0.01, 'up')).toEqual([17.81]);
  });

  it('an interpolated gust of 17.808 kt still exceeds a 17.8 kt limit', async () => {
    const CYCLE = '2026-07-20T00:00Z';
    // gust 17.7 kt at 5.0 W and 17.9 kt at 4.75 W: 54 % of the way, 17.808 kt
    const transport = buildFixtureRun([{
      layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { h: { base: CYCLE, offsets_h: Array.from({ length: 49 }, (_, h) => h) } },
      variables: [
        { name: 'wind_u_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0 },
        { name: 'wind_v_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => -8 },
        { name: 'gust_kt', axis: 'h', dtype: 'i16', scale: 0.1, value: (_m, _t, _i, j, g) => (g.lon0 + j * g.dlon >= -4.75 - 1e-9 ? 17.9 : 17.7) },
      ],
      tiles: [[40, -10]],
    }]);
    const store = new TileForecastStore({ transport, now: () => parseUtc('2026-07-20T04:00:00Z') });
    const lon = -5 + 0.54 * 0.25;
    const read = (await store.getPointForecasts([{ lat: 45, lon }], parseUtc('2026-07-20T06:00Z'), parseUtc('2026-07-20T07:00Z'))).forecasts[0]!;
    expect(read.gust_kt[0]).toBe(17.81);
    const r = route([[44.95, lon], [45.05, lon]]); // a 6 nm leg due north, its midpoint on 45 N
    const profile = { schema_version: 1, profile_id: 'g', label: 'g', declared: true,
      max_sustained_kt: { default: 30, upwind: 30, reach: 30, downwind: 30 }, max_gust_kt: 17.8, approaching_ratio: 0.75 } as LimitsProfile;
    const f = (await runAnalysis({ route: r, profile, departureUtc: '2026-07-20T06:00:00Z', store, now: () => 0 })).findings;
    expect(f.legs[0]!.hours.every((h) => h.limit_status.gust === 'exceeded')).toBe(true);
    expect(f.verdict.state).toBe('exceeds');
  });
});
