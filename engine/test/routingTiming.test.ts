import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { computeRoute } from '../src/routing/isochrone.js';
import { runAnalysis } from '../src/analyze.js';
import { scanDepartures } from '../src/window.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { deriveLegs } from '../src/route.js';
import { haversineNm } from '../src/geo.js';
import { parseGpx } from '../src/gpx.js';
import { computeRouteSchedules } from '../src/eta.js';
import type { RegionGrid } from '../src/grids.js';
import type { Polar } from '../src/routing/polar.js';
import type { LimitsProfile, Route } from '../src/types.js';

const departureUtc = '2026-07-20T00:00:00Z';
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateRoute = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/route.schema.json', import.meta.url), 'utf8')));
const profile: LimitsProfile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
const polar: Polar = {
  schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
  tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' },
};
function grid(kind: RegionGrid['kind'], u: number, v: number): RegionGrid {
  return {
    schema_version: 1, kind, run_id: `test-${kind}-${u}`, generated_at: departureUtc,
    lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
    time_axis: [departureUtc, '2026-07-24T00:00:00Z'],
    u_kt: Array(24).fill(u), v_kt: Array(24).fill(v), source: { mode: 'synthetic' },
  };
}
const request = {
  start: { lat: 49.5, lon: -3.5 }, finish: { lat: 49.5, lon: -3.2 },
  departureUtc, polar, windGrid: grid('wind10m', 0, -12), resolutionDeg: 0.1, maxHours: 48,
};
function store(current: RegionGrid) {
  const times = Array.from({ length: 97 }, (_, h) => new Date(Date.parse(departureUtc) + h * 3600_000).toISOString().slice(0, 16));
  const result = new ScenarioBundleStore({ loadBundle: async (name) => name === 'forecast' ? {
    hourly: { time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90) },
  } : null });
  result.getCurrentGrid = async () => current;
  return result;
}

// Real router -> public analysis -> scan: no mocked scheduling or audit.
describe('routed timing across audit and departure scans', () => {
  it('keeps per-leg timing and occupancy windows instead of replacing them with an average speed', () => {
    const route: Route = JSON.parse(readFileSync(new URL('./fixtures/routes/routed-current.json', import.meta.url), 'utf8'));
    route.waypoints.splice(1, 0, { id: 'middle', lat: 49.5, lon: -3.4 });
    route.timing = { basis: 'routed', departure_utc: departureUtc, legs: [
      { leg_id: 'L1', duration_ms: { slow: 7200000, nominal: 3600000, fast: 1800000 }, through_water_kt: 5, speed_over_ground_kt: 3.9 },
      { leg_id: 'L2', duration_ms: { slow: 3600000, nominal: 1800000, fast: 900000 }, through_water_kt: 5, speed_over_ground_kt: 15.6 },
    ] };
    const schedules = computeRouteSchedules(route, departureUtc, () => ({ u_kt: 2, v_kt: 0 }));
    expect(schedules[0]!.exit.nominal).toBe('2026-07-20T01:00:00Z');
    expect(schedules[1]!.enter.nominal).toBe(schedules[0]!.exit.nominal);
    expect(schedules[1]!.exit).toEqual({ slow: '2026-07-20T03:00:00Z', nominal: '2026-07-20T01:30:00Z', fast: '2026-07-20T00:45:00Z' });
    expect(schedules[1]!.occupancy_hours).toEqual(['2026-07-20T00:00:00Z', '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z', '2026-07-20T03:00:00Z']);
  });

  it('requires rerouting for another departure but accepts equivalent UTC spellings', () => {
    const route = computeRoute(request).route;
    expect(() => computeRouteSchedules(route, '2026-07-20T01:00:00Z')).toThrow('another departure');
    expect(computeRouteSchedules(route, '2026-07-20T02:00:00+02:00')).toEqual(computeRouteSchedules(route, departureUtc));
  });

  it.each([2, -2, 0])('preserves routed arrival with %s kt along current and still assesses hazards', async (along) => {
    const current = grid('surface_current', along, 0);
    const routed = computeRoute({ ...request, currentGrid: current });
    const route = JSON.parse(JSON.stringify(routed.route)) as Route; // saved-data round trip
    expect(validateRoute(route), JSON.stringify(validateRoute.errors)).toBe(true);
    const audited = await runAnalysis({ route, profile, departureUtc, store: store(current) });
    expect(audited.findings.legs.at(-1)!.eta_range.nominal).toBe(routed.arrival_utc);
    expect(route.speeds_kt!.nominal).toBeCloseTo(5, 2); // through water, distinct from SOG
    expect(routed.avg_sog_kt).toBeCloseTo(5 + along, 1);
    expect(audited.findings.legs[0]!.hours.some(h => h.current?.along_kt !== undefined)).toBe(true);
    if (along > 0) expect(audited.findings.evidence.some(e => e.rule_id === 'T-WAC-01')).toBe(true);
    const departures = [departureUtc, '2026-07-20T06:00:00Z'];
    const scan = await scanDepartures({ route, profile, store: store(current), routeFor: (departure) =>
      computeRoute({ ...request, departureUtc: departure, currentGrid: current }).route,
    }, departures);
    expect(scan.skipped).toEqual([]);
    expect(scan.candidates.map(c => c.passage_h)).toEqual(departures.map(() => routed.duration_h));
  });

  it.each(['drawn', 'imported', 'legacy-computed'])('keeps the explicit compatibility behavior for %s routes', async (kind) => {
    const speeds = { slow: 4, nominal: 5, fast: 6 };
    const route: Route = kind === 'imported' ? parseGpx(
      '<gpx><rte><rtept lat="49.5" lon="-3.5"/><rtept lat="49.5" lon="-3.2"/></rte></gpx>',
      { route_id: 'imported', speeds_kt: speeds },
    ) : { schema_version: 1, route_id: kind, name: kind, mode: kind === 'drawn' ? 'user' : 'computed',
      waypoints: [{ id: 'a', ...request.start }, { id: 'b', ...request.finish }], speeds_kt: speeds };
    const current = grid('surface_current', 2, 0);
    const audited = await runAnalysis({ route, profile, departureUtc, store: store(current) });
    const leg = deriveLegs(route)[0]!;
    const along = 2 * Math.sin(leg.bearing_deg_true * Math.PI / 180);
    const expectedSog = kind === 'legacy-computed' ? 5 : 5 + along;
    const hours = (Date.parse(audited.findings.legs[0]!.eta_range.nominal) - Date.parse(departureUtc)) / 3600_000;
    expect(hours).toBeCloseTo(leg.distance_nm / expectedSog, 3);
  });
});

describe('routing arrival horizon', () => {
  const short = { ...request, finish: { lat: 49.5, lon: -3.4 } };
  const duration = haversineNm(short.start.lat, short.start.lon, short.finish.lat, short.finish.lon) / 5;
  it.each([0.001, 0])('accepts arrivals below or exactly at the horizon (%s extra hours)', (extra) => {
    const result = computeRoute({ ...short, maxHours: duration + extra });
    expect(Date.parse(result.arrival_utc) - Date.parse(departureUtc)).toBeLessThanOrEqual((duration + extra) * 3600_000);
    expect(result.route.timing?.basis).toBe('routed');
    if (result.route.timing?.basis === 'routed') {
      expect(result.route.timing.legs.reduce((sum, leg) => sum + leg.duration_ms.nominal, 0))
        // Compare in the same absolute UTC precision used by the search deadline.
        .toBeLessThanOrEqual(Date.parse(departureUtc) + (duration + extra) * 3600_000 - Date.parse(departureUtc));
    }
  });
  it.each([0.1, duration - 0.001])('rejects a terminal edge arriving beyond %s h', (maxHours) => {
    expect(() => computeRoute({ ...short, maxHours })).toThrow('No route found within');
  });
  it('counts both endpoint connections when they snap to the same node', () => {
    const offGrid = { ...request, start: { lat: 49.5, lon: -3.51 }, finish: { lat: 49.5, lon: -3.49 } };
    expect(() => computeRoute({ ...offGrid, maxHours: 0.01 })).toThrow('No route found within');
    const result = computeRoute({ ...offGrid, maxHours: 1 });
    expect(result.duration_h).toBeGreaterThan(0);
  });
  it('rejects an over-budget final endpoint connection after an on-grid start', () => {
    expect(() => computeRoute({ ...request, finish: { lat: 49.5, lon: -3.49 }, maxHours: 0.01 }))
      .toThrow('No route found within');
  });
});
