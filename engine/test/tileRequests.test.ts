import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditSamplePlan, auditTileRequests, currentGridBbox, quoteTileDownload, routeBbox, routingTileRequests, runAnalysis,
} from '../src/index.js';
import { AREA_SNAP_MARGIN_DEG, planTileRequests } from '../src/forecast/tileRequests.js';
import {
  CURRENTS_LAYER, ENSEMBLE_LAYER, WAVES_LAYER, WEATHER_LAYER, mosaicLattice, mosaicPoints, tileCacheKey,
} from '../src/forecast/storeGeometry.js';
import { MemoryTileCache, type RunManifest, type TileFetchOptions, type TileTransport } from '../src/forecast/store.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import type { TileRequest } from '../src/forecast/tileRequests.js';
import { parseUtc } from '../src/eta.js';
import type { LimitsProfile, Route } from '../src/types.js';
import { buildFixtureRun, type FixtureLayerSpec, type MemoryTileTransport } from './helpers/fixtureRun.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

/** A manifest with no tiles on disk: sizes only, which is all the quote reads. */
function manifest(layer: string, tiles: Record<string, number>, extra: Partial<RunManifest> = {}): RunManifest {
  return {
    schema_version: 1, run_id: `${layer}-20260720T00Z`, layer, model: layer, cycle: '2026-07-20T00:00Z',
    member_count: 1, resolution_deg: 0.25, horizon_h: 48, time_axes: {}, variables: [],
    tiling: { tile_deg: 10, path_template: `${layer}/z025/{tile_id}.bin` },
    tiles: Object.fromEntries(Object.entries(tiles).map(([id, bytes]) => [id, { bytes, fnv64: '0' }])),
    totals: { tile_count: Object.keys(tiles).length, bytes: 0 }, published_at: '2026-07-20T04:00:00Z',
    ...extra,
  };
}

const lookup = (...manifests: RunManifest[]) => (layer: string) => manifests.find((m) => m.layer === layer) ?? null;

describe('planTileRequests', () => {
  const weather = manifest('weather', { N40W010: 1000, N50W010: 2000, N40E000: 4000 });

  it('opens the tile a point is in, once however many points share it', () => {
    const plan = planTileRequests([{ layer: 'weather', points: [{ lat: 45, lon: -5 }, { lat: 46, lon: -6 }] }], lookup(weather));
    expect(plan.tiles.map((t) => [t.layer, t.tileId, t.bytes])).toEqual([['weather', 'N40W010', 1000]]);
    expect(plan.missingLayers).toEqual([]);
  });

  it('adds the neighbour across a 10 degree line when a point lies within one cell of it', () => {
    const near = planTileRequests([{ layer: 'weather', points: [{ lat: 49.75, lon: -5 }] }], lookup(weather));
    expect(near.tiles.map((t) => t.tileId).sort()).toEqual(['N40W010', 'N50W010']);
    const far = planTileRequests([{ layer: 'weather', points: [{ lat: 49.25, lon: -5 }] }], lookup(weather));
    expect(far.tiles.map((t) => t.tileId)).toEqual(['N40W010']);
  });

  it('counts the tiles of a bbox grid across a tile edge, and adds nothing for tiles the manifest lacks', () => {
    const plan = planTileRequests([{ layer: 'weather', bbox: { minLat: 49, maxLat: 51, minLon: -1, maxLon: 1 } }], lookup(weather));
    // N50E000 is not published (all land): it contributes nothing and is no error.
    expect(plan.tiles.map((t) => t.tileId).sort()).toEqual(['N40E000', 'N40W010', 'N50W010']);
  });

  it('counts the same layer and tile once across requests, and different layers separately', () => {
    const currents = manifest('currents', { N40W010: 500 });
    const plan = planTileRequests([
      { layer: 'weather', points: [{ lat: 45, lon: -5 }] },
      { layer: 'weather', area: { minLat: 44, maxLat: 46, minLon: -6, maxLon: -4 } },
      { layer: 'currents', points: [{ lat: 45, lon: -5 }] },
    ], lookup(weather, currents));
    expect(plan.tiles.map((t) => `${t.layer}/${t.tileId}`)).toEqual(['weather/N40W010', 'currents/N40W010']);
  });

  it('follows points across the antimeridian, and rejects an area that crosses it', () => {
    const east = manifest('weather', { N10E170: 10, N10W180: 20 });
    const plan = planTileRequests([{ layer: 'weather', points: [{ lat: 10.1, lon: 179.9 }] }], lookup(east));
    expect(plan.tiles.map((t) => t.tileId).sort()).toEqual(['N10E170', 'N10W180']);
    expect(() => planTileRequests([{ layer: 'weather', area: { minLat: 9, maxLat: 11, minLon: 179, maxLon: -179 } }], lookup(east)))
      .toThrow(/antimeridian/);
  });

  it('reports a requested layer with no manifest, unless the catalogue does not name it', () => {
    const requests: TileRequest[] = [{ layer: 'weather', points: [{ lat: 45, lon: -5 }] }, { layer: 'ensemble', points: [{ lat: 45, lon: -5 }] }];
    expect(planTileRequests(requests, lookup(weather)).missingLayers).toEqual(['ensemble']);
    expect(planTileRequests(requests, lookup(weather), { listed: ['weather', 'ensemble'] }).missingLayers).toEqual(['ensemble']);
    expect(planTileRequests(requests, lookup(weather), { listed: ['weather'] }).missingLayers).toEqual([]);
  });
});

describe('quoteTileDownload', () => {
  const weather = manifest('weather', { N40W010: 1000, N50W010: 2000 });
  const ensemble = manifest('ensemble', { N40W010: 300 });
  const requests: TileRequest[] = [
    { layer: 'weather', points: [{ lat: 45, lon: -5 }, { lat: 55, lon: -5 }] },
    { layer: 'ensemble', points: [{ lat: 45, lon: -5 }] },
  ];

  it('totals compressed bytes and tile counts per layer and in all', async () => {
    const quote = await quoteTileDownload(requests, lookup(weather, ensemble));
    expect(quote.layers).toEqual([
      { layer: 'weather', tiles: 2, bytes: 3000, cachedTiles: 0, cachedBytes: 0 },
      { layer: 'ensemble', tiles: 1, bytes: 300, cachedTiles: 0, cachedBytes: 0 },
    ]);
    expect(quote).toMatchObject({ tiles: 3, bytes: 3300, downloadTiles: 3, downloadBytes: 3300, lowerBound: false });
  });

  it('flags a lower bound when a requested layer has no manifest, and still totals the rest', async () => {
    const quote = await quoteTileDownload(requests, lookup(weather), { listed: ['weather', 'ensemble'] });
    expect(quote).toMatchObject({ tiles: 2, bytes: 3000, lowerBound: true, missingLayers: ['ensemble'] });
  });

  it('subtracts the tiles reported as already on the device', async () => {
    const held = new Set([tileCacheKey(weather, 'N40W010'), tileCacheKey(ensemble, 'N40W010')]);
    const quote = await quoteTileDownload(requests, lookup(weather, ensemble), { isCached: (tile) => held.has(tile.key) });
    expect(quote).toMatchObject({ tiles: 3, bytes: 3300, cachedTiles: 2, cachedBytes: 1300, downloadTiles: 1, downloadBytes: 2000 });
    expect(quote.layers[0]).toMatchObject({ layer: 'weather', cachedTiles: 1, cachedBytes: 1000 });
  });

  it('has nothing left to download when every tile is cached', async () => {
    const quote = await quoteTileDownload(requests, lookup(weather, ensemble), { isCached: async () => true });
    expect(quote).toMatchObject({ tiles: 3, downloadTiles: 0, downloadBytes: 0 });
  });

  it('subtracts nothing without a probe, or when it fails', async () => {
    expect((await quoteTileDownload(requests, lookup(weather, ensemble))).downloadBytes).toBe(3300);
    const failing = () => { throw new Error('storage unavailable'); };
    expect((await quoteTileDownload(requests, lookup(weather, ensemble), { isCached: failing })).downloadBytes).toBe(3300);
  });

  it('reports no tiles at all when no requested tile is published', async () => {
    const quote = await quoteTileDownload([{ layer: 'weather', points: [{ lat: -30, lon: 100 }] }], lookup(weather));
    expect(quote).toMatchObject({ tiles: 0, bytes: 0, downloadTiles: 0, lowerBound: false });
  });
});

describe('MemoryTileCache.has', () => {
  it('reports presence without reading or changing anything', async () => {
    const cache = new MemoryTileCache();
    expect(await cache.has('k')).toBe(false);
    await cache.put('k', new Uint8Array([1]), 'run');
    expect(await cache.has('k')).toBe(true);
    await cache.delete('k');
    expect(await cache.has('k')).toBe(false);
    await cache.put('k', new Uint8Array([1]), 'run');
    await cache.evictExcept(['other']);
    expect(await cache.has('k')).toBe(false);
  });
});

describe('regional layers in the audit reads', () => {
  const where = { points: [{ lat: 49.5, lon: -5 }, { lat: 50.5, lon: -5 }] };
  const regional = (layer: string, bytes: number, coverage = { minLat: 40, maxLat: 60, minLon: -10, maxLon: 0 }) => manifest(layer, { N40W010: bytes, N50W010: bytes }, {
    coverage, capabilities: ['wind'], resolution_deg: 0.5,
  });
  const window = { startMs: parseUtc('2026-07-20T00:00Z'), endMs: parseUtc('2026-07-21T00:00Z') };
  const regionalRequests = (requests: TileRequest[]) => requests.filter((r) => ['weather-arome', 'weather-ukv', 'weather-icon-eu'].includes(r.layer)).map((r) => r.layer);

  it('counts every enabled regional model that overlaps the request, whatever the store may later skip', () => {
    const arome = regional('weather-arome', 1_000_000);
    expect(regionalRequests(auditTileRequests(lookup(arome), { where, window, regionalLayers: ['weather-arome'] })))
      .toEqual(['weather-arome']);
    // outside its period, over the 20 MiB budget: the store may skip it; the quote still counts it (an upper bound)
    const late = { startMs: parseUtc('2026-07-25T00:00Z'), endMs: parseUtc('2026-07-26T00:00Z') };
    expect(regionalRequests(auditTileRequests(lookup(arome), { where, window: late, regionalLayers: ['weather-arome'] })))
      .toEqual(['weather-arome']);
  });

  it('counts the second layer when two together would exceed the transfer budget', () => {
    // 12 MiB + 12 MiB: a cumulative 20 MiB budget kept only the first, but the store applies it per
    // candidate and may read both
    const a = regional('weather-arome', 12 * 1024 * 1024);
    const b = regional('weather-ukv', 12 * 1024 * 1024);
    const requests = auditTileRequests(lookup(a, b), { where, window, regionalLayers: ['weather-arome', 'weather-ukv'] });
    expect(regionalRequests(requests)).toEqual(['weather-arome', 'weather-ukv']);
  });

  it('skips a regional model that does not overlap the request or has no coverage', () => {
    const far = regional('weather-arome', 1000, { minLat: 0, maxLat: 10, minLon: 100, maxLon: 110 });
    const none = manifest('weather-ukv', { N40W010: 1 });
    expect(regionalRequests(auditTileRequests(lookup(far, none), { where, window, regionalLayers: ['weather-arome', 'weather-ukv'] }))).toEqual([]);
    expect(regionalRequests(auditTileRequests(lookup(far), { where: { area: { minLat: 49, maxLat: 51, minLon: -6, maxLon: -4 } }, regionalLayers: ['weather-arome'] }))).toEqual([]);
    expect(regionalRequests(auditTileRequests(lookup(regional('weather-arome', 1000)), { where: { area: { minLat: 49, maxLat: 51, minLon: -6, maxLon: -4 } }, regionalLayers: ['weather-arome'] })))
      .toEqual(['weather-arome']);
  });
});

describe('area reads (computed scan)', () => {
  it('reach past the box by a cell of the layer plus the router and audit snaps', () => {
    // a box edge 0.3° above the 50°N line: the routing lattice can start half a cell below it and an
    // audit midpoint can snap to the line, from which a read reaches the tile below (one cell)
    const weather = manifest('weather', { N40W010: 10, N50W010: 20 });
    const area = { minLat: 50.3, maxLat: 51, minLon: -6, maxLon: -5 };
    const ids = (a: typeof area) => planTileRequests([{ layer: 'weather', area: a }], lookup(weather)).tiles.map((t) => t.tileId).sort();
    expect(ids(area)).toEqual(['N40W010', 'N50W010']);
    expect(AREA_SNAP_MARGIN_DEG + weather.resolution_deg).toBeGreaterThanOrEqual(0.25 + 0.125 + 0.25);
    // well clear of the line: only the box's own tile
    expect(ids({ ...area, minLat: 52 })).toEqual(['N50W010']);
  });
});

// ---------------------------------------------------------------- drift tests
// The quote must name the tiles the action really fetches. These run the real
// store over a counting transport and compare (layer, tile) pairs.

const CYCLE = '2026-07-20T00:00Z';
const TILES: Array<[number, number]> = [[40, -10], [50, -10], [40, 0], [50, 0]];
const hourly = (last: number, step: number, base = CYCLE) => ({
  base, offsets_h: Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step),
});

function weatherLike(layer: string, cycle: string, axisBase: string, lastHour: number): FixtureLayerSpec {
  return {
    layer, model: layer, cycle, resolution_deg: 0.25, time_axes: { hourly: hourly(lastHour, 6, axisBase) },
    variables: [
      { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 10 },
      { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 0 },
      { name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: () => 15 },
    ],
    tiles: TILES,
  };
}

const ensembleSpec: FixtureLayerSpec = {
  layer: 'ensemble', model: 'gefs', cycle: CYCLE, resolution_deg: 0.5, member_count: 3,
  time_axes: { steps: hourly(240, 6) },
  variables: [
    { name: 'wind_kt_mean', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => 12 },
    { name: 'wind_kt_anom', axis: 'steps', dtype: 'i8', scale: 0.2, per_member: true, value: (m) => (m - 1) * 2 },
  ],
  tiles: TILES,
};
const wavesSpec: FixtureLayerSpec = {
  layer: 'waves', model: 'gfswave', cycle: CYCLE, resolution_deg: 0.5, time_axes: { h: hourly(240, 6) },
  variables: [{ name: 'hs_m', axis: 'h', dtype: 'i16', scale: 0.01, value: () => 1 }], tiles: TILES,
};
const currentsSpec: FixtureLayerSpec = {
  layer: 'currents', model: 'glo12', cycle: CYCLE, resolution_deg: 0.25, time_axes: { h6: hourly(240, 6) },
  variables: [
    { name: 'cur_u_kt', axis: 'h6', dtype: 'i16', scale: 0.01, value: () => 0.5 },
    { name: 'cur_v_kt', axis: 'h6', dtype: 'i16', scale: 0.01, value: () => 0.2 },
  ],
  tiles: TILES,
};

/** Every (layer, tile) the store fetches from the network, in fetch order. */
function recording(transport: MemoryTileTransport): { transport: TileTransport; fetched: Set<string> } {
  const fetched = new Set<string>();
  const counting: TileTransport = {
    fetchLatest: () => transport.fetchLatest(),
    fetchManifest: (runId) => transport.fetchManifest(runId),
    async fetchTile(runId: string, path: string, options?: TileFetchOptions) {
      const [layer, , file] = path.split('/');
      fetched.add(`${layer}/${file!.replace(/\.bin$/, '')}`);
      return transport.fetchTile(runId, path, options);
    },
  };
  return { transport: counting, fetched };
}

const planned = (requests: TileRequest[], store: TileForecastStore) =>
  new Set(planTileRequests(requests, (layer) => store.manifestFor(layer)).tiles.map((t) => `${t.layer}/${t.tileId}`));
const layerOf = (tiles: Iterable<string>, layer: string) => [...tiles].filter((t) => t.startsWith(`${layer}/`)).sort();

describe('the quote names the tiles an action fetches', () => {
  const NOW = parseUtc('2026-07-20T04:00Z');

  it('Compute: the wind and current grids over the route box', async () => {
    // crosses the 50°N and 0° tile lines, ends clear of any line
    const start = { lat: 49.2, lon: -1.6 };
    const finish = { lat: 50.7, lon: 1.4 };
    const bbox = routeBbox(start, finish);
    const run = recording(buildFixtureRun([weatherLike('weather', CYCLE, CYCLE, 240), currentsSpec]));
    const store = new TileForecastStore({ transport: run.transport, now: () => NOW });
    await store.getWindGrid(bbox, '2026-07-20T06:00:00Z', 60);
    await store.getCurrentGrid(bbox, '2026-07-20T06:00:00Z', 60);
    const quoted = planned(routingTileRequests(bbox), store);
    expect(layerOf(run.fetched, 'weather')).toHaveLength(4);
    expect([...quoted].sort()).toEqual([...run.fetched].sort());
  });

  it('Compute: a lattice point within a cell of a line is quoted with its neighbour, never under-counted', async () => {
    // the northernmost lattice row sits at 49.75, a cell below the 50°N line
    const bbox = { minLat: 49.0, maxLat: 49.8, minLon: -5.5, maxLon: -4.5 };
    const run = recording(buildFixtureRun([weatherLike('weather', CYCLE, CYCLE, 240)]));
    const store = new TileForecastStore({ transport: run.transport, now: () => NOW });
    await store.getWindGrid(bbox, '2026-07-20T06:00:00Z', 24);
    const quoted = planned(routingTileRequests(bbox), store);
    expect([...run.fetched]).toEqual(['weather/N40W010']);
    for (const tile of run.fetched) expect(quoted.has(tile)).toBe(true);
    expect(quoted.has('weather/N50W010')).toBe(true); // the deliberate over-count
  });

  it('Compute: a strided lattice (large box) is walked the way the mosaic walks it', () => {
    const m = manifest('weather', { N40W010: 1 });
    const lattice = mosaicLattice(m, { minLat: 30, maxLat: 60, minLon: -20, maxLon: 10 });
    expect(lattice.stride).toBeGreaterThan(1);
    expect([...mosaicPoints(lattice)]).toHaveLength(lattice.nlat * lattice.nlon);
  });

  describe('Check', () => {
    const profile = read('../../config/profiles/default-limits.json') as LimitsProfile;
    // midpoints 49.5 and 50.5: across the 50°N line, clear of it
    const route: Route = {
      schema_version: 1, route_id: 'across-50n', name: 'Across 50N', mode: 'user',
      waypoints: [{ id: 'a', lat: 49, lon: -5 }, { id: 'b', lat: 50, lon: -5 }, { id: 'c', lat: 51, lon: -5 }],
      speeds_kt: { slow: 4, nominal: 5, fast: 6 }, timing: { basis: 'through_water' },
    };
    const departureUtc = '2026-07-20T08:00:00Z';
    // the short layer is newer and its axis covers the 96 h window; the long layer reaches 240 h
    const specs = [
      weatherLike('weather', CYCLE, CYCLE, 240), ensembleSpec, wavesSpec, currentsSpec,
      weatherLike('weather-ecmwf', CYCLE, CYCLE, 240),
      weatherLike('weather-ecmwf-short', '2026-07-20T06:00Z', CYCLE, 96),
    ];

    async function audit(dateWindow?: { startDate: string; endDate: string }) {
      const run = recording(buildFixtureRun(specs));
      const store = new TileForecastStore({ transport: run.transport, now: () => NOW });
      await runAnalysis({ route, profile, departureUtc, store, now: () => NOW, ...(dateWindow ? { dateWindow } : {}) });
      const sample = auditSamplePlan(route, departureUtc, dateWindow);
      const requests = auditTileRequests((layer) => store.manifestFor(layer), {
        where: { points: sample.points }, window: sample, currents: currentGridBbox([route]),
      });
      return { fetched: run.fetched, quoted: planned(requests, store), store, sample };
    }

    it('reads exactly the quoted tiles, the ECMWF layer the window picks included', async () => {
      const { fetched, quoted } = await audit();
      expect(layerOf(fetched, 'weather-ecmwf-short').length).toBeGreaterThan(0);
      expect(layerOf(fetched, 'weather-ecmwf')).toEqual([]);
      for (const layer of ['weather', 'ensemble', 'waves', 'currents', 'weather-ecmwf-short']) {
        expect(layerOf(fetched, layer), layer).toEqual(layerOf(quoted, layer));
      }
      expect([...quoted].sort()).toEqual([...fetched].sort());
    });

    it('quotes both ECMWF layers once a widened window needs the long one', async () => {
      const { fetched, quoted } = await audit({ startDate: '2026-07-20', endDate: '2026-07-25' });
      expect(layerOf(fetched, 'weather-ecmwf').length).toBeGreaterThan(0);
      expect(layerOf(fetched, 'weather-ecmwf-short').length).toBeGreaterThan(0);
      expect([...quoted].sort()).toEqual([...fetched].sort());
    });

    it('covers a computed scan: the audit area holds every tile any route inside the box reads', async () => {
      const { fetched, store } = await audit();
      const area = routeBbox({ lat: 49, lon: -5 }, { lat: 51, lon: -5 });
      const requests = auditTileRequests((layer) => store.manifestFor(layer), { where: { area } });
      const quoted = planned(requests, store);
      for (const tile of fetched) {
        if (tile.startsWith('currents/')) continue; // a scan is handed the routing grid
        expect(quoted.has(tile), tile).toBe(true);
      }
      // without a known window, both ECMWF layers are counted
      expect(layerOf(quoted, 'weather-ecmwf').length).toBeGreaterThan(0);
    });

    it('has the audit read its own currents only when none is supplied', () => {
      const m = (layer: string) => manifest(layer, { N40W010: 1 });
      const without = auditTileRequests(m, { where: { points: [{ lat: 45, lon: -5 }] } });
      expect(without.some((r) => r.layer === CURRENTS_LAYER)).toBe(false);
      const withCurrents = auditTileRequests(m, { where: { points: [{ lat: 45, lon: -5 }] }, currents: currentGridBbox([route]) });
      expect(withCurrents.filter((r) => r.layer === CURRENTS_LAYER)).toHaveLength(1);
      for (const layer of [WEATHER_LAYER, ENSEMBLE_LAYER, WAVES_LAYER]) {
        expect(without.some((r) => r.layer === layer)).toBe(true);
      }
    });
  });
});

describe('TileForecastStore catalogue accessors and hasTile', () => {
  it('names the catalogue layers and its regional models', async () => {
    const run = recording(buildFixtureRun([weatherLike('weather', CYCLE, CYCLE, 24), currentsSpec]));
    const store = new TileForecastStore({ transport: run.transport, regionalLayers: ['weather-ukv'] });
    expect(store.listedLayers()).toEqual([]);
    await store.init();
    expect(store.listedLayers().sort()).toEqual(['currents', 'weather']);
    expect(store.regionalLayerIds()).toEqual(['weather-ukv']);
  });
});

describe('TileForecastStore.hasTile', () => {
  const NOW = parseUtc('2026-07-20T04:00Z');

  it('is true for a tile in the cache or retained decoded, false otherwise, and never fetches', async () => {
    const run = recording(buildFixtureRun([weatherLike('weather', CYCLE, CYCLE, 24)]));
    const cache = new MemoryTileCache();
    const store = new TileForecastStore({ transport: run.transport, cache, now: () => NOW });
    await store.init();
    expect(await store.hasTile('weather', 'N40W010')).toBe(false);
    expect(await store.hasTile('nope', 'N40W010')).toBe(false);
    await store.getPointForecasts([{ lat: 45, lon: -5 }], NOW, NOW + 3_600_000);
    expect(await store.hasTile('weather', 'N40W010')).toBe(true);
    expect(await store.hasTile('weather', 'N50W010')).toBe(false);
    expect([...run.fetched]).toEqual(['weather/N40W010']);
    // dropped from the cache but still retained decoded: no fetch needed
    await cache.delete(tileCacheKey(store.manifestFor('weather')!, 'N40W010'));
    expect(await store.hasTile('weather', 'N40W010')).toBe(true);
  });

  it('reports nothing present for a cache without has, or one that fails', async () => {
    const run = recording(buildFixtureRun([weatherLike('weather', CYCLE, CYCLE, 24)]));
    const base = new MemoryTileCache();
    const without = { get: base.get.bind(base), put: base.put.bind(base), delete: base.delete.bind(base), evictExcept: base.evictExcept.bind(base) };
    const failing = { ...without, has: async () => { throw new Error('storage unavailable'); } };
    for (const cache of [without, failing]) {
      const store = new TileForecastStore({ transport: run.transport, cache, now: () => NOW, maxDecodedBytes: 0 });
      await store.getPointForecasts([{ lat: 45, lon: -5 }], NOW, NOW + 3_600_000);
      expect(await store.hasTile('weather', 'N40W010')).toBe(false);
    }
  });
});
