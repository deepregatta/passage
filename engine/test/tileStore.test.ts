import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fnv1a64Hex } from '../src/hash.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { decodeTile, encodeTile, type DecodedTile } from '../src/forecast/tileCodec.js';
import { MemoryTileCache } from '../src/forecast/store.js';
import { parseUtc } from '../src/eta.js';
import { computeRoute } from '../src/routing/isochrone.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const CYCLE = '2026-07-20T00:00Z';
const START = parseUtc('2026-07-20T00:00Z');
const END = parseUtc('2026-07-20T12:00Z');

/** weather layer: uniform 10 kt westerly (u=+10, v=0), gust rises 1 kt per 3h step */
function weatherSpec(overrides: Partial<FixtureLayerSpec> = {}): FixtureLayerSpec {
  return {
    layer: 'weather',
    model: 'gfs_0p25',
    cycle: CYCLE,
    resolution_deg: 0.25,
    time_axes: {
      hourly: { base: CYCLE, offsets_h: [0, 3, 6, 9, 12, 15, 18, 21, 24] },
      h3: { base: CYCLE, offsets_h: [0, 6, 12, 18, 24] },
    },
    variables: [
      { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 10 },
      { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 0 },
      { name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: (_m, t) => 15 + t },
      { name: 'visibility_m', axis: 'h3', dtype: 'i16', scale: 50, value: () => 10000 },
      { name: 'cape_jkg', axis: 'h3', dtype: 'i16', scale: 1, value: () => 50 },
      { name: 'temp_c', axis: 'h3', dtype: 'i16', scale: 0.1, value: () => 15 },
      { name: 'dew_point_c', axis: 'h3', dtype: 'i16', scale: 0.1, value: () => 10 },
      { name: 'precip_mm', axis: 'h3', dtype: 'i16', scale: 0.1, value: () => 0 },
    ],
    tiles: [
      [40, -10],
      [50, -10],
    ],
    ...overrides,
  };
}

function ensembleSpec(): FixtureLayerSpec {
  return {
    layer: 'ensemble',
    model: 'gefs_0p50',
    cycle: CYCLE,
    resolution_deg: 0.5,
    member_count: 5,
    time_axes: { steps: { base: CYCLE, offsets_h: [0, 6, 12, 18, 24] } },
    variables: [
      { name: 'wind_kt_mean', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => 12 },
      {
        name: 'wind_kt_anom',
        axis: 'steps',
        dtype: 'i8',
        scale: 0.2,
        per_member: true,
        value: (m) => (m - 2) * 2, // members: 8, 10, 12, 14, 16 kt
      },
    ],
    tiles: [
      [40, -10],
      [50, -10],
    ],
  };
}

function currentsSpec(): FixtureLayerSpec {
  return {
    layer: 'currents',
    model: 'glo12',
    cycle: CYCLE,
    resolution_deg: 0.25, // fixture keeps 0.25 to stay small; real layer is 1/12°
    time_axes: { h6: { base: CYCLE, offsets_h: [0, 6, 12, 18, 24] } },
    variables: [
      { name: 'cur_u_kt', axis: 'h6', dtype: 'i16', scale: 0.01, value: () => 1 },
      { name: 'cur_v_kt', axis: 'h6', dtype: 'i16', scale: 0.01, value: () => 0.5 },
    ],
    tiles: [
      [40, -10],
      [50, -10],
    ],
  };
}

const POINT = { lat: 49.5, lon: -3.5 + -1.5 }; // 49.5, -5.0 inside N40W010

describe('TileForecastStore point forecasts', () => {
  it('assembles hourly wind speed/direction/gust from u/v tiles', async () => {
    const store = new TileForecastStore({
      transport: buildFixtureRun([weatherSpec()]),
      now: () => parseUtc('2026-07-20T04:00Z'),
    });
    const { forecasts, meta } = await store.getPointForecasts([{ lat: 45, lon: -5 }], START, END);
    const fc = forecasts[0]!;
    expect(fc.times[0]).toBe('2026-07-20T00:00:00Z');
    expect(fc.times).toHaveLength(13); // hourly 00..12 inclusive
    // uniform u=+10, v=0 -> 10 kt from the west (270°)
    expect(fc.wind_kt[0]).toBeCloseTo(10, 1);
    expect(fc.wind_dir_deg[0]).toBeCloseTo(270, 0);
    // gust 15 + step, resampled hourly between 3-hourly steps: at 01:00 -> 15.33
    expect(fc.gust_kt[0]).toBeCloseTo(15, 1);
    expect(fc.gust_kt[1]).toBeCloseTo(15 + 1 / 3, 1);
    expect(fc.gust_kt[3]).toBeCloseTo(16, 1);

    expect(meta.source).toBe('tiles');
    expect(meta.run_id).toBe('weather-20260720T00Z');
    expect(meta.cycle).toBe(CYCLE);
    expect(meta.tiles).toEqual(['N40W010']);
  });

  it('returns empty series (not an error) outside tile coverage', async () => {
    const store = new TileForecastStore({ transport: buildFixtureRun([weatherSpec()]) });
    const { forecasts } = await store.getPointForecasts([{ lat: -30, lon: 100 }], START, END);
    expect(forecasts[0]!.times).toEqual([]);
  });

  it('serves repeat reads from the tile cache', async () => {
    const transport = buildFixtureRun([weatherSpec()]);
    let fetches = 0;
    const counting = Object.create(transport) as typeof transport;
    counting.fetchTile = async (runId: string, path: string) => {
      fetches += 1;
      return transport.fetchTile(runId, path);
    };
    const store = new TileForecastStore({ transport: counting });
    await store.getPointForecasts([{ lat: 45, lon: -5 }], START, END);
    const again = await store.getPointForecasts([{ lat: 44, lon: -4 }], START, END);
    expect(fetches).toBe(1); // same tile, decoded once
    expect(again.meta.tiles).toEqual(['N40W010']);
  });
});

describe('TileForecastStore ensemble', () => {
  it('reconstructs member series from mean + anomalies and reports the member count', async () => {
    const store = new TileForecastStore({
      transport: buildFixtureRun([weatherSpec(), ensembleSpec()]),
    });
    const result = await store.getEnsembleForecasts([{ lat: 45, lon: -5 }], START, END);
    expect(result).not.toBeNull();
    const fc = result!.forecasts[0]!;
    expect(fc.wind_kt_members).toHaveLength(5);
    const at0 = fc.wind_kt_members.map((m) => m[0]);
    expect(at0.map((v) => Math.round(v! * 10) / 10)).toEqual([8, 10, 12, 14, 16]);
    expect(result!.meta.member_count).toBe(5);
    expect(store.describe().ensemble!.member_count).toBe(5);
  });

  it('returns null when the layer is absent', async () => {
    const store = new TileForecastStore({ transport: buildFixtureRun([weatherSpec()]) });
    expect(await store.getEnsembleForecasts([{ lat: 45, lon: -5 }], START, END)).toBeNull();
  });
});

describe('TileForecastStore grids', () => {
  it('maps each tile axis by timestamp and keeps clipped windows, missing steps and cells distinct', async () => {
    const spec = weatherSpec({
      resolution_deg: 1,
      time_axes: { hourly: { base: CYCLE, offsets_h: [0, 3, 9, 18] } },
      variables: [
        { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 1,
          value: (_m, t, i, j) => 100 * t + 10 * i + j },
        { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 1,
          value: (_m, t, i, j) => i === 0 && j === 5 ? NaN : -100 * t - 10 * i - j },
      ],
    });
    const transport = buildFixtureRun([spec]);
    // The north tile's first timestamp is absent from the manifest axis and
    // its 3h step is missing. Reusing the south tile's indices would shift data.
    const runId = transport.latest.layers.weather!.run_id;
    const key = `${runId}/weather/z1/N50W010.bin`;
    const north = decodeTile(gunzipSync(transport.tiles.get(key)!));
    north.header.time_axes.hourly = { base: CYCLE, offsets_h: [-3, 0, 9, 18] };
    const bytes = new Uint8Array(gzipSync(encodeTile(north.header, north.arrays)));
    transport.tiles.set(key, bytes);
    transport.manifests.get(runId)!.tiles.N50W010 = { bytes: bytes.length, fnv64: fnv1a64Hex(bytes) };
    const store = new TileForecastStore({ transport, now: () => START });
    const bbox = { minLat: 49, maxLat: 50, minLon: -6, maxLon: -5 };
    const grid = await store.getWindGrid(bbox, '2026-07-20T04:00Z', 6);
    expect(grid.time_axis).toEqual(['2026-07-20T03:00:00Z', '2026-07-20T09:00:00Z', '2026-07-20T18:00:00Z']);
    expect(grid.u_kt).toEqual([194, 195, null, null, 294, 295, 204, 205, 394, 395, 304, 305]);
    expect(grid.v_kt).toEqual([-194, -195, null, null, -294, -295, -204, null, -394, -395, -304, null]);

    const early = await store.getWindGrid(bbox, CYCLE, 0);
    expect(early.time_axis).toEqual(['2026-07-20T00:00:00Z']);
    expect(early.u_kt).toEqual([94, 95, 104, 105]);
    expect(early.v_kt).toEqual([-94, -95, -104, null]);
  });

  it('preserves nulls for absent tiles and reports wholly missing wind/current coverage', async () => {
    const store = new TileForecastStore({ transport: buildFixtureRun([
      weatherSpec({ tiles: [[40, -10]], resolution_deg: 1 }),
      { ...currentsSpec(), tiles: [[40, -10]], resolution_deg: 1 },
    ]) });
    const grid = await store.getWindGrid({ minLat: 49, maxLat: 50, minLon: -6, maxLon: -5 }, CYCLE, 0);
    expect(grid.u_kt).toEqual([10, 10, null, null]);
    expect(grid.v_kt).toEqual([0, 0, null, null]);
    const outside = { minLat: 60, maxLat: 61, minLon: -6, maxLon: -5 };
    await expect(store.getWindGrid(outside, CYCLE, 0)).rejects.toThrow('Forecast tiles unavailable for this area');
    expect(await store.getCurrentGrid(outside, CYCLE, 0)).toBeNull();
  });

  it('mosaics a wind RegionGrid that validates against the region-grid contract', async () => {
    const store = new TileForecastStore({
      transport: buildFixtureRun([weatherSpec(), currentsSpec()]),
      now: () => parseUtc('2026-07-20T04:00Z'),
    });
    const grid = await store.getWindGrid(
      { minLat: 44, maxLat: 46, minLon: -6, maxLon: -4 },
      '2026-07-20T00:00Z',
      12,
    );
    expect(grid.kind).toBe('wind10m');
    expect(grid.run_id).toBe('weather-20260720T00Z');
    expect(grid.u_kt.every((v) => v === null || Math.abs(v - 10) < 0.02)).toBe(true);

    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(join(REPO, 'contracts', 'region-grid.schema.json'), 'utf8'),
    );
    expect(ajv.validate(schema, grid)).toBe(true);
  });

  it('spans tiles: a bbox across two tile rows samples both', async () => {
    const store = new TileForecastStore({ transport: buildFixtureRun([weatherSpec()]) });
    const grid = await store.getWindGrid(
      { minLat: 49, maxLat: 51, minLon: -6, maxLon: -4 },
      '2026-07-20T00:00Z',
      6,
    );
    // values exist above and below the 50° tile boundary
    const midRow = Math.floor(grid.nlat / 2);
    expect(grid.u_kt[0 * grid.nlat * grid.nlon + 0]).not.toBeNull();
    expect(grid.u_kt[0 * grid.nlat * grid.nlon + midRow * grid.nlon]).not.toBeNull();
    expect(grid.u_kt[0 * grid.nlat * grid.nlon + (grid.nlat - 1) * grid.nlon]).not.toBeNull();
  });

  it('routes end to end on a mosaic grid (uniform westerly)', async () => {
    const store = new TileForecastStore({ transport: buildFixtureRun([weatherSpec()]) });
    const grid = await store.getWindGrid(
      { minLat: 44, maxLat: 46, minLon: -6, maxLon: -4 },
      '2026-07-20T00:00Z',
      24,
    );
    const result = computeRoute({
      start: { lat: 44.55, lon: -5.55 },
      finish: { lat: 44.55, lon: -4.55 },
      departureUtc: '2026-07-20T00:00:00Z',
      windGrid: grid,
      maxHours: 24,
      polar: {
        schema_version: 1, polar_id: 'test', label: 'Test',
        tws_kt: [6, 12, 20], twa_deg: [45, 90, 135, 180],
        speeds_kt: [[3, 4, 4, 3], [5, 6.5, 6, 5], [6, 7, 7, 6]],
        source: { kind: 'test' },
      },
    });
    expect(result.distance_nm).toBeGreaterThan(20);
  });

  it('builds a current grid on the native 6-hourly axis', async () => {
    const store = new TileForecastStore({
      transport: buildFixtureRun([weatherSpec(), currentsSpec()]),
    });
    const grid = await store.getCurrentGrid(
      { minLat: 44, maxLat: 46, minLon: -6, maxLon: -4 },
      '2026-07-20T00:00Z',
      12,
    );
    expect(grid).not.toBeNull();
    expect(grid!.kind).toBe('surface_current');
    expect(grid!.time_axis.length).toBe(3); // 00, 06, 12
    expect(grid!.u_kt[0]).toBeCloseTo(1, 2);
    expect(grid!.v_kt[0]).toBeCloseTo(0.5, 2);
  });
});

describe('TileForecastStore resilience', () => {
  // Use real stored-object bytes here: manifest hashes cover gzip, not PFT1.
  function storedFixture() {
    const transport = buildFixtureRun([weatherSpec({ tiles: [[40, -10]] })]);
    const runId = transport.latest.layers.weather!.run_id;
    const manifest = transport.manifests.get(runId)!;
    const path = manifest.tiling.path_template.replace('{tile_id}', 'N40W010');
    const key = `${runId}/${path}`;
    const bytes = transport.tiles.get(key)!;
    return { transport, runId, key, bytes, manifest };
  }

  it('shares one cold fetch across deterministic, hazard and grid consumers', async () => {
    const { transport } = storedFixture();
    const fetches = vi.spyOn(transport, 'fetchTile');
    const store = new TileForecastStore({ transport });
    const [point, hazard, grid] = await Promise.all([
      store.getPointForecasts([POINT], START, END),
      store.getHazardForecasts([POINT], START, END),
      store.getWindGrid({ minLat: 49, maxLat: 49.5, minLon: -5, maxLon: -4.5 }, CYCLE, 3),
    ]);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(point.forecasts[0]!.wind_kt[0]).toBe(10);
    expect(hazard!.byModel.gfs_0p25![0]!.wind_kt[0]).toBe(10);
    expect(grid.u_kt[0]).toBe(10);
    expect(point.meta.cached_tiles).toBe(0);
    expect(hazard!.meta[0]!.cached_tiles).toBe(0);
  });

  it.each(['checksum', 'legacy raw'])('evicts %s cache bytes and shares one fresh refetch', async kind => {
    const { transport, runId, key, bytes } = storedFixture();
    const corrupt = bytes.slice();
    corrupt[4] = corrupt[4]! ^ 1; // gzip mtime: still decodes, but the checksum differs
    const cache = new MemoryTileCache();
    await cache.put(key, kind === 'checksum' ? corrupt : new Uint8Array([80, 70, 84, 49]), runId);
    await cache.put(`${runId}/healthy`, new Uint8Array([1]), runId);
    const remove = vi.spyOn(cache, 'delete');
    const fetches = vi.spyOn(transport, 'fetchTile').mockImplementation(async () => {
      expect(await cache.get(key)).toBeNull();
      return bytes;
    });
    const store = new TileForecastStore({ transport, cache });
    const [point, hazard] = await Promise.all([
      store.getPointForecasts([POINT], START, END), store.getHazardForecasts([POINT], START, END),
    ]);
    expect(point.forecasts[0]!.wind_kt[0]).toBe(10);
    expect(hazard!.byModel.gfs_0p25![0]!.wind_kt[0]).toBe(10);
    expect(point.meta.cached_tiles).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(fetches.mock.calls[0]![2]).toEqual({ cache: 'reload' });
    expect(await cache.get(key)).toEqual(bytes);
    expect(await cache.get(`${runId}/healthy`)).toEqual(new Uint8Array([1]));
    const nextStore = new TileForecastStore({ transport, cache });
    const cached = await nextStore.getPointForecasts([POINT], START, END);
    expect(cached.meta.cached_tiles).toBe(1);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it.each(['checksum', 'gzip', 'PFT1'])('bounds corrupt %s downloads and never caches them', async kind => {
    const { transport, bytes, manifest, key } = storedFixture();
    let bad = bytes.slice();
    if (kind === 'checksum') bad[4] = bad[4]! ^ 1;
    else {
      bad = kind === 'gzip' ? new Uint8Array([1, 2, 3]) : new Uint8Array(gzipSync('not a tile'));
      manifest.tiles.N40W010 = { bytes: bad.length, fnv64: fnv1a64Hex(Buffer.from(bad).toString('latin1')) };
    }
    const fetches = vi.spyOn(transport, 'fetchTile').mockResolvedValue(bad);
    const cache = new MemoryTileCache();
    const writes = vi.spyOn(cache, 'put');
    const store = new TileForecastStore({ transport, cache });
    await expect(store.getPointForecasts([POINT], START, END)).rejects.toThrow(`forecast tile invalid: ${key}`);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(fetches.mock.calls[1]![2]).toEqual({ cache: 'reload' });
    expect(writes).not.toHaveBeenCalled();
    expect(await cache.get(key)).toBeNull();
  });

  it('clears a failed shared fetch so a later analysis can recover', async () => {
    const { transport, bytes } = storedFixture();
    const error = new Error('offline');
    const fetches = vi.spyOn(transport, 'fetchTile').mockRejectedValueOnce(error).mockResolvedValue(bytes);
    const store = new TileForecastStore({ transport });
    const results = await Promise.allSettled([
      store.getPointForecasts([POINT], START, END), store.getHazardForecasts([POINT], START, END),
    ]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect((await store.getPointForecasts([POINT], START, END)).forecasts[0]!.wind_kt[0]).toBe(10);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it('bypasses one corrupt HTTP cache response and stores only the repaired tile', async () => {
    const { transport, bytes, key } = storedFixture();
    const corrupt = bytes.slice();
    corrupt[4] = corrupt[4]! ^ 1;
    const fetches = vi.spyOn(transport, 'fetchTile').mockResolvedValueOnce(corrupt).mockResolvedValue(bytes);
    const cache = new MemoryTileCache();
    const writes = vi.spyOn(cache, 'put');
    const store = new TileForecastStore({ transport, cache });
    expect((await store.getPointForecasts([POINT], START, END)).forecasts[0]!.wind_kt[0]).toBe(10);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(fetches.mock.calls[1]![2]).toEqual({ cache: 'reload' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await cache.get(key)).toEqual(bytes);
  });

  it('allows only one refetch after cache corruption and recovers on a later call', async () => {
    const { transport, bytes, key, runId } = storedFixture();
    const corrupt = bytes.slice();
    corrupt[4] = corrupt[4]! ^ 1;
    const fetches = vi.spyOn(transport, 'fetchTile').mockResolvedValueOnce(corrupt).mockResolvedValue(bytes);
    const cache = new MemoryTileCache();
    await cache.put(key, corrupt, runId);
    const store = new TileForecastStore({ transport, cache });
    await expect(store.getPointForecasts([POINT], START, END)).rejects.toThrow('checksum mismatch');
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(await cache.get(key)).toBeNull();
    expect((await store.getPointForecasts([POINT], START, END)).forecasts[0]!.wind_kt[0]).toBe(10);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it('can use a fresh tile when cache reads, deletes and writes are unavailable', async () => {
    const { transport, bytes } = storedFixture();
    const cache = new MemoryTileCache();
    vi.spyOn(cache, 'get').mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValue(new Error('storage unavailable'));
    vi.spyOn(cache, 'delete').mockRejectedValue(new Error('storage unavailable'));
    vi.spyOn(cache, 'put').mockRejectedValue(new Error('storage unavailable'));
    const fetches = vi.spyOn(transport, 'fetchTile').mockResolvedValue(bytes);
    for (let i = 0; i < 2; i++) {
      const store = new TileForecastStore({ transport, cache });
      expect((await store.getPointForecasts([POINT], START, END)).forecasts[0]!.wind_kt[0]).toBe(10);
    }
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it('reads layer manifests concurrently while preserving fallback, layer and eviction order', async () => {
    const transport = buildFixtureRun([weatherSpec(), ensembleSpec(), currentsSpec()]);
    const weatherRun = transport.latest.layers.weather!.run_id;
    const ensembleRun = transport.latest.layers.ensemble!.run_id;
    const currentsRun = transport.latest.layers.currents!.run_id;
    const brokenWeather = 'weather-20260720T06Z';
    const brokenCurrents = 'currents-20260720T06Z';
    Object.assign(transport.latest.layers.weather!, { run_id: brokenWeather, previous_run_id: weatherRun });
    Object.assign(transport.latest.layers.currents!, { run_id: brokenCurrents, previous_run_id: currentsRun });
    transport.failManifests.add(currentsRun);
    const runIds = [brokenWeather, ensembleRun, brokenCurrents, weatherRun, currentsRun];
    const releases = new Map<string, () => void>();
    const gates = new Map(runIds.map((runId) => [runId, new Promise<void>((resolve) => releases.set(runId, resolve))]));
    const fetchManifest = transport.fetchManifest.bind(transport);
    const reads = vi.spyOn(transport, 'fetchManifest').mockImplementation(async (runId) => {
      await gates.get(runId);
      return fetchManifest(runId);
    });
    const cache = new MemoryTileCache();
    const evict = vi.spyOn(cache, 'evictExcept');
    const store = new TileForecastStore({ transport, cache });
    const pending = store.init();
    expect(store.init()).toBe(pending);
    try {
      await vi.waitFor(() => expect([...reads.mock.calls]).toEqual([
        [brokenWeather], [ensembleRun], [brokenCurrents],
      ]));
      expect(evict).not.toHaveBeenCalled();
      // Finish the later layers first; previous runs must wait for their own current failure.
      releases.get(ensembleRun)!();
      releases.get(brokenCurrents)!();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(currentsRun));
      expect(reads).not.toHaveBeenCalledWith(weatherRun);
      releases.get(currentsRun)!();
      releases.get(brokenWeather)!();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(weatherRun));
      expect(evict).not.toHaveBeenCalled();
      releases.get(weatherRun)!();
      await pending;
      expect(Object.keys(store.describe())).toEqual(['weather', 'ensemble']);
      expect(store.describe().weather!.run_id).toBe(weatherRun);
      expect(evict).toHaveBeenCalledExactlyOnceWith([weatherRun, ensembleRun]);
    } finally {
      releases.forEach((release) => release());
      await pending;
    }
  });

  it('shares a failed latest read, then retries and keeps successful initialization', async () => {
    const transport = buildFixtureRun([weatherSpec()]);
    const error = new Error('temporary transport failure');
    const fetchLatest = vi.spyOn(transport, 'fetchLatest').mockRejectedValueOnce(error);
    const store = new TileForecastStore({ transport });
    const first = store.init();
    expect(store.init()).toBe(first);
    await expect(first).rejects.toBe(error);

    const retry = store.init();
    expect(store.init()).toBe(retry);
    await retry;
    const { forecasts } = await store.getPointForecasts([POINT], START, END);
    expect(forecasts[0]!.wind_kt[0]).toBeCloseTo(10, 1);
    expect(store.init()).toBe(retry);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('retries failed weather manifests without retaining optional layers from the failed attempt', async () => {
    const transport = buildFixtureRun([weatherSpec(), ensembleSpec()]);
    const weatherRun = transport.latest.layers.weather!.run_id;
    transport.failManifests.add(weatherRun);
    const store = new TileForecastStore({ transport });
    await expect(store.init()).rejects.toThrow('no readable weather run');

    transport.failManifests.delete(weatherRun);
    delete transport.latest.layers.ensemble;
    await store.init();
    expect(Object.keys(store.describe())).toEqual(['weather']);
    expect(await store.getEnsembleForecasts([POINT], START, END)).toBeNull();
    const { forecasts } = await store.getPointForecasts([POINT], START, END);
    expect(forecasts[0]!.wind_kt[0]).toBeCloseTo(10, 1);
  });

  it('falls back to the previous run when the current manifest is unreadable', async () => {
    const transport = buildFixtureRun([weatherSpec()]);
    const currentRunId = transport.latest.layers.weather!.run_id;
    // repoint latest at a broken run, retaining the good one as previous
    transport.latest.layers.weather = {
      ...transport.latest.layers.weather!,
      run_id: 'weather-20260720T06Z',
      previous_run_id: currentRunId,
    };
    transport.failManifests.add('weather-20260720T06Z');
    const store = new TileForecastStore({ transport });
    const { meta } = await store.getPointForecasts([{ lat: 45, lon: -5 }], START, END);
    expect(meta.run_id).toBe(currentRunId);
  });

  it('drops an optional layer whose runs are unreadable instead of failing', async () => {
    const transport = buildFixtureRun([weatherSpec(), ensembleSpec()]);
    transport.failManifests.add(transport.latest.layers.ensemble!.run_id);
    const store = new TileForecastStore({ transport });
    await store.init();
    expect(store.describe().ensemble).toBeUndefined();
    expect(await store.getEnsembleForecasts([POINT], START, END)).toBeNull();
  });
});

describe('TileForecastStore decoded memory budget', () => {
  // Inspect retained arrays, not process heap/GC timing. Compressed cache bytes
  // are separate and must remain available after decoded eviction.
  function retained(store: TileForecastStore) {
    const layers = (store as unknown as {
      layers: Map<string, { decoded: Map<string, DecodedTile | null> }>;
    }).layers;
    const entries = [...layers.values()].flatMap(state => [...state.decoded.values()]);
    return {
      count: entries.length,
      bytes: entries.reduce((sum, tile) => sum + (tile
        ? Object.values(tile.arrays).reduce((n, array) => n + array.byteLength, 0) : 0), 0),
    };
  }
  const smallWeather = (tiles: Array<[number, number]> = [[40, -10], [50, -10], [60, -10]]) =>
    weatherSpec({ resolution_deg: 1, tiles });
  // 100 cells, three 9-step and five 5-step Float32 variables.
  const weatherBytes = 100 * (3 * 9 + 5 * 5) * 4;
  const pointAt = (lat: number) => ({ lat, lon: -5 });

  it('bounds twelve consecutive tiles and re-decodes evicted bytes without downloading again', async () => {
    const tiles: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [-60 + i * 10, -10]);
    const transport = buildFixtureRun([smallWeather(tiles)]);
    const fetches = vi.spyOn(transport, 'fetchTile');
    const cache = new MemoryTileCache();
    const reads = vi.spyOn(cache, 'get');
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes: weatherBytes * 2 });
    for (const [lat] of tiles) {
      const result = await store.getPointForecasts([pointAt(lat + 1)], START, END);
      expect(result.forecasts[0]!.wind_kt[0]).toBe(10);
      expect(retained(store).bytes).toBeLessThanOrEqual(weatherBytes * 2);
    }
    expect(retained(store)).toEqual({ count: 2, bytes: weatherBytes * 2 });
    const again = await store.getPointForecasts([pointAt(-59)], START, END);
    expect(again.forecasts[0]!.wind_kt[0]).toBe(10);
    expect(again.meta.cached_tiles).toBe(1);
    expect(reads).toHaveBeenCalledTimes(13);
    expect(fetches).toHaveBeenCalledTimes(12);
  });

  it('refreshes recency on hits and evicts the least recently used tile', async () => {
    const transport = buildFixtureRun([smallWeather()]);
    const cache = new MemoryTileCache();
    const reads = vi.spyOn(cache, 'get');
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes: weatherBytes * 2 });
    const read = (lat: number) => store.getPointForecasts([pointAt(lat)], START, END);
    await read(41);
    await read(51);
    await read(41);
    await read(61); // 51 was oldest
    await read(41);
    expect(reads).toHaveBeenCalledTimes(3);
    await read(51);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(retained(store)).toEqual({ count: 2, bytes: weatherBytes * 2 });
  });

  it('shares one byte budget across layers with different decoded sizes', async () => {
    const transport = buildFixtureRun([smallWeather(), { ...ensembleSpec(), resolution_deg: 1 }]);
    const cache = new MemoryTileCache();
    const reads = vi.spyOn(cache, 'get');
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes: weatherBytes });
    await store.getPointForecasts([pointAt(41)], START, END);
    const ensemble = await store.getEnsembleForecasts([pointAt(41)], START, END);
    expect(ensemble!.forecasts[0]!.wind_kt_members.map(m => m[0])).toEqual([8, 10, 12, 14, 16]);
    // Mean plus five anomaly members, five steps, 100 cells, float32.
    expect(retained(store)).toEqual({ count: 1, bytes: 6 * 5 * 100 * 4 });
    await store.getPointForecasts([pointAt(41)], START, END);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(retained(store)).toEqual({ count: 1, bytes: weatherBytes });
  });

  it.each([0, weatherBytes - 1])('serves but does not retain oversized tiles with budget %s', async maxDecodedBytes => {
    const transport = buildFixtureRun([smallWeather()]);
    const cache = new MemoryTileCache();
    const reads = vi.spyOn(cache, 'get');
    const fetches = vi.spyOn(transport, 'fetchTile');
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes });
    for (let i = 0; i < 2; i++) {
      expect((await store.getPointForecasts([pointAt(41)], START, END)).forecasts[0]!.wind_kt[0]).toBe(10);
      expect(retained(store)).toEqual({ count: 0, bytes: 0 });
    }
    expect(reads).toHaveBeenCalledTimes(2);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it('evicts multiple smaller tiles when a larger tile needs their combined space', async () => {
    const transport = buildFixtureRun([
      smallWeather(), { ...ensembleSpec(), resolution_deg: 1, tiles: [[40, -10], [50, -10], [60, -10]] },
    ]);
    const store = new TileForecastStore({ transport, maxDecodedBytes: 36_000 });
    await store.getEnsembleForecasts([pointAt(41), pointAt(51), pointAt(61)], START, END);
    expect(retained(store)).toEqual({ count: 3, bytes: 36_000 });
    await store.getPointForecasts([pointAt(41)], START, END);
    expect(retained(store)).toEqual({ count: 2, bytes: weatherBytes + 12_000 });
  });

  it('leaves smaller cached tiles intact when serving an oversized tile', async () => {
    const transport = buildFixtureRun([smallWeather(), { ...ensembleSpec(), resolution_deg: 1 }]);
    const cache = new MemoryTileCache();
    const reads = vi.spyOn(cache, 'get');
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes: 12_000 });
    await store.getEnsembleForecasts([pointAt(41)], START, END);
    await store.getPointForecasts([pointAt(41)], START, END);
    const again = await store.getEnsembleForecasts([pointAt(41)], START, END);
    expect(again!.meta.cached_tiles).toBe(1);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(retained(store)).toEqual({ count: 1, bytes: 12_000 });
  });

  it('does not accumulate negative entries for missing tiles', async () => {
    const transport = buildFixtureRun([smallWeather()]);
    const fetches = vi.spyOn(transport, 'fetchTile');
    const store = new TileForecastStore({ transport, maxDecodedBytes: 0 });
    for (let lat = -80; lat < 0; lat += 10) {
      const result = await store.getPointForecasts([pointAt(lat)], START, END);
      expect(result.forecasts[0]!.times).toEqual([]);
      expect(result.meta.cached_tiles).toBe(0);
    }
    expect(retained(store)).toEqual({ count: 0, bytes: 0 });
    expect(fetches).not.toHaveBeenCalled();
  });

  it('preserves concurrent point, hazard and multi-tile grid results during eviction', async () => {
    const transport = buildFixtureRun([smallWeather()]);
    const store = new TileForecastStore({ transport, maxDecodedBytes: weatherBytes });
    const bbox = { minLat: 49, maxLat: 51, minLon: -6, maxLon: -4 };
    const baseline = new TileForecastStore({ transport });
    const expected = await baseline.getWindGrid(bbox, CYCLE, 6);
    const [point, hazard, grid] = await Promise.all([
      store.getPointForecasts([pointAt(41), pointAt(61)], START, END),
      store.getHazardForecasts([pointAt(41), pointAt(51)], START, END),
      store.getWindGrid(bbox, CYCLE, 6),
    ]);
    expect(point.forecasts.map(fc => fc.wind_kt[0])).toEqual([10, 10]);
    expect(hazard!.byModel.gfs_0p25!.map(fc => fc.wind_kt[0])).toEqual([10, 10]);
    expect(grid.u_kt).toEqual(expected.u_kt);
    expect(grid.v_kt).toEqual(expected.v_kt);
    expect(grid.time_axis).toEqual(expected.time_axis);
    expect(retained(store)).toEqual({ count: 1, bytes: weatherBytes });
  });

  it('shares in-flight loads with retention disabled and recovers after a shared failure', async () => {
    const transport = buildFixtureRun([smallWeather()]);
    const originalFetch = transport.fetchTile.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetches = vi.spyOn(transport, 'fetchTile').mockImplementation(async (...args) => {
      await gate;
      return originalFetch(...args);
    });
    const cache = new MemoryTileCache();
    const store = new TileForecastStore({ transport, cache, maxDecodedBytes: 0 });
    const sharedRead = () => Promise.all([
      store.getPointForecasts([pointAt(41)], START, END),
      store.getHazardForecasts([pointAt(41)], START, END),
    ]);
    const pending = sharedRead();
    try {
      await vi.waitFor(() => expect(fetches).toHaveBeenCalledTimes(1));
    } finally {
      release();
    }
    const [point, hazard] = await pending;
    expect(point.meta.cached_tiles).toBe(0);
    expect(hazard!.meta[0]!.cached_tiles).toBe(0);
    expect(retained(store)).toEqual({ count: 0, bytes: 0 });
    vi.spyOn(cache, 'get').mockResolvedValue(null);
    fetches.mockRejectedValueOnce(new Error('offline'));
    await expect(sharedRead()).rejects.toThrow('offline');
    expect(fetches).toHaveBeenCalledTimes(2);
    const [recovered] = await sharedRead();
    expect(recovered.forecasts[0]!.wind_kt[0]).toBe(10);
    expect(fetches).toHaveBeenCalledTimes(3);
    expect(retained(store)).toEqual({ count: 0, bytes: 0 });
  });

  it.each([-1, NaN, Infinity, 1.5])('rejects invalid decoded budget %s', maxDecodedBytes => {
    expect(() => new TileForecastStore({
      transport: buildFixtureRun([smallWeather([])]), maxDecodedBytes,
    })).toThrow('maxDecodedBytes');
  });

  describe('readTile (bulk readers such as the GRIB export)', () => {
    it('exposes pinned manifests and returns null for unpublished tiles without fetching', async () => {
      const transport = buildFixtureRun([smallWeather()]);
      const fetches = vi.spyOn(transport, 'fetchTile');
      const store = new TileForecastStore({ transport });
      expect(await store.readTile('weather', 'N00W010')).toBeNull();
      expect(await store.readTile('waves', 'N40W010')).toBeNull();
      expect(fetches).not.toHaveBeenCalled();
      expect(store.manifestFor('weather')).toBe(transport.manifests.get(store.describe().weather!.run_id));
      expect(store.manifestFor('waves')).toBeNull();
      const tile = await store.readTile('weather', 'N50W010');
      expect(tile!.header).toMatchObject({ tile_id: 'N50W010', lat0: 50, lon0: -10 });
    });

    it('neither retains nor evicts decoded tiles unless asked to', async () => {
      const transport = buildFixtureRun([smallWeather()]);
      const cache = new MemoryTileCache();
      const reads = vi.spyOn(cache, 'get');
      const store = new TileForecastStore({ transport, cache, maxDecodedBytes: weatherBytes });
      await store.getPointForecasts([pointAt(41)], START, END);
      expect(retained(store)).toEqual({ count: 1, bytes: weatherBytes });
      await store.readTile('weather', 'N50W010');
      await store.readTile('weather', 'N60W010');
      expect(retained(store)).toEqual({ count: 1, bytes: weatherBytes });
      // The analysis tile is still decoded: a hit, not a cache read.
      const again = await store.getPointForecasts([pointAt(41)], START, END);
      expect(again.meta.cached_tiles).toBe(1);
      expect(reads).toHaveBeenCalledTimes(3);
      // A retained tile is served as is; retain: true opts in to the LRU.
      expect(await store.readTile('weather', 'N40W010')).toBe(await store.readTile('weather', 'N40W010'));
      expect(reads).toHaveBeenCalledTimes(3);
      await store.readTile('weather', 'N60W010', { retain: true });
      expect(retained(store).count).toBe(1);
      await store.getPointForecasts([pointAt(61)], START, END);
      expect(reads).toHaveBeenCalledTimes(4);
    });

    it('shares one in-flight load with the analysis, which still retains the tile', async () => {
      const transport = buildFixtureRun([smallWeather()]);
      const fetches = vi.spyOn(transport, 'fetchTile');
      const cache = new MemoryTileCache();
      const reads = vi.spyOn(cache, 'get');
      const store = new TileForecastStore({ transport, cache });
      const [tile, point] = await Promise.all([
        store.readTile('weather', 'N40W010'),
        store.getPointForecasts([pointAt(41)], START, END),
      ]);
      expect(fetches).toHaveBeenCalledTimes(1);
      expect(point.forecasts[0]!.wind_kt[0]).toBe(10);
      expect(tile!.header.tile_id).toBe('N40W010');
      expect(retained(store)).toEqual({ count: 1, bytes: weatherBytes });
      await store.getPointForecasts([pointAt(41)], START, END);
      expect(reads).toHaveBeenCalledTimes(1);
    });
  });
});
