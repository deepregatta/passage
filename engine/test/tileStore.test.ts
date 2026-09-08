import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TileForecastStore } from '../src/forecast/tileStore.js';
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
