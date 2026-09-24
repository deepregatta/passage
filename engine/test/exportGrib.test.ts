import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import type { DecodedTile } from '../src/forecast/tileCodec.js';
import { gribRound } from '../src/export/grib2.js';
import { MS_TO_KT } from '../src/export/gribDatasets.js';
import { planGribExport, type GribExportRequest } from '../src/export/exportPlan.js';
import {
  GribExportError,
  gribExportSourceFromStore,
  runGribExport,
  type GribExportSource,
} from '../src/export/exportGrib.js';
import { buildFixtureRun, type FixtureLayerSpec, type FixtureTileGrid } from './helpers/fixtureRun.js';
import { readGrib2 } from './helpers/grib2Reader.js';
import { buildGribFixtures, concat, GRIB_FIXTURES, readCommittedFixture, type GribFixture } from './helpers/gribFixtures.js';

const CYCLE = '2026-07-20T00:00Z';
const HOURLY = [0, 1, 2, 3, 6, 9, 12];

/** Tile value after PFT1 quantization, as the store decodes it. */
const quantized = (v: number, scale: number) => Math.fround(Math.round(v / scale) * scale);

// Values encode their position so any misplaced point shows.
const uKt = (t: number, lat: number, lon: number) => 10 + 2 * (lat - 49) + lon + 0.5 * t;
const vKt = (t: number, lat: number, lon: number) => -3 + (lat - 49) - 0.5 * lon - 0.25 * t;
const gustKt = (t: number, lat: number) => 18 + (lat - 49) + t;

function geoVar(name: string, scale: number, axis: string, f: (t: number, lat: number, lon: number) => number) {
  return {
    name, axis, dtype: 'i16' as const, scale,
    value: (_m: number, t: number, i: number, j: number, g: FixtureTileGrid) => f(t, g.lat0 + i * g.dlat, g.lon0 + j * g.dlon),
  };
}

function weatherSpec(overrides: Partial<FixtureLayerSpec> = {}): FixtureLayerSpec {
  return {
    layer: 'weather',
    model: 'gfs_0p25',
    cycle: CYCLE,
    resolution_deg: 0.25,
    time_axes: { hourly: { base: CYCLE, offsets_h: HOURLY } },
    variables: [
      geoVar('wind_u_kt', 0.01, 'hourly', uKt),
      geoVar('wind_v_kt', 0.01, 'hourly', vKt),
      geoVar('gust_kt', 0.1, 'hourly', (t, lat) => gustKt(t, lat)),
    ],
    // N50E000 is not published (an all-land tile, as the pipeline would skip).
    tiles: [[40, -10], [50, -10], [40, 0]],
    ...overrides,
  };
}

function request(overrides: Partial<GribExportRequest> = {}): GribExportRequest {
  return {
    bbox: { minLat: 49, maxLat: 51, minLon: -1, maxLon: 1 },
    datasetIds: ['wind-gfs'],
    startIso: '2026-07-20T01:30Z',
    endIso: '2026-07-20T07:00Z',
    step: 'all',
    lonConvention: '0-360',
    ...overrides,
  };
}

async function storeFor(specs: FixtureLayerSpec[]) {
  const transport = buildFixtureRun(specs);
  const store = new TileForecastStore({ transport });
  await store.init();
  return { store, transport, manifests: (layer: string) => store.manifestFor(layer) };
}

async function exportOne(specs: FixtureLayerSpec[], req: GribExportRequest) {
  const { store, manifests } = await storeFor(specs);
  const plan = planGribExport(manifests, req);
  const files = await runGribExport(gribExportSourceFromStore(store), plan);
  return { plan, files, file: files[0]!, messages: readGrib2(concat(files[0]!.parts)) };
}

describe('planGribExport', () => {
  it('selects steps inside the window plus the bracketing steps, clipped to the axis', async () => {
    const { manifests } = await storeFor([weatherSpec()]);
    const hours = (req: Partial<GribExportRequest>) =>
      planGribExport(manifests, request(req)).datasets[0]!.steps.map((s) => s.forecastHours);
    expect(hours({})).toEqual([1, 2, 3, 6, 9]);
    expect(hours({ step: 3 })).toEqual([0, 3, 6, 9]);
    expect(hours({ step: 6 })).toEqual([0, 6, 12]);
    expect(hours({ startIso: '2026-07-20T03:00Z', endIso: '2026-07-20T06:00Z' })).toEqual([3, 6]);
    expect(hours({ startIso: '2026-07-20T10:00Z', endIso: '2026-07-20T20:00Z' })).toEqual([9, 12]);
    expect(hours({ startIso: '2026-07-19T20:00Z', endIso: '2026-07-20T00:30Z' })).toEqual([0, 1]);
    const plan = planGribExport(manifests, request()).datasets[0]!;
    expect(plan.steps[0]).toEqual({ index: 1, time: '2026-07-20T01:00:00Z', forecastHours: 1 });
  });

  it('reports availability per dataset instead of failing the export', async () => {
    const ibi: FixtureLayerSpec = {
      layer: 'currents-ibi', model: 'cmems_ibi', cycle: CYCLE, resolution_deg: 1 / 36, pointsPerSide: 4,
      time_axes: { steps: { base: CYCLE, offsets_h: [0, 1, 2] } },
      variables: [geoVar('cur_u_kt', 0.01, 'steps', () => 1), geoVar('cur_v_kt', 0.01, 'steps', () => 0)],
      tiles: [[40, -10]],
    };
    const { manifests } = await storeFor([weatherSpec(), ibi]);
    const availability = (req: Partial<GribExportRequest>) => Object.fromEntries(
      planGribExport(manifests, request({ datasetIds: ['wind-gfs', 'waves-gfs', 'currents-ibi'], ...req }))
        .datasets.map((d) => [d.datasetId, d.availability]),
    );
    expect(availability({ bbox: { minLat: 49, maxLat: 51, minLon: 1, maxLon: 3 } }))
      .toEqual({ 'wind-gfs': 'ok', 'waves-gfs': 'no-layer', 'currents-ibi': 'no-tiles' });
    expect(availability({ bbox: { minLat: 44, maxLat: 45, minLon: -5, maxLon: -4 } }))
      .toEqual({ 'wind-gfs': 'ok', 'waves-gfs': 'no-layer', 'currents-ibi': 'ok' });
    expect(availability({ bbox: { minLat: 44, maxLat: 45, minLon: -5, maxLon: -4 }, startIso: '2026-07-20T05:00Z' }))
      .toEqual({ 'wind-gfs': 'ok', 'waves-gfs': 'no-layer', 'currents-ibi': 'outside-horizon' });
    expect(() => planGribExport(manifests, request({ datasetIds: ['pressure'] }))).toThrow('Unknown GRIB dataset');
  });

  it('estimates output and download size and names the file by cycle and whole-degree corners', async () => {
    const { manifests, transport } = await storeFor([weatherSpec()]);
    const plan = planGribExport(manifests, request()).datasets[0]!;
    const manifest = transport.manifests.get('weather-20260720T00Z')!;
    expect(plan.lattice).toMatchObject({ ni: 9, nj: 9 });
    // Published tiles in manifest order, then the unpublished one.
    expect(plan.tiles).toEqual([
      { id: 'N40W010', present: true, bytes: manifest.tiles.N40W010!.bytes },
      { id: 'N50W010', present: true, bytes: manifest.tiles.N50W010!.bytes },
      { id: 'N40E000', present: true, bytes: manifest.tiles.N40E000!.bytes },
      { id: 'N50E000', present: false, bytes: 0 },
    ]);
    expect(plan.downloadBytesUpperBound).toBe(Object.values(manifest.tiles).reduce((s, t) => s + t.bytes, 0));
    expect(plan.messages).toBe(5 * 3);
    // 179 bytes of sections per message, no bitmap for wind, 10 bits per value.
    expect(plan.estBytes).toBe(15 * (179 + Math.ceil((81 * 10) / 8)));
    expect(plan.fileName).toBe('passage_wind-gfs_20260720T00Z_N49W001_N51E001.grb2');
    expect(planGribExport(manifests, request({ fixture: true, bbox: { minLat: 49.3, maxLat: 50.6, minLon: -0.6, maxLon: 0.2 } }))
      .datasets[0]!.fileName).toBe('passage-fixture_wind-gfs_20260720T00Z_N49W001_N51E001.grb2');
  });

  it('exports ECMWF gust only when the run lists it', async () => {
    const ecmwf = (withGust: boolean): FixtureLayerSpec => ({
      ...weatherSpec(), layer: 'weather-ecmwf', model: 'ecmwf_ifs_0p25',
      variables: weatherSpec().variables.filter((v) => withGust || v.name !== 'gust_kt'),
    });
    for (const withGust of [false, true]) {
      const { manifests } = await storeFor([weatherSpec(), ecmwf(withGust)]);
      const plan = planGribExport(manifests, request({ datasetIds: ['wind-ecmwf'] })).datasets[0]!;
      expect(plan.variables.map((v) => v.tileVar)).toEqual(
        withGust ? ['wind_u_kt', 'wind_v_kt', 'gust_kt'] : ['wind_u_kt', 'wind_v_kt'],
      );
    }
  });

  it('rejects antimeridian-crossing, inverted and out-of-range requests', async () => {
    const { manifests } = await storeFor([weatherSpec()]);
    expect(() => planGribExport(manifests, request({ bbox: { minLat: 49, maxLat: 51, minLon: 179, maxLon: -179 } })))
      .toThrow('antimeridian');
    expect(() => planGribExport(manifests, request({ bbox: { minLat: 51, maxLat: 49, minLon: -1, maxLon: 1 } })))
      .toThrow('minLat');
    expect(() => planGribExport(manifests, request({ endIso: '2026-07-20T00:00Z' }))).toThrow('ends before');
    expect(() => planGribExport(manifests, request({ step: 2 as never }))).toThrow('step');
  });
});

describe('runGribExport', () => {
  it('mosaics tiles north→south across Greenwich, converts kt to m/s and leaves an unpublished tile missing', async () => {
    const { file, messages } = await exportOne([weatherSpec()], request());
    expect(file).toMatchObject({ messages: 15, skippedMessages: 0, run_id: 'weather-20260720T00Z', cycle: CYCLE });
    expect(file.grid).toEqual({
      ni: 9, nj: 9, south: 49, north: 51, west: -1, east: 1, step_deg: 0.25, lon_convention: '0-360',
    });
    const first = messages[0]!;
    expect(first.grid).toMatchObject({ la1: 51e6, la2: 49e6, lo1: 359e6, lo2: 1e6 });
    const hours = [1, 2, 3, 6, 9];
    messages.forEach((message, m) => {
      const step = Math.floor(m / 3);
      const t = HOURLY.indexOf(hours[step]!);
      const variable = ['wind_u_kt', 'wind_v_kt', 'gust_kt'][m % 3]!;
      expect(message.product.forecastTime).toBe(hours[step]);
      for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
          const lat = 51 - row * 0.25;
          const lon = -1 + col * 0.25;
          const value = message.values[row * 9 + col]!;
          if (lat >= 50 && lon >= 0) {
            expect(value).toBeNaN(); // N50E000 is not published
            continue;
          }
          const kt = variable === 'wind_u_kt' ? quantized(uKt(t, lat, lon), 0.01)
            : variable === 'wind_v_kt' ? quantized(vKt(t, lat, lon), 0.01) : quantized(gustKt(t, lat), 0.1);
          expect(value).toBe(gribRound(kt / MS_TO_KT, 1));
        }
      }
    });
    expect(first.bitmapIndicator).toBe(0);
    expect(file.coverage).toBeCloseTo(1 - 25 / 81, 10); // lat 50–51 × lon 0–1 missing
  });

  it('skips all-missing messages and counts them', async () => {
    const spec = weatherSpec({
      variables: [
        geoVar('wind_u_kt', 0.01, 'hourly', (t, lat, lon) => (t === 2 ? NaN : uKt(t, lat, lon))),
        geoVar('wind_v_kt', 0.01, 'hourly', vKt),
      ],
    });
    const { file, messages } = await exportOne([spec], request());
    expect(file.messages).toBe(9);
    expect(file.skippedMessages).toBe(1);
    expect(messages.map((m) => `${m.product.forecastTime}:${m.product.number}`)).toEqual([
      '1:2', '1:3', '2:3', '3:2', '3:3', '6:2', '6:3', '9:2', '9:3',
    ]);
  });

  it('reports checkpoint spot values from the rounded values actually written', async () => {
    const spec = weatherSpec({
      variables: [
        geoVar('wind_u_kt', 0.01, 'hourly', () => 10.04), // 5.165 m/s → written 5.2 → 10.1 kt
        geoVar('wind_v_kt', 0.01, 'hourly', () => 0),
        geoVar('gust_kt', 0.1, 'hourly', () => 17.3), // 8.9 m/s → 17.3 kt
      ],
    });
    const { file } = await exportOne([spec], request({ checkpoints: [{ lat: 49.62, lon: -0.9 }, { lat: 60, lon: 5 }] }));
    expect(file.checkpoints[0]).toEqual({
      lat: 49.62, lon: -0.9, grid_lat: 49.5, grid_lon: -1,
      steps: ['01', '02', '03'].map((h) => ({
        time: `2026-07-20T${h}:00:00Z`, values: { wind_kt: 10.1, wind_from_deg: 270, gust_kt: 17.3 },
      })),
    });
    // A point outside the box reports the nearest edge point, which here is missing.
    expect(file.checkpoints[1]).toMatchObject({ grid_lat: 51, grid_lon: 1 });
    expect(file.checkpoints[1]!.steps[0]!.values).toEqual({ wind_kt: null, wind_from_deg: null, gust_kt: null });

    const currents: FixtureLayerSpec = {
      layer: 'currents', model: 'cmems_glo12', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { steps: { base: CYCLE, offsets_h: [0, 6, 12] } },
      variables: [geoVar('cur_u_kt', 0.01, 'steps', () => 1), geoVar('cur_v_kt', 0.01, 'steps', () => -1)],
      tiles: [[40, -10]],
    };
    const current = await exportOne([weatherSpec(), currents], request({
      datasetIds: ['currents-global'], bbox: { minLat: 49, maxLat: 49.5, minLon: -2, maxLon: -1.5 },
      checkpoints: [{ lat: 49.2, lon: -1.8 }],
    }));
    // 1 kt east + 1 kt south, written at D = 2 in m/s: sets towards the south-east.
    // 0.51 m/s each way after rounding → 1.40 kt.
    expect(current.file.checkpoints[0]!.steps[0]!.values).toEqual({ current_kt: 1.4, current_set_deg: 135 });
  });

  it('places CMEMS-style offset grids by their own headers, taking a 10° boundary row from the tile below', async () => {
    // IBI: native rows sit just below each 1/36° lattice row, so lattice 40.0°
    // is the last row of the N30 tile, not the first row of N40.
    const ibiGrid = (lat0: number, lon0: number): FixtureTileGrid => ({
      lat0: lat0 + 1 / 36 - 0.0013, lon0: lon0 + 0.00077, dlat: 0.02777863, dlon: 0.02777863,
    });
    const byLattice = (t: number, lat: number, lon: number) =>
      (Math.round(lat * 36) - 1440) + (Math.round(lon * 36) + 360) * 0.01 + t;
    const ibi: FixtureLayerSpec = {
      layer: 'currents-ibi', model: 'cmems_ibi', cycle: CYCLE, resolution_deg: 0.02777863,
      time_axes: { steps: { base: CYCLE, offsets_h: [0, 1] } },
      variables: [geoVar('cur_u_kt', 0.01, 'steps', byLattice), geoVar('cur_v_kt', 0.01, 'steps', () => 0)],
      tiles: [[30, -10], [40, -10]],
      nativeGrid: ibiGrid,
    };
    const req = request({
      datasetIds: ['currents-ibi'], bbox: { minLat: 40, maxLat: 40.1, minLon: -9.9, maxLon: -9.8 },
      startIso: CYCLE, endIso: CYCLE,
    });
    const { plan, messages } = await exportOne([weatherSpec(), ibi], req);
    expect(plan.datasets[0]!.tiles.map((t) => t.id)).toEqual(['N30W010', 'N40W010']);
    const lattice = plan.datasets[0]!.lattice!;
    const u = messages[0]!;
    for (let row = 0; row < lattice.nj; row++) {
      for (let col = 0; col < lattice.ni; col++) {
        const kLat = lattice.kN - row;
        const kLon = lattice.kW + col;
        const kt = quantized((kLat - 1440) + (kLon + 360) * 0.01, 0.01);
        expect(u.values[row * lattice.ni + col]).toBe(gribRound(kt / MS_TO_KT, 2));
      }
    }
    // An aligned 0.25° layer on the same boundary needs no tile from below.
    const { manifests } = await storeFor([weatherSpec()]);
    expect(planGribExport(manifests, request({ bbox: { minLat: 50, maxLat: 50.5, minLon: -2, maxLon: -1 } }))
      .datasets[0]!.tiles.map((t) => t.id)).toEqual(['N50W010']);
  });

  it('absorbs GLO12 float32 coordinate drift: the true 10° column comes from the western tile', async () => {
    // Runs published before 2026-09-24 (immutable, still served): tile headers
    // claim lon0 = −9.927 for the true −9.9167 column and lat0 = 40.0037 for 40.0.
    const glo12Grid = (lat0: number, lon0: number): FixtureTileGrid => ({
      lat0: lat0 + 0.00366, lon0: lon0 + 1 / 12 - 0.0104, dlat: 0.08333588, dlon: 0.0833282,
    });
    const byLattice = (_t: number, lat: number, lon: number) =>
      (Math.round(lat * 12) - 480) + (Math.round(lon * 12) + 120) * 0.01;
    const glo12: FixtureLayerSpec = {
      layer: 'currents', model: 'cmems_glo12', cycle: CYCLE, resolution_deg: 0.08333587646484375,
      time_axes: { steps: { base: CYCLE, offsets_h: [0, 6] } },
      variables: [geoVar('cur_u_kt', 0.01, 'steps', byLattice), geoVar('cur_v_kt', 0.01, 'steps', () => 0)],
      tiles: [[40, -20], [40, -10]],
      nativeGrid: glo12Grid,
    };
    const { plan, messages } = await exportOne([weatherSpec(), glo12], request({
      datasetIds: ['currents-global'], bbox: { minLat: 40.5, maxLat: 41, minLon: -10.25, maxLon: -9.75 },
      startIso: CYCLE, endIso: CYCLE,
    }));
    const lattice = plan.datasets[0]!.lattice!;
    expect(lattice).toMatchObject({ kW: -123, kE: -117 });
    for (let row = 0; row < lattice.nj; row++) {
      for (let col = 0; col < lattice.ni; col++) {
        const kt = quantized((lattice.kN - row - 480) + (lattice.kW + col + 120) * 0.01, 0.01);
        expect(messages[0]!.values[row * lattice.ni + col]).toBe(gribRound(kt / MS_TO_KT, 2));
      }
    }
  });

  it('reads one tile at a time, reports progress and stops on abort', async () => {
    const { store, manifests } = await storeFor([weatherSpec()]);
    const plan = planGribExport(manifests, request());
    const reads = vi.fn((layer: string, id: string) => store.readTile(layer, id));
    const progress: number[] = [];
    const files = await runGribExport({ tile: reads }, plan, { onProgress: (p) => progress.push(p.done) });
    expect(reads.mock.calls.map(([, id]) => id)).toEqual(['N40W010', 'N50W010', 'N40E000']);
    expect(progress).toEqual(Array.from({ length: 3 + 15 }, (_, k) => k + 1));
    expect(files).toHaveLength(1);

    const controller = new AbortController();
    reads.mockClear();
    const aborted = runGribExport({ tile: reads }, plan, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('turns a rotated-away run (HTTP 404 or a different run id) into a reload message', async () => {
    const { store, manifests } = await storeFor([weatherSpec()]);
    const plan = planGribExport(manifests, request());
    const gone: GribExportSource = {
      tile: async () => { throw Object.assign(new Error('forecast fetch failed: HTTP 404'), { status: 404 }); },
    };
    await expect(runGribExport(gone, plan)).rejects.toMatchObject({
      name: 'GribExportError', code: 'forecast-updated',
      message: 'The forecast has been updated. Reload the page and try again.',
    });
    const other: GribExportSource = {
      tile: async (layer, id) => {
        const tile = (await store.readTile(layer, id))!;
        return { ...tile, header: { ...tile.header, run_id: 'weather-20260721T00Z' } } as DecodedTile;
      },
    };
    await expect(runGribExport(other, plan)).rejects.toBeInstanceOf(GribExportError);
    const offline: GribExportSource = { tile: async () => { throw new Error('offline'); } };
    await expect(runGribExport(offline, plan)).rejects.toThrow('offline');
  });
});

describe('golden GRIB fixtures', () => {
  let built: GribFixture[];
  beforeAll(async () => {
    built = await buildGribFixtures();
  });

  it.each(GRIB_FIXTURES.map((f) => f.name))('%s re-encodes byte-for-byte (regenerate with make:grib-fixtures)', (name) => {
    const fixture = built.find((f) => f.name === name)!;
    const committed = readCommittedFixture(name);
    expect(fixture.expected).toEqual(committed.expected);
    expect(Buffer.from(fixture.bytes).equals(Buffer.from(committed.bytes))).toBe(true);
  });

  it('agree with the independent test reader on every expected point', () => {
    for (const fixture of built) {
      const messages = readGrib2(fixture.bytes);
      expect(messages).toHaveLength(fixture.expected.messages.length);
      fixture.expected.messages.forEach((want, m) => {
        const message = messages[m]!;
        const la1 = message.grid.la1 / 1e6;
        const lo1 = message.grid.lo1 / 1e6;
        const step = message.grid.di / 1e6;
        for (const point of want.points) {
          const row = Math.round((la1 - point.lat) / step);
          const col = Math.round((((((point.lon - lo1) % 360) + 540) % 360) - 180) / step);
          const value = message.values[row * message.grid.ni + col]!;
          if (point.written === null) expect(value).toBeNaN();
          else expect(value).toBeCloseTo(point.written, 6);
        }
      });
    }
  });
});
