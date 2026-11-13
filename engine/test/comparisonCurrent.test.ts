/**
 * A departure comparison on the regional (prepared) current grid (owner decision
 * 4 of the Isomar plan, 13 November 2026): when the route is inside the grid's
 * box, the comparison uses the grid for the departures it covers and lists the
 * later ones as not assessed, instead of sending every departure to the tile
 * currents. One source per comparison stays absolute: every assessed departure
 * is on the prepared grid, or every one is on tiles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeRoute, contentHash, rankCandidates, refineScan, routeOnSelectedCurrent, runAnalysis, scanDepartures,
  selectComparisonCurrent, selectRoutingCurrent, MIN_COVERED_SHARE, OUTSIDE_SCAN_CURRENT, OUTSIDE_SELECTED_CURRENT, SearchBoundsError,
} from '../src/index.js';
import type { LimitsProfile, Polar, RegionGrid, Route, RoutingRequest } from '../src/index.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { readFileSync } from 'node:fs';

const T0 = '2026-07-20T00:00:00Z';
const HOUR = 3600_000;
const at = (h: number) => new Date(Date.parse(T0) + h * HOUR).toISOString().replace('.000Z', 'Z');
/** A comparison's 21 departures: every 6 h over 5 days. */
const DEPARTURES = Array.from({ length: 21 }, (_, i) => at(6 * i));
const profile: LimitsProfile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
const polar: Polar = { schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
  tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' } };
const field = (kind: RegionGrid['kind'], u: number, v: number, extra: Partial<RegionGrid> = {}): RegionGrid => ({
  schema_version: 1, kind, run_id: `test-${kind}`, generated_at: T0, lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
  time_axis: [T0, '2026-07-30T00:00:00Z'], u_kt: Array(24).fill(u), v_kt: Array(24).fill(v), source: { mode: 'synthetic' }, ...extra });
const request: Omit<RoutingRequest, 'departureUtc'> = {
  start: { lat: 49.5, lon: -3.5 }, finish: { lat: 49.5, lon: -3.2 }, polar, windGrid: field('wind10m', 0, -12), resolutionDeg: 0.1, maxHours: 48,
};
const tileGrid = field('surface_current', 1, 0, { run_id: 'tile-current' });
const preparedProvenance = { source: 'prepared-artifact', layer: 'currents', model: 'cmems', run_id: 'prepared' };
const hourly = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, h) => at(from + h));
/**
 * An hourly prepared grid over a corridor around the route (0.2° tall, smaller
 * than the box the router would search), with 2 kt of current along the route,
 * from `from` to `to` hours after the first departure.
 */
function regional({ to = 100, from = 0, values }: { to?: number; from?: number; values?: (k: number, t: number) => number | null } = {}, extra: Partial<RegionGrid> = {}): RegionGrid {
  const time_axis = hourly(from, to);
  const shape = { lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3, ...extra };
  const cells = shape.nlat * shape.nlon;
  const u = Array.from({ length: cells * time_axis.length }, (_, k) => (values ? values(k, from + Math.floor(k / cells)) : 2));
  return { ...field('surface_current', 2, 0), run_id: 'prepared', time_axis, u_kt: u, v_kt: Array(u.length).fill(0), ...shape };
}
type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };
const router = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean, searchBounds?: Bounds) =>
  computeRoute({ ...request, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}),
    ...(searchBounds ? { searchBounds } : {}) }));
const compare = (grid: RegionGrid | undefined, route = router, departures = DEPARTURES) =>
  selectComparisonCurrent({ departures, route, tileGrid, prepared: grid, preparedProvenance: grid ? preparedProvenance : undefined });
type Selection = ReturnType<typeof compare>;
const routed = (selection: Selection, departureUtc: string) => {
  const outcome = selection.results.get(departureUtc)!;
  if (!outcome.result) throw outcome.error;
  return outcome.result;
};
function tileStore() {
  const times = Array.from({ length: 241 }, (_, h) => at(h));
  const store = new ScenarioBundleStore({ loadBundle: async name => name === 'forecast' ? { hourly: {
    time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90),
  } } : null });
  vi.spyOn(store, 'getCurrentGrid').mockResolvedValue(tileGrid);
  return store;
}
/** The comparison's audits on the selection's one current input, as the planner runs them. */
const audit = async (selection: Selection, departures = DEPARTURES) => {
  const base = { route: routed(selection, departures[0]!).route, profile, store: tileStore(), now: () => Date.parse(T0),
    currentInput: selection.currentInput, routeFor: (d: string) => routed(selection, d).route };
  return { scan: await scanDepartures(base, departures, undefined, { refinable: true }), base };
};
const strictCalls = () => router.mock.calls.filter(([, , strict]) => strict).map(([departure]) => departure);
const tileCalls = () => router.mock.calls.filter(([, grid]) => grid === tileGrid).map(([departure]) => departure);
const currentsRecord = (scan: { input_records?: Array<{ layer?: string }> }) => scan.input_records?.find(x => x.layer === 'currents');

beforeEach(() => {
  router.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => { vi.useRealTimers(); });

describe('a computed comparison on a regional grid of about 4 days', () => {
  it('assesses the departures the grid covers on it, lists the later ones as not assessed, and ranks only the assessed', async () => {
    const grid = regional({ to: 103 });
    const selection = compare(grid);
    expect(selection.currentInput.grid).toBe(grid);
    expect(selection.currentInput.provenance).toMatchObject({ ...preparedProvenance, current_source: 'prepared', content_digest: contentHash(grid) });
    expect(selection.currentInput.provenance).not.toHaveProperty('fallback_reason');
    const covered = DEPARTURES.slice(0, 17); // 0 to 96 h; a passage of about 2 h
    const left = DEPARTURES.slice(17); // 102 h departs inside the 103 h axis and its passage outlasts it; 108 to 120 h depart after it
    for (const departure of covered) {
      expect(routed(selection, departure).route.provenance?.routing_request).toMatchObject({
        current_source: 'prepared', current_digest: contentHash(grid), search_bounds: expect.any(Object) });
    }
    for (const departure of left) expect(String(selection.results.get(departure)!.error)).toContain(OUTSIDE_SCAN_CURRENT);
    expect(selection.currentInput.coverage).toEqual({ last_covered_utc: at(96), not_covered: left });
    // Uncovered in time before routing: departures after the axis end are never routed; nothing on tiles.
    expect(strictCalls()).toEqual(DEPARTURES.slice(0, 18));
    expect(tileCalls()).toEqual([]);

    const { scan } = await audit(selection);
    expect(scan.candidates.map(c => c.departure_utc)).toEqual(covered);
    expect(scan.skipped).toEqual(left.map(departure_utc => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })));
    expect(currentsRecord(scan)).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid), run_id: 'prepared' });
    expect(scan.best_index).toBe(rankCandidates(scan.candidates, { mode: 'typical' }).best_index);
    expect(scan.candidates[0]!.delta).toEqual(expect.objectContaining({ peak_gust_kt: 15 })); // the first assessed time is the baseline
    expect(scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 4 });
  });

  it('gives the first departure exactly the route and current input a Compute gives', () => {
    const grid = regional();
    const comparison = compare(grid);
    const computed = selectRoutingCurrent({ departures: [DEPARTURES[0]!], route: router, tileGrid, prepared: grid, preparedProvenance });
    expect(JSON.stringify(comparison.results.get(DEPARTURES[0]!))).toBe(JSON.stringify(computed.results.get(DEPARTURES[0]!)));
    expect(JSON.stringify(comparison.results.get(DEPARTURES[0]!)!.result!.route)).toContain('"search_bounds"');
    const { coverage, ...input } = comparison.currentInput;
    expect(coverage).toBeDefined();
    expect(JSON.stringify(input)).toBe(JSON.stringify(computed.currentInput));
  });

  it('a Check of a picked candidate admits the same grid by its digest', async () => {
    const grid = regional();
    const picked = routed(compare(grid), at(48)).route;
    const store = tileStore();
    const check = await runAnalysis({ route: picked, profile, departureUtc: at(48), store, currentGrid: grid, currentGridProvenance: preparedProvenance,
      now: () => Date.parse(T0) });
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
    expect(check.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')).toMatchObject({
      current_source: 'prepared', content_digest: contentHash(grid), time_step_h: 1 });
  });

  it('refines on the same grid only: added times it covers carry its digest, the others are listed as not assessed', async () => {
    const grid = regional();
    const selection = compare(grid);
    const { scan: coarse, base } = await audit(selection);
    const added = new Map<string, Route>();
    const refined = await refineScan({ ...base, routeFor: (d: string) => {
      const outcome = routeOnSelectedCurrent({ departures: [d], currentInput: selection.currentInput, route: router }).get(d)!;
      if (!outcome.result) throw outcome.error;
      added.set(d, outcome.result.route);
      return outcome.result.route;
    } }, coarse);
    expect(refined.refined_departures.length).toBeGreaterThan(0);
    for (const route of added.values()) {
      expect(route.provenance?.routing_request).toMatchObject({ current_source: 'prepared', current_digest: contentHash(grid) });
    }
    const assessed = refined.candidates.map(c => c.departure_utc);
    for (const departure of refined.refined_departures) {
      const skip = refined.skipped.find(s => s.departure_utc === departure);
      expect(Boolean(skip) !== assessed.includes(departure)).toBe(true);
      if (skip) expect([OUTSIDE_SCAN_CURRENT, OUTSIDE_SELECTED_CURRENT]).toContain(skip.reason);
    }
    // Uniform weather ties every time, so times are added up to 120 h; the grid ends at 100 h.
    const last = assessed.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    expect(Date.parse(last)).toBeGreaterThan(Date.parse(at(96)));
    expect(Date.parse(last)).toBeLessThan(Date.parse(at(100)));
    expect(refined.skipped.map(s => s.departure_utc)).toContain(at(100));
    expect(refined.current_reach).toEqual({ last_departure_utc: last, not_covered: refined.skipped.filter(sk =>
      sk.reason === OUTSIDE_SCAN_CURRENT || sk.reason === OUTSIDE_SELECTED_CURRENT).length });
    expect(refined.current_reach!.not_covered).toBeGreaterThan(4); // the coarse four and the refined times past the grid
    expect(currentsRecord(refined)).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid) });
    expect(tileCalls()).toEqual([]);
  });
});

describe('when the comparison stays on tiles for every departure', () => {
  /** Every departure routed again on tiles over the normal area, with the recorded reason. */
  const expectTiles = (selection: Selection, reason: string) => {
    expect(selection.currentInput.grid).toBe(tileGrid);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles', rejected_prepared_run_id: 'prepared', fallback_reason: reason });
    expect(selection.currentInput).not.toHaveProperty('coverage');
    expect(tileCalls()).toEqual(DEPARTURES);
    for (const departure of DEPARTURES) {
      expect(routed(selection, departure).route.provenance?.routing_request).not.toHaveProperty('current_source');
    }
  };

  it('the first departure is before the grid starts: nothing is routed on the grid', () => {
    expectTiles(compare(regional({ from: 1 })), 'prepared grid does not cover every departure time');
    expect(strictCalls()).toEqual([]);
  });

  it(`fewer than ${MIN_COVERED_SHARE * 100} % of the departures depart inside the grid: decided before any routing`, () => {
    expectTiles(compare(regional({ to: 50 })), 'prepared grid covers fewer than half of the departure times'); // 9 of 21
    expect(strictCalls()).toEqual([]);
  });

  it('fewer than half are covered once routed: 11 depart inside, the 11th runs past the end', () => {
    expectTiles(compare(regional({ to: 61 })), 'prepared grid covers fewer than half of the departure times');
    expect(strictCalls()).toEqual(DEPARTURES.slice(0, 11));
  });

  it('stops routing on the grid as soon as half can no longer be covered', () => {
    // From 6 h on, no route exists inside the box. 17 departures depart inside the axis: after the
    // 7th failure (42 h), 1 covered plus 9 left cannot reach 11, so 48 h onwards is never routed on the grid.
    const blocked = vi.fn((d: string, grid: RegionGrid | undefined, strict: boolean, bounds?: Bounds) => {
      if (strict && d !== DEPARTURES[0]) throw new SearchBoundsError('no-route');
      return router(d, grid, strict, bounds);
    });
    const selection = compare(regional(), blocked);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles', fallback_reason: 'prepared grid covers fewer than half of the departure times' });
    expect(blocked.mock.calls.filter(([, , strict]) => strict).map(([d]) => d)).toEqual(DEPARTURES.slice(0, 8));
  });

  it('the first departure finds no route on the grid', () => {
    const failing = vi.fn((d: string, grid: RegionGrid | undefined, strict: boolean, bounds?: Bounds) => {
      if (strict && d === DEPARTURES[0]) throw new Error('No route found within 48 h (wind coverage, land, or no-go conditions)');
      return router(d, grid, strict, bounds);
    });
    const selection = compare(regional(), failing);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles', fallback_reason: 'first departure time has no route on the prepared grid' });
    expect(failing.mock.calls.filter(([, , strict]) => strict)).toHaveLength(1);
  });

  it('the first departure finds no route inside the box', () => {
    const walled = vi.fn((d: string, grid: RegionGrid | undefined, strict: boolean, bounds?: Bounds) => {
      if (strict && d === DEPARTURES[0]) throw new SearchBoundsError('no-route');
      return router(d, grid, strict, bounds);
    });
    expectTiles(compare(regional(), walled), 'no route found inside the prepared grid');
  });

  it('a model cell without a value where a later departure\'s router reads (at a time the grid covers)', () => {
    // No value anywhere at 30 and 31 h: the 30 h departure reads it, the earlier ones never do.
    expectTiles(compare(regional({ values: (_, t) => (t === 30 || t === 31 ? null : 2) })), 'router read a point or time outside the prepared grid');
    expect(strictCalls()).toEqual(DEPARTURES.slice(0, 6));
  });

  it('an end of the route is outside the grid, as before', () => {
    expectTiles(compare(regional({}, { nlon: 2 })), 'router read a point or time outside the prepared grid');
  });
});

describe('a covered departure that cannot be routed on the grid', () => {
  it('is not assessed with its own reason, and the others stay on the grid', async () => {
    const noRouteInside = new SearchBoundsError('no-route');
    const plain = new Error('No route found within 48 h (wind coverage, land, or no-go conditions)');
    const failing = vi.fn((d: string, grid: RegionGrid | undefined, strict: boolean, bounds?: Bounds) => {
      if (d === at(24)) throw noRouteInside;
      if (d === at(30)) throw plain;
      return router(d, grid, strict, bounds);
    });
    const grid = regional();
    const selection = compare(grid, failing);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid) });
    expect(selection.results.get(at(24))!.error).toBe(noRouteInside);
    expect(selection.results.get(at(30))!.error).toBe(plain);
    expect(routed(selection, at(36)).route.provenance?.routing_request).toMatchObject({ current_source: 'prepared' });
    expect(failing.mock.calls.some(([, used]) => used === tileGrid)).toBe(false);
    const { scan } = await audit(selection);
    expect(scan.skipped).toEqual([
      { departure_utc: at(24), reason: noRouteInside.message },
      { departure_utc: at(30), reason: plain.message },
      ...DEPARTURES.slice(17).map(departure_utc => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })),
    ]);
    expect(scan.candidates).toHaveLength(15);
  });
});

describe('a computed comparison the grid covers entirely', () => {
  it('is what one selection over every departure gave before, with no coverage recorded', async () => {
    const grid = regional({ to: 130 });
    const comparison = compare(grid);
    const before = selectRoutingCurrent({ departures: DEPARTURES, route: router, tileGrid, prepared: grid, preparedProvenance });
    expect(JSON.stringify([...comparison.results])).toBe(JSON.stringify([...before.results]));
    expect(comparison.currentInput).toEqual(before.currentInput);
    expect(comparison.currentInput).not.toHaveProperty('coverage');
    const { scan } = await audit(comparison);
    expect(scan.candidates).toHaveLength(21);
    expect(scan).not.toHaveProperty('current_reach');
  });
});

describe('a drawn-route comparison', () => {
  // The route's own speeds: 11.7 nm at 4 kt is about 2.9 h to the slow arrival.
  const drawn: Route = { schema_version: 1, route_id: 'drawn', name: 'Drawn', mode: 'user',
    waypoints: [{ id: 'a', lat: 49.5, lon: -3.5 }, { id: 'b', lat: 49.5, lon: -3.2 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } };
  const scanOn = async (grid: RegionGrid) => {
    const store = tileStore();
    const scan = await scanDepartures({ route: drawn, profile, store, now: () => Date.parse(T0), currentGrid: grid, currentGridProvenance: preparedProvenance },
      DEPARTURES, undefined, { refinable: true });
    return { scan, store };
  };

  it('uses the grid for the departures it covers and lists the later ones as not assessed', async () => {
    const grid = regional();
    const { scan, store } = await scanOn(grid);
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
    expect(scan.candidates.map(c => c.departure_utc)).toEqual(DEPARTURES.slice(0, 17));
    expect(scan.skipped).toEqual(DEPARTURES.slice(17).map(departure_utc => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })));
    expect(currentsRecord(scan)).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid) });
    expect(scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 4 });
    expect(scan.refinement.current_input.coverage).toEqual({ last_covered_utc: at(96), not_covered: DEPARTURES.slice(17) });
  });

  it('leaves out a departure earlier than the last covered one when its own passage outlasts the grid', async () => {
    // 2.6 kt against the route from 88 to 95 h, 3 kt with it otherwise: the 90 h departure makes 1.4 kt at the
    // slow end and arrives at about 98.4 h, past the 98 h grid; the 96 h one arrives at about 97.7 h.
    const { scan } = await scanOn(regional({ to: 98, values: (_, t) => (t >= 88 && t <= 95 ? -2.6 : 3) }));
    const left = [at(90), at(102), at(108), at(114), at(120)];
    expect(scan.refinement.current_input.coverage).toEqual({ last_covered_utc: at(96), not_covered: left });
    expect(scan.skipped).toEqual(left.map(departure_utc => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })));
    expect(scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 5 });
    expect(currentsRecord(scan)).toMatchObject({ current_source: 'prepared' });
  });

  it.each([
    ['the first departure is not covered', regional({ from: 1 }), 'prepared grid does not cover every route/time sample'],
    ['fewer than half are covered', regional({ to: 50 }), 'prepared grid covers fewer than half of the departure times'],
    ['a model cell has no value on the route at a time the grid covers', regional({ values: (_, t) => (t === 31 ? null : 2) }),
      'prepared grid does not cover every route/time sample'],
  ])('uses tiles for every departure when %s', async (_, grid, reason) => {
    const { scan, store } = await scanOn(grid);
    expect(store.getCurrentGrid).toHaveBeenCalledOnce();
    expect(scan.candidates).toHaveLength(21);
    expect(scan.skipped).toEqual([]);
    expect(currentsRecord(scan)).toMatchObject({ current_source: 'tiles', run_id: 'tile-current', fallback_reason: reason, rejected_prepared_run_id: 'prepared' });
    expect(scan).not.toHaveProperty('current_reach');
  });

  it('uses the grid for every departure, as before, when it covers them all', async () => {
    const { scan, store } = await scanOn(regional({ to: 130 }));
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
    expect(scan.candidates).toHaveLength(21);
    expect(scan).not.toHaveProperty('current_reach');
    expect(scan.refinement.current_input).not.toHaveProperty('coverage');
  });
});
