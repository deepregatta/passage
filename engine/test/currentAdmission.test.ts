import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, GridSampler, scanDepartures, computeRoute, selectRoutingCurrent, contentHash } from '../src/index.js';
import type { RegionGrid, Route, LimitsProfile, Polar, RoutingRequest } from '../src/index.js';
import { currentGridCovers } from '../src/currentInput.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { readFileSync } from 'node:fs';

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

  it('routes a computed scan on tiles when its last departure is past the prepared grid, while a Compute at the anchor uses it', () => {
    const grid = prepared({ time_axis: [routedDeparture, '2026-07-22T00:00:00Z'] }); // 48 h
    const departures = Array.from({ length: 21 }, (_, i) => new Date(Date.parse(routedDeparture) + i * 6 * 3600_000).toISOString());
    const scan = select(grid, departures);
    expect(scan.currentInput.provenance).toMatchObject({ current_source: 'tiles', fallback_reason: 'prepared grid does not cover every departure time' });
    expect(router.mock.calls.every(([, used]) => used === tileGrid)).toBe(true);
    expect(select(grid).currentInput.provenance).toMatchObject({ current_source: 'prepared' });
  });
});
