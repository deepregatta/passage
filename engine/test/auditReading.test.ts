/**
 * How a Check reads the forecast (engine semantics `passage-audit-4`): along
 * each leg, interpolated on each layer's own grid, each point judged for the
 * hours the boat can be at it. Every case runs the real audit (runAnalysis) on
 * a real TileForecastStore over invented, analytic PFT1 fields, and only uses
 * entry points the engine had before the change, so the same file can be run
 * against the earlier engine to see each defect fail.
 *
 * Fields are on the 0.25° lattice of tile N40W010; wind speeds are exact at
 * the grid points and the audit sees what interpolation between them implies.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAnalysis, auditSamplePlan } from '../src/analyze.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { passageLimitHours, scanDepartures } from '../src/window.js';
import { deriveLegs } from '../src/route.js';
import { parseUtc } from '../src/eta.js';
import { auditTileRequests, planTileRequests } from '../src/forecast/tileRequests.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';
import type { Findings, LimitsProfile, Route } from '../src/types.js';

const CYCLE = '2026-07-20T00:00Z';
const NOW = () => parseUtc('2026-07-20T04:00:00Z');
const HOURS = 60;
const NM_PER_DEG_LON_49 = 60 * Math.cos((49 * Math.PI) / 180);

type Field = (lat: number, lon: number, hour: number) => { speed: number; fromDeg: number; gust?: number };

function weatherLayer(field: Field, tiles: Array<[number, number]> = [[40, -10]]): FixtureLayerSpec {
  const offsets = Array.from({ length: HOURS + 1 }, (_, h) => h);
  const at = (t: number, i: number, j: number, g: { lat0: number; lon0: number; dlat: number; dlon: number }) =>
    field(g.lat0 + i * g.dlat, g.lon0 + j * g.dlon, offsets[t]!);
  const uv = (w: { speed: number; fromDeg: number }) => {
    const r = (w.fromDeg * Math.PI) / 180;
    return { u: -w.speed * Math.sin(r), v: -w.speed * Math.cos(r) };
  };
  return {
    layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25,
    time_axes: { hourly: { base: CYCLE, offsets_h: offsets } },
    variables: [
      { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: (_m, t, i, j, g) => uv(at(t, i, j, g)).u },
      { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: (_m, t, i, j, g) => uv(at(t, i, j, g)).v },
      { name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: (_m, t, i, j, g) => { const w = at(t, i, j, g); return w.gust ?? w.speed; } },
    ],
    tiles,
  };
}

const storeOf = (...layers: FixtureLayerSpec[]) => new TileForecastStore({ transport: buildFixtureRun(layers), now: NOW });

/** One limit on every point of sail; the gust limit out of the way unless given. */
function flatProfile(sustained: number, gust = 99): LimitsProfile {
  return {
    schema_version: 1, profile_id: `flat-${sustained}`, label: 'test', declared: true,
    max_sustained_kt: { default: sustained, upwind: sustained, reach: sustained, downwind: sustained },
    max_gust_kt: gust, approaching_ratio: 0.75, scenario_fraction_floor: 0.3,
  } as LimitsProfile;
}

function route(points: Array<[number, number]>, id = 'r'): Route {
  return {
    schema_version: 1, route_id: id, name: id, mode: 'user', timing: { basis: 'through_water' },
    speeds_kt: { slow: 4.5, nominal: 5.5, fast: 6.5 },
    waypoints: points.map(([lat, lon], k) => ({ id: `w${k}`, lat, lon })),
  } as Route;
}

/** A track due east along `lat` from `lon0`, `nm` long, cut into `legs` equal legs. */
function eastward(lat: number, lon0: number, nm: number, legs: number, id = `east-${legs}`): Route {
  const dLon = nm / NM_PER_DEG_LON_49;
  return route(Array.from({ length: legs + 1 }, (_, k) => [lat, lon0 + (dLon * k) / legs] as [number, number]), id);
}

async function check(store: TileForecastStore, r: Route, profile: LimitsProfile, departureUtc = '2026-07-20T06:00:00Z') {
  return (await runAnalysis({ route: r, profile, departureUtc, store, now: NOW })).findings;
}

const peakWind = (f: Findings) => Math.max(0, ...f.legs.flatMap((l) => l.hours.map((h) => h.wind_kt ?? 0)));
const hoursOver = (f: Findings) => passageLimitHours(f).arrival_hours_over_limit;

describe('the audit reads the forecast along each leg', () => {
  it('(a) finds wind rising past the limit along one long leg that its midpoint did not reach', async () => {
    // 12 kt at the start rising evenly to 26 kt at the end of a 60 nm leg; the middle is about 19 kt
    const lon0 = -7, span = 60 / NM_PER_DEG_LON_49;
    const store = storeOf(weatherLayer((_lat, lon) => ({ speed: 12 + (14 * (lon - lon0)) / span, fromDeg: 0 })));
    const f = await check(store, eastward(49.1, lon0, 60, 1), flatProfile(20));
    expect(f.verdict.state).toBe('exceeds');
    // the leg derives as 60.04 nm: seven stretches, the last read about 55.7 nm along (about 25 kt); nothing past the end
    expect(peakWind(f)).toBeGreaterThan(24);
    expect(peakWind(f)).toBeLessThan(26);
  });

  it('(b) finds a strong patch at a turn between two legs whose midpoints are clear of it', async () => {
    // 30 kt at the turn's grid point (49.0 N, 6.0 W) falling off with a 6 nm sigma to 12 kt
    const store = storeOf(weatherLayer((lat, lon) => {
      const dy = (lat - 49) * 60, dx = (lon + 6) * NM_PER_DEG_LON_49;
      return { speed: 12 + 18 * Math.exp(-(dx * dx + dy * dy) / (2 * 36)), fromDeg: 270 };
    }));
    // 40 nm north to the turn, then 40 nm east
    const r = route([[49 - 40 / 60, -6], [49, -6], [49, -6 + 40 / NM_PER_DEG_LON_49]], 'turn');
    const f = await check(store, r, flatProfile(22));
    expect(f.verdict.state).toBe('exceeds');
    expect(f.legs.map((l) => l.hours.some((h) => h.limit_status.sustained === 'exceeded'))).toEqual([true, true]);
  });

  it('(c) does not flag a band of strong wind the route runs just outside of (within what interpolation implies)', async () => {
    // a sharp step between grid rows: 12 kt up to 49.0 N, 28 kt from 49.25 N
    const store = storeOf(weatherLayer((lat) => ({ speed: lat >= 49.2 ? 28 : 12, fromDeg: 270 })));
    // 1.4 nm north of the middle of the cell (49.125 N): its nearest grid row is the strong one
    const lat = 49.125 + 1.4 / 60;
    const f = await check(store, eastward(lat, -7, 60, 1), flatProfile(22));
    expect(f.verdict.state).not.toBe('exceeds');
    expect(hoursOver(f)).toBe(0);
    // exactly what bilinear interpolation between the two rows gives at this latitude
    const expected = 12 + 16 * ((lat - 49) / 0.25);
    expect(peakWind(f)).toBeCloseTo(expected, 1);
  });

  it('(d) reads the same hours over for one track drawn as 1 leg or as 6 legs, and nearly the same as 4', async () => {
    const lon0 = -7, span = 57 / NM_PER_DEG_LON_49;
    const store = storeOf(weatherLayer((_lat, lon, h) => ({ speed: 12 + (12 * (lon - lon0)) / span + 0.1 * h, fromDeg: 0 })));
    const profile = flatProfile(20);
    const one = await check(store, eastward(49.1, lon0, 57, 1), profile);
    const six = await check(store, eastward(49.1, lon0, 57, 6), profile);
    const four = await check(store, eastward(49.1, lon0, 57, 4), profile);
    expect(hoursOver(six)).toBeGreaterThan(0);
    expect(one.verdict.state).toBe(six.verdict.state);
    expect(hoursOver(one)).toBe(hoursOver(six));
    expect(peakWind(one)).toBeCloseTo(peakWind(six), 1);
    expect(four.verdict.state).toBe(six.verdict.state);
    expect(Math.abs(hoursOver(four) - hoursOver(six))).toBeLessThanOrEqual(1);
  });

  it('(e) reads the ensemble on its own 0.5° grid at the exact point (the 49.13 N case)', async () => {
    // member values equal the latitude of the grid point they were read at
    const ensemble: FixtureLayerSpec = {
      layer: 'ensemble', model: 'gefs_0p50', cycle: CYCLE, resolution_deg: 0.5, member_count: 2,
      time_axes: { s: { base: CYCLE, offsets_h: [0, 6, 12, 18, 24, 30, 36, 42, 48] } },
      variables: [
        { name: 'wind_kt_mean', axis: 's', dtype: 'i16', scale: 0.01, value: (_m, _t, i, _j, g) => g.lat0 + i * g.dlat },
        { name: 'wind_kt_anom', axis: 's', dtype: 'i8', scale: 0.2, per_member: true, value: () => 0 },
      ],
      tiles: [[40, -10]],
    };
    const store = storeOf(weatherLayer(() => ({ speed: 10, fromDeg: 0 })), ensemble);
    const r = route([[49.08, -6], [49.18, -6]], 'ens'); // one 6 nm leg, midpoint 49.13 N
    const plan = auditSamplePlan(r, '2026-07-20T06:00:00Z');
    const read = (await store.getEnsembleForecasts(plan.points, plan.startMs, plan.endMs))!;
    const values = read.forecasts[0]!.wind_kt_members[0]!.filter((v): v is number => v !== null);
    expect(values.length).toBeGreaterThan(0);
    // before: the point was rounded to 49.25 N, then to the 49.5 N row of the 0.5° grid (22 nm away)
    for (const v of values) expect(v).toBeCloseTo(49.13, 2);
  });

  it('(f) judges each point only for the hours the boat can be at it', async () => {
    // 30 kt only east of 5.75 W (the grid points under the last stretch of a 60 nm leg), at chosen hours; 10 kt elsewhere
    const lon0 = -7;
    const lastStretch = (lon: number) => lon >= -5.75;
    const profile = flatProfile(22);
    const leg = eastward(49.1, lon0, 60, 1);
    // departing 00Z, the boat reaches the last stretch (from about 51.5 nm of 60.04) at 07:55 at the earliest
    const early = storeOf(weatherLayer((_lat, lon, h) => ({ speed: lastStretch(lon) && h <= 6 ? 30 : 10, fromDeg: 0 })));
    const before = await check(early, leg, profile, '2026-07-20T00:00:00Z');
    expect(before.verdict.state).not.toBe('exceeds');
    expect(hoursOver(before)).toBe(0);
    const late = storeOf(weatherLayer((_lat, lon, h) => ({ speed: lastStretch(lon) && h >= 10 ? 30 : 10, fromDeg: 0 })));
    const after = await check(late, leg, profile, '2026-07-20T00:00:00Z');
    expect(after.verdict.state).toBe('exceeds');
    // over from 10:00 to the slow arrival, 13:20, ceiled to 14:00
    const over = after.legs[0]!.hours.filter((h) => h.limit_status.sustained === 'exceeded').map((h) => h.valid_time);
    expect(over[0]).toBe('2026-07-20T10:00:00Z');
    expect(over.at(-1)).toBe('2026-07-20T14:00:00Z');
  });

  it('(g) near land, a wave point with a land-masked neighbour reads the nearest sea grid point, and none when all are land', async () => {
    // land (no wave value) west of 6.0 W; Hs rises 0.5 m per grid column eastward
    const waves: FixtureLayerSpec = {
      layer: 'waves', model: 'gfswave_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { s: { base: CYCLE, offsets_h: [0, 3, 6, 9, 12, 15, 18, 21, 24] } },
      variables: ['hs_m', 'period_s', 'wind_wave_h_m', 'swell_h_m', 'swell_period_s', 'wind_wave_period_s', 'dir_deg', 'wind_wave_dir_deg', 'swell_dir_deg']
        .map((name) => ({
          name, axis: 's', dtype: 'i16' as const, scale: name.endsWith('_deg') ? 0.1 : 0.01,
          value: (_m: number, _t: number, _i: number, j: number, g: { lon0: number; dlon: number }) => {
            const lon = g.lon0 + j * g.dlon;
            if (lon < -6 - 1e-9) return NaN;
            if (name.endsWith('_deg')) return 270;
            if (name.includes('period')) return 8;
            return 1 + 0.5 * Math.round((lon + 6) / 0.25);
          },
        })),
      tiles: [[40, -10]],
    };
    const store = storeOf(weatherLayer(() => ({ speed: 10, fromDeg: 0 })), waves);
    await store.init();
    const startMs = parseUtc('2026-07-20T06:00Z'), endMs = parseUtc('2026-07-20T09:00Z');
    const read = (await store.getWaveForecasts([
      { lat: 49.1, lon: -6.1 }, // the land column 6.25 W is a neighbour; the nearest grid point (6.0 W) is at sea
      { lat: 49.1, lon: -6.2 }, // nearest grid point is land; the sea column 6.0 W stands in
      { lat: 49.1, lon: -5.9 }, // all four at sea: interpolated between 1.0 and 1.5 m
      { lat: 49.1, lon: -7.1 }, // all four on land: missing
    ], startMs, endMs))!;
    const hs = read.forecasts.map((f) => f.hs_m[0] ?? null);
    expect(hs[0]).toBeCloseTo(1, 5);
    expect(hs[1]).toBeCloseTo(1, 5);
    expect(hs[2]).toBeCloseTo(1 + 0.5 * 0.4, 2);
    expect(hs[3]).toBeNull();
  });

  it('(i) a departure comparison and the Check of one of its departures read the same', async () => {
    const lon0 = -7, span = 60 / NM_PER_DEG_LON_49;
    const store = storeOf(weatherLayer((_lat, lon, h) => ({ speed: 10 + (12 * (lon - lon0)) / span + 0.2 * h, fromDeg: 0 })));
    const r = eastward(49.1, lon0, 60, 2);
    const profile = flatProfile(20);
    const departures = ['2026-07-20T00:00:00Z', '2026-07-20T06:00:00Z', '2026-07-20T12:00:00Z'];
    const scan = await scanDepartures({ route: r, profile, store, now: NOW }, departures);
    for (const departure of departures) {
      const candidate = scan.candidates.find((c) => c.departure_utc === departure)!;
      const f = await check(store, r, profile, departure);
      const figures = passageLimitHours(f);
      expect(candidate.verdict).toBe(f.verdict.state);
      expect(candidate.arrival_hours_over_limit).toBe(figures.arrival_hours_over_limit);
      expect(candidate.expected_hours_over_limit).toBe(figures.expected_hours_over_limit);
    }
    expect(new Set(scan.candidates.map((c) => c.arrival_hours_over_limit)).size).toBeGreaterThan(1);
  });

  it('(j) the download estimate asks for the points and tiles the Check reads', async () => {
    // a leg of about 39 nm ending 3 nm south of the 50 N tile line: its last point interpolates across it
    const run = buildFixtureRun([weatherLayer(() => ({ speed: 10, fromDeg: 0 }), [[40, -10], [50, -10]])]);
    const fetched = new Set<string>();
    const fetchTile = run.fetchTile.bind(run);
    run.fetchTile = async (runId, path, options) => { fetched.add(path); return fetchTile(runId, path, options); };
    const store = new TileForecastStore({ transport: run, now: NOW });
    const r = route([[50 - 42 / 60, -5], [50 - 3 / 60, -5]], 'north');
    const departure = '2026-07-20T06:00:00Z';
    const plan = auditSamplePlan(r, departure);
    const spy = vi.spyOn(store, 'getPointForecasts');
    await runAnalysis({ route: r, profile: flatProfile(22), departureUtc: departure, store, now: NOW });
    const asked = spy.mock.calls[0]![0].map((p) => ({ lat: p.lat, lon: p.lon }));
    expect(asked).toEqual(plan.points.map((p) => ({ lat: p.lat, lon: p.lon })));
    // four stretches of under 10 nm along the leg, each read at its middle, at its exact position
    expect(plan.points).toHaveLength(4);
    expect(plan.points.at(-1)!.lat).toBeCloseTo(50 - 3 / 60 - 39 / 8 / 60, 4);
    const quoted = planTileRequests(auditTileRequests((layer) => store.manifestFor(layer), { where: { points: plan.points }, window: plan }), (layer) => store.manifestFor(layer));
    const weatherTiles = quoted.tiles.filter((t) => t.layer === 'weather').map((t) => t.tileId).sort();
    expect([...fetched].filter((p) => p.startsWith('weather/')).map((p) => p.split('/').at(-1)!.replace('.bin', '')).sort())
      .toEqual(weatherTiles);
    expect(weatherTiles).toEqual(['N40W010', 'N50W010']);
    expect(deriveLegs(r)).toHaveLength(1);
  });
});
