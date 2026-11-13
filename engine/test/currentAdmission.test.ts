import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, GridSampler, scanDepartures, computeRoute, selectRoutingCurrent, routeOnSelectedCurrent, contentHash, routeRevision } from '../src/index.js';
import type { RegionGrid, Route, LimitsProfile, Polar, RoutingRequest, LandMask } from '../src/index.js';
import { currentGridCovers } from '../src/currentInput.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const departureUtc = '2026-07-20T06:00:00Z';
const profile: LimitsProfile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
const route: Route = { schema_version: 1, route_id: 'med', name: 'Med', mode: 'user',
  waypoints: [{ id: 'a', lat: 40, lon: 3 }, { id: 'b', lat: 40, lon: 3.1 }],
  speeds_kt: { slow: 4, nominal: 5, fast: 6 } };
const grid = (extra: Partial<RegionGrid> = {}): RegionGrid => ({
  schema_version: 1, kind: 'surface_current', run_id: 'tile-current', generated_at: departureUtc,
  lat0: 39, lon0: 2, dlat: 1, dlon: 1, nlat: 3, nlon: 3,
  time_axis: ['2026-07-20T00:00:00Z', '2026-07-30T00:00:00Z'],
  u_kt: Array(18).fill(0), v_kt: Array(18).fill(0), source: { mode: 'live', dataset_id: 'tile-cmems' }, ...extra,
});
function store(current: RegionGrid | null = grid()) {
  const times = Array.from({ length: 241 }, (_, h) => new Date(Date.parse('2026-07-20T00:00Z') + h * 3600_000).toISOString());
  const store = new ScenarioBundleStore({ loadBundle: async name => name === 'forecast' ? { hourly: {
    time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90),
  } } : null });
  vi.spyOn(store, 'getCurrentGrid').mockResolvedValue(current);
  return store;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateRoute = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/route.schema.json', import.meta.url), 'utf8')));
const coverage = (findings: Awaited<ReturnType<typeof runAnalysis>>['findings']) => findings.coverage!.find(x => x.capability === 'tidal_currents')!;

it.each([
  ['outside Channel', { lat0: 49, lon0: -5 }],
  ['expired', { time_axis: ['2026-07-18T00:00Z', '2026-07-19T00:00Z'] }],
  ['all missing', { u_kt: Array(18).fill(null) }],
  ['nonfinite', { u_kt: Array(18).fill(NaN) }],
  ['partly missing', { time_axis: ['2026-07-20T06:00Z', '2026-07-20T07:00Z'] }],
] as Array<[string, Partial<RegionGrid>]>)('replaces %s prepared currents for the whole check', async (_, extra) => {
  const tiles = store();
  const result = await runAnalysis({ route, profile, departureUtc, store: tiles, currentGrid: grid({ run_id: 'prepared', ...extra }) });
  expect(tiles.getCurrentGrid).toHaveBeenCalledOnce();
  expect(result.findings.legs.flatMap(l => l.hours).every(h => h.current !== null)).toBe(true);
  expect(result.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')?.run_id).toBe('tile-current');
});

it('never claims assessment for a zero-sample tile grid', async () => {
  const result = await runAnalysis({ route, profile, departureUtc, store: store(grid({ u_kt: Array(18).fill(null) })) });
  expect(coverage(result.findings).status).toBe('not_assessed');
});
it('reports partial coverage from actual hours without an under-resolution note', async () => {
  const result = await runAnalysis({ route, profile, departureUtc, store: store(grid({ time_axis: ['2026-07-20T06:00Z', '2026-07-20T07:00Z'] })) });
  expect(coverage(result.findings).status).toBe('partially_assessed');
});
it('does not extrapolate a wet boundary cell outside the grid', () => {
  const sample = new GridSampler(grid());
  expect(sample.sample(38.9, 3, Date.parse(departureUtc))).toBeNull();
  expect(sample.sample(40, 1.9, Date.parse(departureUtc))).toBeNull();
  expect(sample.sample(40, 3, Date.parse(departureUtc))).toEqual({ u_kt: 0, v_kt: 0 });
});
it('chooses tile currents once for every scan candidate if any candidate lacks prepared coverage', async () => {
  const tiles = store();
  const scan = await scanDepartures({ route, profile, store: tiles,
    currentGrid: grid({ run_id: 'prepared', time_axis: ['2026-07-20T00:00Z', '2026-07-20T12:00Z'] }),
  }, [departureUtc, '2026-07-21T06:00:00Z']);
  expect(tiles.getCurrentGrid).toHaveBeenCalledOnce();
  expect(scan.input_records?.find(x => x.layer === 'currents')).toMatchObject({ run_id: 'tile-current', current_source: 'tiles' });
});

// Routing admission (C1 phase 1): Compute and computed scans route on the
// prepared grid only when the router itself never meets a gap in it and every
// routed candidate passes the audit's own coverage test. Otherwise the whole
// action routes and audits on tile currents.
describe('prepared currents for routing', () => {
  const routedDeparture = '2026-07-20T00:00:00Z';
  const polar: Polar = {
    schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
    tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' },
  };
  const regionGrid = (kind: RegionGrid['kind'], u: number, extra: Partial<RegionGrid> = {}): RegionGrid => ({
    schema_version: 1, kind, run_id: `test-${kind}`, generated_at: routedDeparture,
    lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
    time_axis: [routedDeparture, '2026-07-30T00:00:00Z'],
    u_kt: Array(24).fill(u), v_kt: Array(24).fill(kind === 'wind10m' ? -12 : 0), source: { mode: 'synthetic' }, ...extra,
  });
  const request: Omit<RoutingRequest, 'departureUtc'> = {
    start: { lat: 49.5, lon: -3.5 }, finish: { lat: 49.5, lon: -3.2 },
    polar, windGrid: regionGrid('wind10m', 0), resolutionDeg: 0.1, maxHours: 48,
  };
  const tileGrid = regionGrid('surface_current', 1, { run_id: 'tile-current' });
  const prepared = (extra: Partial<RegionGrid> = {}) => regionGrid('surface_current', 2, { run_id: 'prepared', ...extra });
  const preparedProvenance = { source: 'prepared-artifact', layer: 'currents', model: 'cmems', run_id: 'prepared' };
  // A corridor around the route itself, narrower than the box the router explores.
  const corridor = () => prepared({ lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3,
    u_kt: Array(18).fill(2), v_kt: Array(18).fill(0) });
  const router = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) =>
    computeRoute({ ...request, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}) }));
  const select = (grid: RegionGrid | undefined, departures = [routedDeparture]) =>
    selectRoutingCurrent({ departures, route: router, tileGrid, prepared: grid, preparedProvenance: grid ? preparedProvenance : undefined });
  const routed = (selection: ReturnType<typeof select>, departureUtc = routedDeparture) => {
    const outcome = selection.results.get(departureUtc)!;
    if (!outcome.result) throw outcome.error;
    return outcome.result;
  };
  const checkCurrents = async (route: Route, grid: RegionGrid) => {
    const tiles = store(tileGrid);
    const result = await runAnalysis({ route, profile, departureUtc: routedDeparture, store: tiles, currentGrid: grid, currentGridProvenance: preparedProvenance });
    return { tiles, record: result.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')! };
  };
  beforeEach(() => { router.mockClear(); });

  it('routes and then checks on the prepared grid when the router never leaves it', async () => {
    const grid = prepared();
    const selection = select(grid);
    expect(selection.currentInput.grid).toBe(grid);
    expect(selection.currentInput.provenance).toMatchObject({ ...preparedProvenance, current_source: 'prepared', content_digest: contentHash(grid) });
    const result = routed(selection);
    expect(result.avg_sog_kt).toBeCloseTo(7, 1); // 5 kt boat with 2 kt prepared current along
    expect(result.route.provenance?.routing_request).toMatchObject({ current_run: 'prepared', current_source: 'prepared', current_digest: contentHash(grid) });
    const { tiles, record } = await checkCurrents(result.route, grid);
    expect(tiles.getCurrentGrid).not.toHaveBeenCalled();
    expect(record).toMatchObject({ run_id: 'prepared', current_source: 'prepared', content_digest: contentHash(grid) });
  });

  it('routes on tiles when the router would leave the prepared corridor, and its Check stays on tiles', async () => {
    const grid = corridor();
    const plain = computeRoute({ ...request, departureUtc: routedDeparture });
    expect(currentGridCovers(grid, { route: plain.route, departureUtc: routedDeparture })).toBe(true); // the audit alone would admit it
    const selection = select(grid);
    expect(selection.currentInput.grid).toBe(tileGrid);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles', rejected_prepared_run_id: 'prepared',
      fallback_reason: 'router read a point or time outside the prepared grid' });
    const result = routed(selection);
    expect(result.avg_sog_kt).toBeCloseTo(6, 1); // tile current, never a mix with zero
    expect(result.route.provenance?.routing_request).not.toHaveProperty('current_source');
    const { record } = await checkCurrents(result.route, grid);
    expect(record).toMatchObject({ run_id: 'tile-current', current_source: 'tiles', fallback_reason: 'route was computed on tile currents' });
  });

  it('routes on tiles when the prepared time axis ends during the search', () => {
    const selection = select(prepared({ time_axis: [routedDeparture, '2026-07-20T00:30:00Z'] }));
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles',
      fallback_reason: 'router read a point or time outside the prepared grid' });
    expect(routed(selection).avg_sog_kt).toBeCloseTo(6, 1);
  });

  it('does not route on a prepared grid that starts after the departure', () => {
    const selection = select(prepared({ time_axis: ['2026-07-20T01:00:00Z', '2026-07-30T00:00:00Z'] }));
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles',
      fallback_reason: 'prepared grid does not cover every departure time' });
    expect(router.mock.calls.map(([, grid]) => grid)).toEqual([tileGrid]);
  });

  it.each([
    ['missing', null],
    ['non-finite', NaN],
  ])('routes on tiles when the prepared grid has %s samples where the router reads', (_, bad) => {
    const selection = select(prepared({ u_kt: [...Array(12).fill(2), ...Array(12).fill(bad)] }));
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles' });
    expect(routed(selection).avg_sog_kt).toBeCloseTo(6, 1);
  });

  it('routes on tiles when a routed arrival range runs past the prepared grid', () => {
    const full = routed(select(prepared()));
    const timing = full.route.timing!;
    const nominalMs = timing.basis === 'routed' ? timing.legs.reduce((sum, leg) => sum + leg.duration_ms.nominal, 0) : NaN;
    // The router's own reads end at the nominal arrival; the audit reads to the slow arrival.
    const end = new Date(Date.parse(routedDeparture) + nominalMs + 60_000).toISOString();
    const selection = select(prepared({ time_axis: [routedDeparture, end] }));
    // Routed without a gap, then rejected by the audit's own coverage test.
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles',
      fallback_reason: 'prepared grid does not cover every route/time sample' });
    expect(router.mock.calls.map(([, grid]) => grid === tileGrid)).toEqual([false, false, true]);
  });

  it('keeps one source for every computed scan candidate and every audit', async () => {
    const departures = [routedDeparture, '2026-07-20T06:00:00Z'];
    // The second candidate's search runs past the prepared grid: both candidates move to tiles.
    const selection = select(prepared({ time_axis: [routedDeparture, '2026-07-20T06:30:00Z'] }), departures);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles' });
    for (const departureUtc of departures) {
      expect(routed(selection, departureUtc).avg_sog_kt).toBeCloseTo(6, 1);
      expect(routed(selection, departureUtc).route.provenance?.routing_request).toMatchObject({ current_run: 'tile-current' });
    }
    const tiles = store(tileGrid);
    const scan = await scanDepartures({ route, profile, store: tiles, currentInput: selection.currentInput,
      routeFor: departureUtc => routed(selection, departureUtc).route }, departures);
    expect(scan.skipped).toEqual([]);
    expect(tiles.getCurrentGrid).not.toHaveBeenCalled();
    expect(scan.input_records?.find(x => x.layer === 'currents')).toMatchObject({ run_id: 'tile-current', current_source: 'tiles' });

    const covering = select(prepared(), departures);
    expect(covering.currentInput.provenance).toMatchObject({ current_source: 'prepared' });
    expect(departures.map(d => routed(covering, d).route.provenance?.routing_request)).toEqual(departures.map(() =>
      expect.objectContaining({ current_source: 'prepared' })));
  });

  it('audits a computed route on tiles when it was routed on another prepared grid', async () => {
    const result = routed(select(prepared()));
    const { record } = await checkCurrents(result.route, prepared({ u_kt: Array(24).fill(1.5) }));
    expect(record).toMatchObject({ current_source: 'tiles', run_id: 'tile-current', fallback_reason: 'route was computed on another current grid' });
  });

  it('records why a route computed on the prepared grid is checked on tiles when that grid is unavailable', async () => {
    const result = routed(select(prepared()));
    const tiles = store(tileGrid);
    const check = await runAnalysis({ route: result.route, profile, departureUtc: routedDeparture, store: tiles });
    expect(check.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')).toMatchObject({
      current_source: 'tiles', run_id: 'tile-current', fallback_reason: 'prepared grid the route was computed on is unavailable',
    });
  });

  it('records a route computed without currents as such when its Check rejects a prepared grid', async () => {
    const result = computeRoute({ ...request, departureUtc: routedDeparture });
    expect(result.route.provenance?.routing_request).toMatchObject({ current_run: null });
    const { record } = await checkCurrents(result.route, prepared());
    expect(record).toMatchObject({ current_source: 'tiles', fallback_reason: 'route was computed without currents' });
  });

  it('keeps the prepared grid when a departure fails for a reason other than a current gap', () => {
    const late = '2026-07-20T06:00:00Z';
    const failing = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) =>
      computeRoute({ ...request, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}),
        ...(departureUtc === late ? { maxHours: 0.1 } : {}) }));
    const selection = selectRoutingCurrent({ departures: [routedDeparture, late], route: failing, tileGrid,
      prepared: prepared(), preparedProvenance });
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'prepared' });
    expect(routed(selection).route.provenance?.routing_request).toMatchObject({ current_source: 'prepared' });
    expect(String(selection.results.get(late)!.error)).toMatch(/No route found within 0.1 h/);
    expect(failing).toHaveBeenCalledTimes(2); // never rerouted on tiles
  });

  it('treats an error carrying the current-gap code as a gap', () => {
    const gap = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) => {
      if (strictCurrent) throw Object.assign(new Error('gap from another copy of the engine'), { code: 'current-gap' });
      return computeRoute({ ...request, departureUtc, ...(currentGrid ? { currentGrid } : {}) });
    });
    const selection = selectRoutingCurrent({ departures: [routedDeparture], route: gap, tileGrid, prepared: prepared(), preparedProvenance });
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles' });
    expect(routed(selection).avg_sog_kt).toBeCloseTo(6, 1);
  });

  // The router clipped to the prepared grid (C1, 2026-11-13): the router passes the bounds it is given
  // on to computeRoute, as the planner's does. A router that ignores them is routed as before (above).
  type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };
  const boundedRouter = (extra: Partial<RoutingRequest> = {}) =>
    vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean, searchBounds?: Bounds) =>
      computeRoute({ ...request, ...extra, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}),
        ...(searchBounds ? { searchBounds } : {}) } as RoutingRequest));
  const clipRouter = boundedRouter();
  const selectClipped = (grid: RegionGrid | undefined, departures = [routedDeparture]) =>
    selectRoutingCurrent({ departures, route: clipRouter, tileGrid, prepared: grid, preparedProvenance: grid ? preparedProvenance : undefined });
  const hourly = (hours: number) => Array.from({ length: hours + 1 }, (_, h) =>
    new Date(Date.parse(routedDeparture) + h * 3600_000).toISOString().replace('.000Z', 'Z'));
  // An hourly corridor around the route, 0.2° tall: smaller than the 1°×1.5° box the router searches.
  const hourlyCorridor = (extra: Partial<RegionGrid> = {}, hours = 48) => {
    const time_axis = hourly(hours);
    const shape = { lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3, ...extra };
    const cells = shape.nlat * shape.nlon * time_axis.length;
    return prepared({ time_axis, u_kt: Array(cells).fill(2), v_kt: Array(cells).fill(0), ...shape });
  };
  const inBox = (grid: RegionGrid, p: { lat: number; lon: number }) =>
    new GridSampler({ ...grid, time_axis: [grid.time_axis[0]!, grid.time_axis.at(-1)!],
      u_kt: Array(2 * grid.nlat * grid.nlon).fill(0), v_kt: Array(2 * grid.nlat * grid.nlon).fill(0) })
      .sample(p.lat, p.lon, Date.parse(grid.time_axis[0]!)) !== null;
  /** Every point at which the router or the audit read this grid. */
  const readsOf = (grid: RegionGrid, run: () => void) => {
    const reads: Array<{ lat: number; lon: number }> = [];
    const original = GridSampler.prototype.sample;
    GridSampler.prototype.sample = function (this: GridSampler, lat: number, lon: number, time: number) {
      if ((this as unknown as { grid: RegionGrid }).grid === grid) reads.push({ lat, lon });
      return original.call(this, lat, lon, time);
    };
    try { run(); } finally { GridSampler.prototype.sample = original; }
    return reads;
  };
  beforeEach(() => { clipRouter.mockClear(); });

  it('routes inside a prepared grid smaller than the router\'s box, records the clip, and its Check uses the same grid hourly', async () => {
    const grid = hourlyCorridor();
    let selection!: ReturnType<typeof selectClipped>;
    const reads = readsOf(grid, () => { selection = selectClipped(grid); });
    expect(selection.currentInput.grid).toBe(grid);
    expect(selection.currentInput.provenance).toMatchObject({ ...preparedProvenance, current_source: 'prepared', content_digest: contentHash(grid) });
    expect(selection.currentInput.provenance).not.toHaveProperty('fallback_reason');
    const result = routed(selection);
    expect(result.avg_sog_kt).toBeCloseTo(7, 1); // 5 kt boat with 2 kt prepared current along
    // The nodes searched: 49.6 is the grid's edge on paper, but GridSampler reads (49.6 - 49.4) / 0.1 as just over 2.
    expect(result.route.provenance?.routing_request).toMatchObject({ current_run: 'prepared', current_source: 'prepared',
      current_digest: contentHash(grid), search_bounds: { minLat: 49.4, maxLat: 49.5, minLon: -3.5, maxLon: -3.2 } });
    // the router was given the grid's box, and neither it nor the audit read the grid outside it
    expect(clipRouter).toHaveBeenCalledOnce();
    expect(clipRouter.mock.calls[0]![3]).toMatchObject({ minLon: -3.55 });
    expect(reads.length).toBeGreaterThan(10);
    expect(reads.every(p => inBox(grid, p))).toBe(true);
    expect(result.route.waypoints.every(p => inBox(grid, p))).toBe(true);
    // its Check admits the same grid, by the same digest, and records its hourly step
    const { tiles, record } = await checkCurrents(result.route, grid);
    expect(tiles.getCurrentGrid).not.toHaveBeenCalled();
    expect(record).toMatchObject({ run_id: 'prepared', current_source: 'prepared', content_digest: contentHash(grid), time_step_h: 1 });
  });

  /** The tile fallback: every departure routed again, not strict and not confined. */
  const expectUnclippedTiles = (selection: ReturnType<typeof selectClipped>, reason: string, departures = [routedDeparture], used = clipRouter) => {
    expect(selection.currentInput.grid).toBe(tileGrid);
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'tiles', rejected_prepared_run_id: 'prepared', fallback_reason: reason });
    expect(used.mock.calls.filter(([, grid]) => grid === tileGrid).map(call => call.slice(1))).toEqual(departures.map(() => [tileGrid, false]));
    for (const departureUtc of departures) {
      const request = routed(selection, departureUtc).route.provenance?.routing_request;
      expect(request).toMatchObject({ current_run: 'tile-current' });
      expect(request).not.toHaveProperty('search_bounds');
      expect(request).not.toHaveProperty('current_source');
    }
  };

  it('routes on tiles over the normal area, as before, when an end of the route is outside the prepared grid', () => {
    const grid = hourlyCorridor({ nlon: 2 }); // -3.55 to -3.35: the finish at -3.2 is outside
    const selection = selectClipped(grid);
    expectUnclippedTiles(selection, 'router read a point or time outside the prepared grid');
    expect(clipRouter).toHaveBeenCalledTimes(2);
    expect(routed(selection).avg_sog_kt).toBeCloseTo(6, 1);
  });

  it.each([
    ['starts after the departure', () => hourlyCorridor({ time_axis: hourly(48).slice(1) }), 'prepared grid does not cover every departure time'],
    ['ends during the search', () => hourlyCorridor({}, 1), 'router read a point or time outside the prepared grid'],
  ])('routes on tiles over the normal area when the prepared grid %s', (_, grid, reason) => {
    expectUnclippedTiles(selectClipped(grid()), reason);
  });

  it('routes on tiles over the normal area when land closes the prepared grid, and that route may leave it', () => {
    // A wall across the corridor's whole height, open to the north and south of it.
    const mask: LandMask = { schema_version: 1, kind: 'land_mask', lat0: 49, lon0: -4, dlat: 0.05, dlon: 0.05, nlat: 21, nlon: 31,
      land: Array.from({ length: 21 * 31 }, (_, k) => {
        const i = Math.floor(k / 31);
        return k % 31 === 13 && i >= 6 && i <= 14 ? 1 : 0; // lon -3.35, lat 49.3 to 49.7
      }) };
    const walled = boundedRouter({ landMask: mask });
    const grid = hourlyCorridor();
    const selection = selectRoutingCurrent({ departures: [routedDeparture], route: walled, tileGrid, prepared: grid, preparedProvenance });
    expectUnclippedTiles(selection, 'no route found inside the prepared grid', [routedDeparture], walled);
    expect(walled.mock.calls[0]![3]).toBeDefined(); // the first try was confined
    expect(walled).toHaveBeenCalledTimes(2);
    expect(routed(selection).route.waypoints.some(p => !inBox(grid, p))).toBe(true); // the detour leaves the grid
  });

  it('routes on tiles when the prepared grid has no value where the confined router reads: never as calm water', () => {
    // 0.05° columns; -3.45 to -3.25 have no value, across the corridor's whole height and every hour.
    const grid = hourlyCorridor({ dlon: 0.05, nlon: 9 });
    const u = grid.u_kt.map((value, k) => (k % 9 >= 2 && k % 9 <= 6 ? null : value));
    expectUnclippedTiles(selectClipped({ ...grid, u_kt: u }), 'router read a point or time outside the prepared grid');
  });

  it('gives a route the prepared grid admitted before exactly as before, with nothing new recorded', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(routedDeparture));
      const grid = prepared(); // the whole box the router searches
      const before = select(grid); // a router that ignores the bounds: the earlier routing
      const after = selectClipped(grid);
      expect(clipRouter.mock.calls[0]![3]).toBeDefined();
      expect(JSON.stringify([...after.results])).toBe(JSON.stringify([...before.results]));
      expect(after.currentInput).toEqual(before.currentInput);
      expect(routed(after).route.provenance?.routing_request).not.toHaveProperty('search_bounds');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records nothing and changes nothing when everything outside a smaller prepared grid is land the router never enters', () => {
    // Sea only inside the corridor (as land north of Plymouth lies outside the live grid): the search never meets the box.
    const mask: LandMask = { schema_version: 1, kind: 'land_mask', lat0: 49, lon0: -4, dlat: 0.05, dlon: 0.05, nlat: 21, nlon: 31,
      land: Array.from({ length: 21 * 31 }, (_, k) => {
        const lat = 49 + Math.floor(k / 31) * 0.05, lon = -4 + (k % 31) * 0.05;
        return lat > 49.38 && lat < 49.57 && lon > -3.57 && lon < -3.13 ? 0 : 1;
      }) };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(routedDeparture));
      const grid = hourlyCorridor();
      const ignoring = boundedRouter({ landMask: mask });
      const before = selectRoutingCurrent({ departures: [routedDeparture], route: (d, g, strict) => ignoring(d, g, strict), tileGrid, prepared: grid, preparedProvenance });
      const bounded = boundedRouter({ landMask: mask });
      const after = selectRoutingCurrent({ departures: [routedDeparture], route: bounded, tileGrid, prepared: grid, preparedProvenance });
      expect(before.currentInput.provenance).toMatchObject({ current_source: 'prepared' }); // admitted before the change
      expect(bounded.mock.calls[0]![3]).toBeDefined();
      expect(JSON.stringify([...after.results])).toBe(JSON.stringify([...before.results]));
      expect(after.currentInput).toEqual(before.currentInput);
      expect(routed(after).route.provenance?.routing_request).not.toHaveProperty('search_bounds');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one source: if any departure cannot route on the prepared grid, every departure routes on tiles', () => {
    const departures = [routedDeparture, '2026-07-20T06:00:00Z'];
    // The first departure routes inside the 7 h axis; the second runs past its end.
    const selection = selectClipped(hourlyCorridor({}, 7), departures);
    expect(clipRouter.mock.calls.slice(0, 2).map(([departure, , strict, bounds]) => [departure, strict, Boolean(bounds)]))
      .toEqual([[departures[0], true, true], [departures[1], true, true]]);
    expectUnclippedTiles(selection, 'router read a point or time outside the prepared grid', departures);
  });

  it('reproduces a confined route on an exact retry, with the same identity for its Check', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(routedDeparture));
      const grid = hourlyCorridor();
      const first = routed(selectClipped(grid)).route;
      const again = routed(selectClipped(grid)).route;
      expect(JSON.stringify(again)).toBe(JSON.stringify(first));
      expect(first.provenance?.routing_request).toHaveProperty('search_bounds');
      const check = async (route: Route) => (await runAnalysis({ route, profile, departureUtc: routedDeparture, store: store(tileGrid),
        currentGrid: grid, currentGridProvenance: preparedProvenance, now: () => Date.parse(routedDeparture) })).findings;
      const [a, b] = [await check(first), await check(again)];
      expect(a.decision_hash).toBeTruthy();
      expect([b.decision_hash, b.snapshot_id, b.route_revision]).toEqual([a.decision_hash, a.snapshot_id, a.route_revision]);
      expect(routeRevision(first, routedDeparture)).toBe(a.route_revision);
      // the recorded area is part of the saved route, and the route contract takes it as it is
      expect(validateRoute(JSON.parse(JSON.stringify(first))), JSON.stringify(validateRoute.errors)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confines a refinement of a confined selection to the same grid', () => {
    const grid = hourlyCorridor();
    const { currentInput } = selectClipped(grid);
    const refined = routeOnSelectedCurrent({ departures: ['2026-07-20T02:00:00Z'], currentInput, route: clipRouter });
    expect(refined.get('2026-07-20T02:00:00Z')!.result!.route.provenance?.routing_request).toMatchObject({
      current_source: 'prepared', current_digest: contentHash(grid), search_bounds: expect.any(Object) });
    // a router that ignores the bounds leaves the grid: that departure is not routed on another source
    const ignoring = routeOnSelectedCurrent({ departures: ['2026-07-20T02:00:00Z'], currentInput, route: router });
    expect(String(ignoring.get('2026-07-20T02:00:00Z')!.error)).toMatch(/leaves the current grid/);
  });

  it('routes a computed scan on tiles when its last departure is past the prepared grid, while a Compute at the anchor uses it', () => {
    const grid = prepared({ time_axis: [routedDeparture, '2026-07-22T00:00:00Z'] }); // 48 h
    const departures = Array.from({ length: 21 }, (_, i) => new Date(Date.parse(routedDeparture) + i * 6 * 3600_000).toISOString());
    const scan = select(grid, departures);
    expect(scan.currentInput.provenance).toMatchObject({ current_source: 'tiles', fallback_reason: 'prepared grid does not cover every departure time' });
    expect(router.mock.calls.every(([, used]) => used === tileGrid)).toBe(true);
    expect(select(grid).currentInput.provenance).toMatchObject({ current_source: 'prepared' });
  });
});

// Review follow-up (2026-11-13): an outside node the search pops but cannot expand (a dead-end inlet) never read
// the grid before the change, so it does not confine the route: settled and counted exactly as before.
describe('a dead-end outside node the router pops', () => {
  const departure = '2026-07-20T00:00:00Z';
  const polar: Polar = { schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
    tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' } };
  const field = (kind: RegionGrid['kind'], u: number, extra: Partial<RegionGrid> = {}): RegionGrid => ({
    schema_version: 1, kind, run_id: `inlet-${kind}`, generated_at: departure, lat0: 0, lon0: 0, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 3,
    time_axis: [departure, '2026-07-30T00:00:00Z'], u_kt: Array(18).fill(u), v_kt: Array(18).fill(0), source: { mode: 'synthetic' }, ...extra });
  // Land from 0.90N (mask row 18) north, except a one-cell inlet at (0.90, 0.50) reached across sea at 0.85N.
  // The prepared grid ends at 0.85N, so the inlet's graph node is outside it; the wind is from the east.
  const mask: LandMask = { schema_version: 1, kind: 'land_mask', lat0: 0, lon0: 0, dlat: 0.05, dlon: 0.05, nlat: 21, nlon: 21,
    land: Array.from({ length: 21 * 21 }, (_, k) => {
      const i = Math.floor(k / 21), j = k % 21;
      return i >= 18 && !(i === 18 && j === 10) ? 1 : 0;
    }) };
  const preparedGrid = field('surface_current', 0.5, { run_id: 'prepared', dlat: 0.85, nlat: 2, u_kt: Array(12).fill(0.5), v_kt: Array(12).fill(0) });
  const tiles = field('surface_current', 0.2, { run_id: 'tile-current' });
  const route = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean, searchBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number }) =>
    computeRoute({ start: { lat: 0.5, lon: 0.5 }, finish: { lat: 0.1, lon: 0.1 }, polar, windGrid: field('wind10m', -12), landMask: mask,
      resolutionDeg: 0.1, maxHours: 48, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}),
      ...(searchBounds ? { searchBounds } : {}) }));

  it('gives exactly the route admitted before the change: same bytes, same steps, nothing recorded', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(departure));
      const options = { departures: [departure], tileGrid: tiles, prepared: preparedGrid, preparedProvenance: { run_id: 'prepared' } };
      const before = selectRoutingCurrent({ ...options, route: (d, g, strict) => route(d, g, strict) });
      const after = selectRoutingCurrent({ ...options, route });
      expect(before.currentInput.provenance).toMatchObject({ current_source: 'prepared' });
      expect(route.mock.calls.at(-1)![3]).toBeDefined();
      const result = after.results.get(departure)!.result!;
      expect(before.results.get(departure)!.result!.steps_used).toBe(80);
      expect(result.steps_used).toBe(80);
      expect(result.route.provenance?.routing_request).not.toHaveProperty('search_bounds');
      expect(JSON.stringify([...after.results])).toBe(JSON.stringify([...before.results]));
      expect(after.currentInput).toEqual(before.currentInput);
    } finally {
      vi.useRealTimers();
    }
  });
});
