// The quote under Compute and Scan for a passage the planner routes on a larger window than the
// route box (round a headland): it must count the tiles of that window, which the store reads.
// The real 0.05° outline, served from public/ as the Pages build serves it, and a counting store.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTileCache, TileForecastStore, routeBbox, tilesForBbox } from '@deepweather/engine';
import { clearRoutingBoxesForTests, quotePlannerActions } from '../src/lib/downloadQuote.js';
import { clearLandMaskCacheForTests } from '../src/lib/landMask.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const CYCLE = '2026-07-20T00:00Z';
const NOW = Date.parse('2026-07-20T04:00Z');
const DEPARTURE = '2026-07-20T08:00:00Z';
const TILES = [-20, -10, 0].flatMap((lat) => [120, 130, 140].map((lon) => [lat, lon]));
const axis = (last, step = 6) => ({ base: CYCLE, offsets_h: Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step) });
const SPECS = [
  { layer: 'weather', model: 'weather', cycle: CYCLE, resolution_deg: 0.25, time_axes: { h: axis(240) }, tiles: TILES,
    variables: [
      { name: 'wind_u_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 10 },
      { name: 'wind_v_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0 },
      { name: 'gust_kt', axis: 'h', dtype: 'i16', scale: 0.1, value: () => 15 },
    ] },
  { layer: 'currents', model: 'glo12', cycle: CYCLE, resolution_deg: 0.25, time_axes: { h: axis(240) }, tiles: TILES,
    variables: [
      { name: 'cur_u_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0 },
      { name: 'cur_v_kt', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 0 },
    ] },
];

function countingStore() {
  const transport = buildFixtureRun(SPECS);
  const fetched = new Set();
  const store = new TileForecastStore({
    transport: {
      fetchLatest: () => transport.fetchLatest(),
      fetchManifest: (runId) => transport.fetchManifest(runId),
      fetchTile: async (runId, tilePath, options) => {
        const [layer, , file] = tilePath.split('/');
        fetched.add(`${layer}/${file.replace(/\.bin$/, '')}`);
        return transport.fetchTile(runId, tilePath, options);
      },
    },
    cache: new MemoryTileCache(),
    now: () => NOW,
  });
  return { store, fetched };
}
const perLayer = (quote) => Object.fromEntries(quote.layers.map((l) => [l.layer, l.tiles]));
function fetchedPerLayer(fetched) {
  const counts = {};
  for (const tile of fetched) counts[tile.split('/')[0]] = (counts[tile.split('/')[0]] ?? 0) + 1;
  return counts;
}

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
beforeEach(() => {
  clearLandMaskCacheForTests();
  clearRoutingBoxesForTests();
  // The boat's polar (a stand-in entry; no polar data) and the coastline outline from public/.
  globalThis.fetch = vi.fn(async (url) => (String(url).startsWith('/api/polars/')
    ? new Response(JSON.stringify({ format: 'deepregatta-polars/1', id: 'test' }))
    : new Response(new Uint8Array(await readFile(path.join(PUBLIC, String(url)))))));
});
afterAll(() => {
  vi.unstubAllGlobals();
  clearLandMaskCacheForTests();
});

vi.mock('@deepweather/engine', async (original) => ({
  ...await original(),
  // routing is not what these tests are about: the polar is a stand-in
  polarFromRelease: () => ({ polar_id: 'test' }),
}));

describe('the quote for a passage routed on a larger window', () => {
  // The fourth review's case, along the south coast of New Guinea: the route box lies in one 10°
  // tile, but the way round runs west past 130°E and north past the equator (a window 8° larger).
  const start = { lat: -1.61, lon: 135.09 };
  const finish = { lat: -5.37, lon: 137.67 };
  const endpoints = [{ lat: start.lat, lng: start.lon }, { lat: finish.lat, lng: finish.lon }];

  it('counts the tiles of the window Compute reads, not of the route box alone', async () => {
    const { store, fetched } = countingStore();
    await store.init();
    expect(tilesForBbox(routeBbox(start, finish))).toEqual(['S10E130']);
    const { compute, scan } = await quotePlannerActions({
      store, manifests: (layer) => store.manifestFor(layer), want: { compute: true, scan: true }, mode: 'compute',
      endpoints, polarId: 'test', route: null, departureUtc: DEPARTURE, passageHours: null, nowMs: NOW,
    });
    await loadRoutingInputs({
      start: { ...start, name: 'Start' }, finish: { ...finish, name: 'Finish' },
      polarId: 'test', departureIso: DEPARTURE, now: () => NOW, store,
    });
    expect([...fetched].sort()).toEqual(['N00E120', 'N00E130', 'S10E120', 'S10E130'].flatMap((id) => [`currents/${id}`, `weather/${id}`]).sort());
    expect(perLayer(compute)).toEqual(fetchedPerLayer(fetched));
    // A computed comparison reads Compute's grids, and audits over the same window.
    for (const [layer, tiles] of Object.entries(fetchedPerLayer(fetched))) expect(perLayer(scan)[layer]).toBeGreaterThanOrEqual(tiles);
  });
});
