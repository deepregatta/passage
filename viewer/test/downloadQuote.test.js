import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryTileCache, TileForecastStore, auditSamplePlan, candidateDepartures, scanDepartures, runAnalysis,
} from '@deepweather/engine';
import { downloadLine, quotePlannerActions } from '../src/lib/downloadQuote.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { scanDateWindow } from '../src/lib/scanWindow.js';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';

vi.mock('@deepweather/engine', async (original) => ({
  ...await original(),
  // routing is not what these tests are about: the polar and the snapped ends are stand-ins
  polarFromRelease: () => ({ polar_id: 'test' }),
  snapToSea: (_mask, point) => ({ lat: point.lat, lon: point.lon }),
}));
vi.mock('../src/lib/landMask.js', () => ({ landMaskForBbox: async () => ({ kind: 'land_mask' }) }));

const limits = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/profiles/default-limits.json'), 'utf8'));

describe('downloadLine', () => {
  const quote = (over) => ({
    layers: [], tiles: 3, bytes: 12_000_000, cachedTiles: 0, cachedBytes: 0, downloadTiles: 3, downloadBytes: 12_000_000,
    lowerBound: false, missingLayers: [], ...over,
  });

  it('says up to, in the GRIB page units', () => {
    expect(downloadLine(quote())).toBe('Downloads up to 12 MB of forecast tiles');
    expect(downloadLine(quote({ downloadBytes: 2_500_000 }))).toBe('Downloads up to 2.5 MB of forecast tiles');
    expect(downloadLine(quote({ downloadBytes: 800_000 }))).toBe('Downloads up to 800 kB of forecast tiles');
  });

  it('says at least when a layer could not be quoted', () => {
    expect(downloadLine(quote({ lowerBound: true }))).toBe('Downloads at least 12 MB of forecast tiles');
  });

  it('says the tiles are already here when nothing is left to fetch', () => {
    expect(downloadLine(quote({ cachedTiles: 3, cachedBytes: 12_000_000, downloadTiles: 0, downloadBytes: 0 })))
      .toBe('Forecast tiles already on this device');
  });

  it('says nothing when the figure cannot be known', () => {
    expect(downloadLine(null)).toBeNull();
    // no tile published for the area: that is not "already on this device"
    expect(downloadLine(quote({ tiles: 0, bytes: 0, downloadTiles: 0, downloadBytes: 0 }))).toBeNull();
    // everything quotable is cached, but a layer is missing: neither claim is true
    expect(downloadLine(quote({ lowerBound: true, cachedTiles: 3, downloadTiles: 0, downloadBytes: 0 }))).toBeNull();
  });
});

describe('scanDateWindow', () => {
  it('runs from the first candidate day to a day past the last arrival, capped at the horizon', () => {
    const departures = ['2026-09-12T12:00:00Z', '2026-09-17T12:00:00Z'];
    const now = Date.parse('2026-09-10T09:00:00Z');
    expect(scanDateWindow(departures, 48, now)).toEqual({ startDate: '2026-09-12', endDate: '2026-09-20' });
    // a 10-day horizon from "now" caps it
    expect(scanDateWindow(departures, 400, now).endDate).toBe('2026-09-20');
  });
});

// The quote must name the tiles each action really fetches: the same fixture run, a counting
// transport, and the viewer's own code paths for Compute, Check and a drawn Scan.
const CYCLE = '2026-07-20T00:00Z';
const TILES = [[40, -10], [50, -10], [40, 0], [50, 0]];
const axis = (last, step = 6, base = CYCLE) => ({ base, offsets_h: Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step) });
const wind = (layer, cycle, axisBase, last) => ({
  layer, model: layer, cycle, resolution_deg: 0.25, time_axes: { h: axis(last, 6, axisBase) }, tiles: TILES,
  variables: [
    { name: 'wind_u_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 10 },
    { name: 'wind_v_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0 },
    { name: 'gust_kt', axis: 'h', dtype: 'i16', scale: 0.1, value: () => 15 },
  ],
});
const SPECS = [
  wind('weather', CYCLE, CYCLE, 240),
  { layer: 'ensemble', model: 'gefs', cycle: CYCLE, resolution_deg: 0.5, member_count: 3, time_axes: { s: axis(240) }, tiles: TILES,
    variables: [
      { name: 'wind_kt_mean', axis: 's', dtype: 'i16', scale: 0.01, value: () => 12 },
      { name: 'wind_kt_anom', axis: 's', dtype: 'i8', scale: 0.2, per_member: true, value: (m) => (m - 1) * 2 },
    ] },
  { layer: 'waves', model: 'gfswave', cycle: CYCLE, resolution_deg: 0.5, time_axes: { h: axis(240) }, tiles: TILES,
    variables: [{ name: 'hs_m', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 1 }] },
  { layer: 'currents', model: 'glo12', cycle: CYCLE, resolution_deg: 0.25, time_axes: { h: axis(240) }, tiles: TILES,
    variables: [
      { name: 'cur_u_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0.5 },
      { name: 'cur_v_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0.2 },
    ] },
  wind('weather-ecmwf', CYCLE, CYCLE, 240),
  wind('weather-ecmwf-short', '2026-07-20T06:00Z', CYCLE, 96),
];
const NOW = Date.parse('2026-07-20T04:00Z');

function countingStore() {
  const transport = buildFixtureRun(SPECS);
  const fetched = new Set();
  const counting = {
    fetchLatest: () => transport.fetchLatest(),
    fetchManifest: (runId) => transport.fetchManifest(runId),
    fetchTile: async (runId, path, options) => {
      const [layer, , file] = path.split('/');
      fetched.add(`${layer}/${file.replace(/\.bin$/, '')}`);
      return transport.fetchTile(runId, path, options);
    },
  };
  const cache = new MemoryTileCache();
  return { store: new TileForecastStore({ transport: counting, cache, now: () => NOW }), fetched, cache };
}

/** What a quote says per layer, and what the store fetched, in the same terms. */
function perLayer(quote) {
  return Object.fromEntries(quote.layers.map((l) => [l.layer, l.tiles]));
}
function fetchedPerLayer(fetched) {
  const counts = {};
  for (const tile of fetched) counts[tile.split('/')[0]] = (counts[tile.split('/')[0]] ?? 0) + 1;
  return counts;
}

describe('the quote names the tiles Compute, Check and Scan fetch', () => {
  let setup;
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ format: 'deepregatta-polars/1', id: 'test' }))));
    setup = countingStore();
    await setup.store.init();
  });
  afterEach(() => vi.unstubAllGlobals());
  const quoteFor = (input) => quotePlannerActions({
    store: setup.store, manifests: (layer) => setup.store.manifestFor(layer), mode: 'draw', endpoints: [], polarId: null,
    route: null, departureUtc: '2026-07-20T08:00:00Z', passageHours: null, nowMs: NOW, want: {}, ...input,
  });

  it('Compute: the tiles loadRoutingInputs asks the store for', async () => {
    const endpoints = [{ lat: 49.2, lng: -1.6 }, { lat: 50.7, lng: 1.4 }];
    await loadRoutingInputs({
      start: { lat: 49.2, lon: -1.6, name: 'Start' }, finish: { lat: 50.7, lon: 1.4, name: 'Finish' },
      polarId: 'test', departureIso: '2026-07-20T08:00:00Z', now: () => NOW, store: setup.store,
    });
    const { compute } = await quoteFor({ mode: 'compute', endpoints, polarId: 'test', want: { compute: true } });
    expect(setup.fetched.size).toBeGreaterThan(0);
    expect(perLayer(compute)).toEqual(fetchedPerLayer(setup.fetched));
    expect(compute.tiles).toBe(setup.fetched.size);
  });

  const route = {
    schema_version: 1, route_id: 'across-50n', name: 'Across 50N', mode: 'user',
    waypoints: [{ id: 'a', lat: 49, lon: -5 }, { id: 'b', lat: 50, lon: -5 }, { id: 'c', lat: 51, lon: -5 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, timing: { basis: 'through_water' },
  };

  it('Check: the tiles runAnalysis reads for a route, current tiles included', async () => {
    await runAnalysis({ route, profile: limits, departureUtc: '2026-07-20T08:00:00Z', store: setup.store, now: () => NOW });
    const { check } = await quoteFor({ route, want: { check: true } });
    expect(perLayer(check)).toEqual(fetchedPerLayer(setup.fetched));
    expect(check.bytes).toBeGreaterThan(0);
  });

  it('Scan, drawn route: the tiles every candidate departure reads', async () => {
    const departureUtc = '2026-07-20T08:00:00Z';
    const departures = candidateDepartures(Date.parse(departureUtc), 120, 6);
    const dateWindow = scanDateWindow(departures, 48, NOW);
    expect(auditSamplePlan(route, departures[0], dateWindow).endMs).toBeGreaterThan(Date.parse('2026-07-24T00:00Z'));
    await scanDepartures({ route, profile: limits, departureUtc, store: setup.store, now: () => NOW, dateWindow }, departures);
    const { scan } = await quoteFor({ route, departureUtc, passageHours: 48, want: { scan: true } });
    expect(perLayer(scan)).toEqual(fetchedPerLayer(setup.fetched));
    // the window reaches past the short ECMWF layer, so both are read
    expect(perLayer(scan)['weather-ecmwf']).toBeGreaterThan(0);
    expect(perLayer(scan)['weather-ecmwf-short']).toBeGreaterThan(0);
  });

  it('Scan, computed route: Compute\'s grids and the audit layers over the box, no current tiles of its own', async () => {
    const endpoints = [{ lat: 49.2, lng: -5.2 }, { lat: 50.7, lng: -4.6 }];
    const { scan, compute } = await quoteFor({ mode: 'compute', endpoints, polarId: 'test', route, want: { scan: true, compute: true } });
    expect(perLayer(scan)).toMatchObject({ weather: 2, ensemble: 2, waves: 2, 'weather-ecmwf': 2, 'weather-ecmwf-short': 2, currents: 2 });
    // the same currents tiles as Compute: nothing extra for the audits
    expect(scan.layers.find((l) => l.layer === 'currents').tiles).toBe(compute.layers.find((l) => l.layer === 'currents').tiles);
  });

  it('subtracts what the cache holds, and never fetches while quoting', async () => {
    const before = setup.fetched.size;
    const first = await quoteFor({ route, want: { check: true } });
    expect(setup.fetched.size).toBe(before);
    await runAnalysis({ route, profile: limits, departureUtc: '2026-07-20T08:00:00Z', store: setup.store, now: () => NOW });
    const after = await quoteFor({ route, want: { check: true } });
    expect(first.check.downloadTiles).toBe(first.check.tiles);
    expect(after.check).toMatchObject({ tiles: first.check.tiles, cachedTiles: first.check.tiles, downloadTiles: 0, downloadBytes: 0 });
    expect(downloadLine(after.check)).toBe('Forecast tiles already on this device');
  });

  it('answers nothing for an action that was not asked for, a store without weather, or a route it cannot schedule', async () => {
    expect(await quoteFor({ route, want: {} })).toEqual({ compute: null, scan: null, check: null });
    const none = await quotePlannerActions({
      store: setup.store, manifests: () => null, mode: 'draw', endpoints: [], polarId: null, route, departureUtc: '2026-07-20T08:00:00Z',
      passageHours: null, want: { check: true },
    });
    expect(none.check).toBeNull();
    const broken = await quoteFor({ route: { ...route, speeds_kt: undefined }, want: { check: true } });
    expect(broken.check).toBeNull();
  });
});
