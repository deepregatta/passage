/**
 * D2 on real audits: the committed Cherbourg -> Plymouth fixtures (the scan
 * golden's setup) and the synthetic routing grids of currentAdmission.test.ts.
 * - refineScan equals one scan over the merged departures on the same current input;
 * - one current source across both passes, for a drawn and a computed scan;
 * - a departure the coarse scan's prepared grid cannot carry is skipped, never
 *   audited or routed on another source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  computeRoute, contentHash, rankCandidates, refineScan, refinementDepartures, routeOnSelectedCurrent, scanDepartures, selectRoutingCurrent,
  OUTSIDE_SCAN_CURRENT, OUTSIDE_SELECTED_CURRENT, ForecastRunGoneError,
} from '../src/index.js';
import type { LimitsProfile, Polar, RegionGrid, Route, RoutingRequest, WindowScan } from '../src/index.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const profile: LimitsProfile = read('../../config/profiles/default-limits.json');

function observable(scan: WindowScan) {
  return {
    candidates: scan.candidates, best_index: scan.best_index,
    typical: rankCandidates(scan.candidates, { mode: 'typical' }), cautious: rankCandidates(scan.candidates, { mode: 'cautious' }),
    input_records: scan.input_records, skipped: scan.skipped,
  };
}
const merged = (a: string[], b: string[]) => [...a, ...b].sort((x, y) => Date.parse(x) - Date.parse(y));

describe('on the committed Cherbourg -> Plymouth fixtures', () => {
  const NOW_MS = Date.parse('2026-07-11T18:00:00Z');
  const fixtures = Object.fromEntries(['forecast', 'ensemble', 'marine', 'multimodel']
    .map((name) => [name, read(`./fixtures/openmeteo-${name}-cherbourg-plymouth.json`)]));
  const store = () => new ScenarioBundleStore({ loadBundle: async (name) => fixtures[name] ?? null, now: () => NOW_MS });
  // The scan golden's tile current mosaic (test/helpers/scanGolden.ts): invented values.
  const tileGrid = (): RegionGrid => {
    const nlat = 12, nlon = 14;
    const time_axis = Array.from({ length: 13 }, (_, h) => new Date(Date.parse('2026-07-12T00:00Z') + h * 6 * 3600_000).toISOString());
    const size = nlat * nlon * time_axis.length;
    return { schema_version: 1, kind: 'surface_current', run_id: 'tile-current', generated_at: '2026-07-11T17:00:00Z',
      lat0: 49.5, lon0: -4.5, dlat: 0.1, dlon: 0.25, nlat, nlon, time_axis,
      u_kt: Array.from({ length: size }, (_, i) => Math.round(Math.sin(i / 7) * 100) / 100),
      v_kt: Array.from({ length: size }, (_, i) => Math.round(Math.cos(i / 5) * 100) / 100),
      source: { mode: 'live', dataset_id: 'tile-cmems', resolution_deg: 0.083, fetched_at: '2026-07-11T17:30:00Z' } };
  };
  const departures = ['2026-07-12T00:00:00Z', '2026-07-12T06:00:00Z', '2026-07-12T12:00:00Z', '2026-07-12T18:00:00Z'];
  const route: Route = read('../../config/routes/cherbourg-plymouth.json');

  it('gives the one-pass result over the merged departures, figures, mark, ties, records and skips alike', async () => {
    const grid = tileGrid();
    const currentInput = { grid, provenance: { source: 'tiles', current_source: 'tiles', content_digest: contentHash(grid), digest_algorithm: 'fnv1a64' } };
    const base = { route, profile, store: store(), now: () => NOW_MS, currentInput };
    const coarse = await scanDepartures(base, departures, undefined, { refinable: true });
    expect(coarse.candidates).toHaveLength(4);
    const progress: string[] = [];
    const refined = await refineScan(base, coarse, {}, (c) => progress.push(c.departure_utc));
    expect(refined.refined_departures.length).toBeGreaterThan(0);
    expect(progress).toEqual(refined.refined_departures.filter((d) => !refined.skipped.some((s) => s.departure_utc === d)));
    const oracle = await scanDepartures({ ...base, store: store() }, merged(departures, refined.refined_departures));
    expect(observable(refined)).toEqual(observable(oracle));
    // every refined time lies within 6 h of an anchor, on the 2 h grid, inside the coarse span
    for (const d of refined.refined_departures) {
      const ms = Date.parse(d);
      expect(refined.refined_around.some((a) => Math.abs(ms - Date.parse(a)) <= 6 * 3600_000 && (ms - Date.parse(a)) % (2 * 3600_000) === 0)).toBe(true);
      expect(ms).toBeGreaterThan(Date.parse(departures[0]!));
      expect(ms).toBeLessThan(Date.parse(departures[3]!));
    }
  });

  it('a drawn scan resolves its current input once; the refinement audits on it and reads no other', async () => {
    const tiles = store();
    const getCurrentGrid = vi.spyOn(tiles, 'getCurrentGrid').mockResolvedValue(tileGrid());
    const base = { route, profile, store: tiles, now: () => NOW_MS };
    const coarse = await scanDepartures(base, departures, undefined, { refinable: true });
    expect(getCurrentGrid).toHaveBeenCalledTimes(1);
    const refined = await refineScan(base, coarse);
    expect(getCurrentGrid).toHaveBeenCalledTimes(1);
    expect(refined.refinement.current_input).toBe(coarse.refinement.current_input);
    const oracle = await scanDepartures({ ...base, store: store(), currentInput: coarse.refinement.current_input },
      merged(departures, refined.refined_departures));
    expect(observable(refined)).toEqual(observable(oracle));
    expect(refined.input_records?.find((r) => r.layer === 'currents')).toMatchObject({ current_source: 'tiles', run_id: 'tile-current' });
  });
});

// The synthetic routing set-up of currentAdmission.test.ts.
describe('one current source across both passes of a computed scan', () => {
  const start = '2026-07-20T00:00:00Z';
  const polar: Polar = { schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
    tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' } };
  const regionGrid = (kind: RegionGrid['kind'], u: number, extra: Partial<RegionGrid> = {}): RegionGrid => ({
    schema_version: 1, kind, run_id: `test-${kind}`, generated_at: start, lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
    time_axis: [start, '2026-07-30T00:00:00Z'], u_kt: Array(24).fill(u), v_kt: Array(24).fill(kind === 'wind10m' ? -12 : 0),
    source: { mode: 'synthetic' }, ...extra,
  });
  const request: Omit<RoutingRequest, 'departureUtc'> = { start: { lat: 49.5, lon: -3.5 }, finish: { lat: 49.5, lon: -3.2 },
    polar, windGrid: regionGrid('wind10m', 0), resolutionDeg: 0.1, maxHours: 48 };
  const tileGrid = regionGrid('surface_current', 1, { run_id: 'tile-current' });
  const prepared = (extra: Partial<RegionGrid> = {}) => regionGrid('surface_current', 2, { run_id: 'prepared', ...extra });
  const preparedProvenance = { source: 'prepared-artifact', layer: 'currents', model: 'cmems', run_id: 'prepared' };
  const router = vi.fn((departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) =>
    computeRoute({ ...request, departureUtc, ...(currentGrid ? { currentGrid } : {}), ...(strictCurrent ? { strictCurrent } : {}) }));
  const at = (h: number) => new Date(Date.parse(start) + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coarseDepartures = [0, 6, 12, 18].map(at);
  const flatStore = () => {
    const times = Array.from({ length: 241 }, (_, h) => at(h));
    const s = new ScenarioBundleStore({ loadBundle: async (name) => (name === 'forecast' ? { hourly: {
      time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90),
    } } : null) });
    vi.spyOn(s, 'getCurrentGrid').mockResolvedValue(tileGrid);
    return s;
  };
  const routeOf = (results: Map<string, { result?: { route: Route }; error?: unknown }>) => (d: string) => {
    const outcome = results.get(d)!;
    if (!outcome.result) throw outcome.error;
    return outcome.result.route;
  };

  it.each([
    ['the prepared grid', prepared(), 'prepared'],
    ['tile currents', prepared({ time_axis: [start, '2026-07-20T06:30:00Z'] }), 'tiles'],
  ] as const)('routes and audits the refined departures on %s, as the coarse pass did', async (_, grid, source) => {
    router.mockClear();
    const selection = selectRoutingCurrent({ departures: coarseDepartures, route: router, tileGrid, prepared: grid, preparedProvenance });
    expect(selection.currentInput.provenance).toMatchObject({ current_source: source });
    const store = flatStore();
    const route = routeOf(selection.results)(coarseDepartures[0]!);
    const base = { route, profile, store, currentInput: selection.currentInput, routeFor: routeOf(selection.results) };
    const coarse = await scanDepartures(base, coarseDepartures, undefined, { refinable: true });
    router.mockClear();
    let added: Map<string, { result?: { route: Route }; error?: unknown }> = new Map();
    const refined = await refineScan({ ...base, routeFor: (d) => {
      if (!added.size) {
        added = routeOnSelectedCurrent({ departures: refinementDepartures(coarse).departures, currentInput: selection.currentInput, route: router });
      }
      return routeOf(added)(d);
    } }, coarse);
    expect(refined.refined_departures).toEqual([2, 4, 8, 10, 14, 16].map(at));
    expect(refined.skipped).toEqual([]);
    // never another grid: the same grid object, strict on the prepared grid only
    const used = selection.currentInput.grid;
    expect(router.mock.calls.every(([, g, strict]) => g === used && strict === (source === 'prepared'))).toBe(true);
    for (const d of refined.refined_departures) {
      const stamp = added.get(d)!.result!.route.provenance?.routing_request;
      if (source === 'prepared') expect(stamp).toMatchObject({ current_source: 'prepared', current_digest: contentHash(grid) });
      else expect(stamp).not.toHaveProperty('current_source');
    }
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
    expect(refined.refinement.current_input).toBe(selection.currentInput);
  });

  it('fails a refined departure the prepared grid cannot carry instead of routing it on tiles', () => {
    router.mockClear();
    const grid = prepared({ time_axis: [start, at(9)] });
    const selection = selectRoutingCurrent({ departures: [at(0), at(6)], route: router, tileGrid, prepared: grid, preparedProvenance });
    expect(selection.currentInput.provenance).toMatchObject({ current_source: 'prepared' });
    router.mockClear();
    const results = routeOnSelectedCurrent({ departures: [at(2), at(8), at(10)], currentInput: selection.currentInput, route: router });
    expect(results.get(at(2))!.result?.route.provenance?.routing_request).toMatchObject({ current_source: 'prepared' });
    expect(String(results.get(at(8))!.error)).toContain(OUTSIDE_SELECTED_CURRENT); // routed past the grid's end
    expect(String(results.get(at(10))!.error)).toContain(OUTSIDE_SELECTED_CURRENT); // departs after it
    expect(router.mock.calls.every(([, g, strict]) => g === grid && strict)).toBe(true);
    expect(router).toHaveBeenCalledTimes(2); // the departure after the axis is never routed
  });

  it('treats a current-gap error as outside, and rethrows a deleted forecast run', () => {
    const selection = selectRoutingCurrent({ departures: [at(0)], route: router, tileGrid, prepared: prepared(), preparedProvenance });
    const gap = routeOnSelectedCurrent({ departures: [at(2)], currentInput: selection.currentInput,
      route: () => { throw Object.assign(new Error('gap'), { code: 'current-gap' }); } });
    expect(String(gap.get(at(2))!.error)).toContain(OUTSIDE_SELECTED_CURRENT);
    const other = routeOnSelectedCurrent({ departures: [at(2)], currentInput: selection.currentInput,
      route: () => { throw new Error('No sea route found'); } });
    expect(String(other.get(at(2))!.error)).toContain('No sea route found');
    expect(() => routeOnSelectedCurrent({ departures: [at(2)], currentInput: selection.currentInput,
      route: () => { throw new ForecastRunGoneError('weather', 'run-1'); } })).toThrow(ForecastRunGoneError);
  });

  it('skips a refined departure of a drawn scan that the prepared grid does not cover, and audits the others on it', async () => {
    const drawn: Route = { schema_version: 1, route_id: 'r', name: 'R', mode: 'user',
      waypoints: [{ id: 'a', lat: 49.5, lon: -3.5 }, { id: 'b', lat: 49.5, lon: -3.2 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } };
    // hourly axis with no value at 09:00 and 10:00: the coarse times (0, 6, 12) are covered, 8 and 10 are not
    const hours = Array.from({ length: 30 }, (_, h) => h);
    const values = hours.flatMap((h) => Array(12).fill(h === 9 || h === 10 ? null : 0.5));
    const grid = prepared({ time_axis: hours.map(at), u_kt: values, v_kt: values.map((v) => (v === null ? null : 0)) });
    const currentInput = { grid, provenance: { ...preparedProvenance, current_source: 'prepared', content_digest: contentHash(grid) } };
    const store = flatStore();
    const base = { route: drawn, profile, store, currentInput };
    const coarse = await scanDepartures(base, [0, 6, 12].map(at), undefined, { refinable: true });
    expect(coarse.skipped).toEqual([]);
    const refined = await refineScan(base, coarse);
    expect(refined.refined_departures).toEqual([2, 4, 8, 10].map(at));
    expect(refined.skipped).toEqual([8, 10].map((h) => ({ departure_utc: at(h), reason: OUTSIDE_SCAN_CURRENT })));
    expect(refined.candidates.map((c) => c.departure_utc)).toEqual([0, 2, 4, 6, 12].map(at));
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
  });
});
