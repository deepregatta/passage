/**
 * Golden GRIB2 export fixtures (docs/grib-export.md). One builder feeds the
 * generator (engine/scripts/make-grib-fixtures.ts) and the byte-match test,
 * so any encoder change forces regeneration; ecCodes then re-validates the
 * committed files (analysis/tests/test_grib_export_contract.py).
 *
 * Expected values come straight from the source tiles through the simple
 * aligned mapping (tile index = lattice index − n·tile row), independent of
 * the runner's forward mapping.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeTile, type DecodedTile } from '../../src/forecast/tileCodec.js';
import { TileForecastStore } from '../../src/forecast/tileStore.js';
import type { LatestDoc, RunManifest, TileTransport } from '../../src/forecast/store.js';
import { axisTimesMs, tileIdFromOrigin } from '../../src/forecast/tileMath.js';
import { fnv1a64Hex } from '../../src/hash.js';
import { gribRound, latticeCornersMicro } from '../../src/export/grib2.js';
import { MS_TO_KT } from '../../src/export/gribDatasets.js';
import { planGribExport, type GribDatasetPlan, type GribExportRequest } from '../../src/export/exportPlan.js';
import { gribExportSourceFromStore, runGribExport, type GribExportFile } from '../../src/export/exportGrib.js';
import { buildFixtureRun, MemoryTileTransport, type FixtureLayerSpec, type FixtureVariable } from './fixtureRun.js';

export const GRIB_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/grib/', import.meta.url));
const GOLDEN_WEATHER_TILE = fileURLToPath(new URL('../fixtures/tiles/golden-N40W010-weather.bin.gz', import.meta.url));

export interface GribFixtureDefinition {
  name: string;
  description: string;
  transport: () => TileTransport;
  request: GribExportRequest;
}

export interface GribExpectedPoint {
  lat: number;
  lon: number;
  /** tile value in output units before GRIB rounding; null = missing */
  source: number | null;
  /** value a reader must decode (round(source·10^D)/10^D) */
  written: number | null;
  /** 0.5·10^-D plus half the tile quantum, in output units */
  tolerance: number;
}

export interface GribExpectedMessage {
  variable: string;
  time: string;
  /** ecCodes key → expected value */
  keys: Record<string, number | string>;
  points: GribExpectedPoint[];
}

export interface GribFixtureExpected {
  fixture: string;
  description: string;
  file: string;
  fnv64: string;
  bytes: number;
  skipped_messages: number;
  messages: GribExpectedMessage[];
}

export interface GribFixture {
  name: string;
  bytes: Uint8Array;
  expected: GribFixtureExpected;
}

const CYCLE = '2026-09-23T00:00Z';
const emptyWeather: FixtureLayerSpec = {
  layer: 'weather',
  model: 'gfs_0p25',
  cycle: CYCLE,
  resolution_deg: 0.25,
  time_axes: { hourly: { base: CYCLE, offsets_h: [0] } },
  variables: [{ name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 0 }],
  tiles: [],
};

type GeoValue = (t: number, lat: number, lon: number) => number;
const geo = (
  name: string,
  scale: number,
  axis: string,
  value: GeoValue,
): FixtureVariable => ({
  name,
  axis,
  dtype: 'i16',
  scale,
  value: (_m, t, i, j, grid) => value(t, grid.lat0 + i * grid.dlat, grid.lon0 + j * grid.dlon),
});

function goldenTransport(): TileTransport {
  const gz = new Uint8Array(readFileSync(GOLDEN_WEATHER_TILE));
  const { header } = decodeTile(new Uint8Array(gunzipSync(gz)));
  const path = 'weather/z025/{tile_id}.bin.gz';
  const manifest: RunManifest = {
    schema_version: 1,
    run_id: header.run_id,
    layer: header.layer,
    model: header.model,
    cycle: header.cycle,
    member_count: 1,
    resolution_deg: 0.25,
    horizon_h: 3,
    time_axes: header.time_axes,
    variables: header.variables.map(({ name, axis, dtype, scale }) => ({ name, axis, dtype, scale })),
    tiling: { tile_deg: 10, path_template: path },
    tiles: { N40W010: { bytes: gz.byteLength, fnv64: fnv1a64Hex(gz) } },
    totals: { tile_count: 1, bytes: gz.byteLength },
    published_at: header.generated_at,
  };
  const latest: LatestDoc = {
    schema_version: 1,
    updated_at: header.generated_at,
    layers: { weather: { run_id: header.run_id, cycle: header.cycle, published_at: header.generated_at } },
  };
  return new MemoryTileTransport(
    latest,
    new Map([[header.run_id, manifest]]),
    new Map([[`${header.run_id}/${path.replace('{tile_id}', 'N40W010')}`, gz]]),
  );
}

/** Coast in the NE of the Greenwich box: land north of 40.5° and east of 0.5°. */
const land = (lat: number, lon: number) => lat > 40.49 && lon > 0.49;
const sea = (lat: number, lon: number, v: number) => (land(lat, lon) ? NaN : v);

function wavesSpec(): FixtureLayerSpec {
  const waves = (name: string, scale: number, value: GeoValue) =>
    geo(name, scale, 'steps', (t, lat, lon) => sea(lat, lon, value(t, lat, lon)));
  return {
    layer: 'waves',
    model: 'gfswave_0p25',
    cycle: CYCLE,
    resolution_deg: 0.25,
    time_axes: { steps: { base: CYCLE, offsets_h: [0, 3, 6, 9, 12] } },
    variables: [
      // West of 0° and east of it differ, so a Greenwich mix-up shows.
      waves('hs_m', 0.01, (t, lat, lon) => 1.2 + 0.4 * (lat - 40) + 0.3 * lon + 0.05 * t),
      waves('period_s', 0.1, (t, lat) => 7 + (lat - 40) + 0.2 * t),
      waves('dir_deg', 0.1, (t, _lat, lon) => (355 + 20 * lon + 3 * t + 360) % 360),
      waves('wind_wave_h_m', 0.01, (t, lat) => 0.6 + 0.1 * (lat - 40) + 0.02 * t),
      waves('wind_wave_period_s', 0.1, (t) => 4.5 + 0.1 * t),
      waves('wind_wave_dir_deg', 0.1, (_t, lat) => 250 + 10 * (lat - 40)),
      waves('swell_h_m', 0.01, (_t, _lat, lon) => 0.9 - 0.2 * lon),
      waves('swell_period_s', 0.1, () => 11.5),
      // No swell direction at the second step: that message is all-missing and skipped.
      waves('swell_dir_deg', 0.1, (t, lat) => (t === 1 ? NaN : 280 + (lat - 40))),
    ],
    tiles: [[40, -10], [40, 0]],
  };
}

function currentsSpec(): FixtureLayerSpec {
  // A headland in the SE corner of the box; the flow reverses across it.
  const shore = (lat: number, lon: number) => lat < 40.2 && lon > -9.7;
  const current = (name: string, value: GeoValue) =>
    geo(name, 0.01, 'steps', (t, lat, lon) => (shore(lat, lon) ? NaN : value(t, lat, lon)));
  return {
    layer: 'currents',
    model: 'cmems_glo12',
    cycle: CYCLE,
    resolution_deg: 1 / 12,
    pointsPerSide: 12,
    time_axes: { steps: { base: CYCLE, offsets_h: [0, 6, 12] } },
    variables: [
      current('cur_u_kt', (t, lat, lon) => 1.5 * Math.sin((lat - 40) * 6 + t) - 0.4 * (lon + 10)),
      current('cur_v_kt', (t, lat, lon) => -0.8 + 2 * (lat - 40) + 0.3 * t - (lon + 10)),
    ],
    tiles: [[40, -10]],
  };
}

function southSpec(): FixtureLayerSpec {
  const wind = (name: string, scale: number, value: GeoValue) => geo(name, scale, 'hourly', value);
  return {
    layer: 'weather',
    model: 'gfs_0p25',
    cycle: CYCLE,
    resolution_deg: 0.25,
    time_axes: { hourly: { base: CYCLE, offsets_h: [0, 1, 2, 3] } },
    variables: [
      // Roaring forties: strong westerly veering with latitude.
      wind('wind_u_kt', 0.01, (t, lat) => 28 - 0.5 * (lat + 35) + t),
      wind('wind_v_kt', 0.01, (t, _lat, lon) => -6 + 1.5 * (lon + 6) - 0.5 * t),
      wind('gust_kt', 0.1, (t, lat) => 38 - 0.5 * (lat + 35) + t),
    ],
    tiles: [[-40, -10]],
  };
}

export const GRIB_FIXTURES: readonly GribFixtureDefinition[] = [
  {
    name: 'wind-gfs-golden',
    description: 'GFS wind + gust from the shared golden PFT1 tile: all 8×8 points, 4 hourly steps, one missing point',
    transport: goldenTransport,
    request: {
      bbox: { minLat: 40, maxLat: 41.75, minLon: -10, maxLon: -8.25 },
      datasetIds: ['wind-gfs'],
      startIso: '2026-07-13T06:00Z',
      endIso: '2026-07-13T09:00Z',
      step: 'all',
      lonConvention: '0-360',
      checkpoints: [{ lat: 40.3, lon: -9.6 }],
    },
  },
  {
    name: 'waves-greenwich',
    description: 'GFS-Wave across 0° from two tiles (0-360 wrap), land bitmap, swell level 241, one all-missing message skipped',
    transport: () => buildFixtureRun([emptyWeather, wavesSpec()]),
    request: {
      bbox: { minLat: 40, maxLat: 41, minLon: -1, maxLon: 1 },
      datasetIds: ['waves-gfs'],
      startIso: '2026-09-23T01:00Z',
      endIso: '2026-09-23T07:00Z',
      step: 'all',
      lonConvention: '0-360',
    },
  },
  {
    name: 'currents-glo12',
    description: 'Synthetic GLO12 currents at 1/12° (µ° step 83333), negative components, land bitmap, D=2',
    transport: () => buildFixtureRun([emptyWeather, currentsSpec()]),
    request: {
      bbox: { minLat: 40, maxLat: 40.5, minLon: -10, maxLon: -9.5 },
      datasetIds: ['currents-global'],
      startIso: '2026-09-23T00:00Z',
      endIso: '2026-09-23T12:00Z',
      step: 'all',
      lonConvention: '0-360',
    },
  },
  {
    name: 'wind-south',
    description: 'Southern-hemisphere GFS wind with the signed longitude convention: negative latitudes and longitudes',
    transport: () => buildFixtureRun([southSpec()]),
    request: {
      bbox: { minLat: -35.5, maxLat: -34.5, minLon: -6, maxLon: -5 },
      datasetIds: ['wind-gfs'],
      startIso: '2026-09-23T00:00Z',
      endIso: '2026-09-23T02:00Z',
      step: 'all',
      lonConvention: 'signed',
    },
  },
];

export async function exportFixture(
  definition: GribFixtureDefinition,
): Promise<{ file: GribExportFile; dataset: GribDatasetPlan; store: TileForecastStore }> {
  const store = new TileForecastStore({ transport: definition.transport() });
  await store.init();
  const plan = planGribExport((layer) => store.manifestFor(layer), definition.request);
  const [file] = await runGribExport(gribExportSourceFromStore(store), plan);
  if (!file) throw new Error(`fixture ${definition.name} produced no file`);
  return { file, dataset: plan.datasets[0]!, store };
}

export async function buildGribFixtures(): Promise<GribFixture[]> {
  const out: GribFixture[] = [];
  for (const definition of GRIB_FIXTURES) {
    const { file, dataset, store } = await exportFixture(definition);
    const bytes = concat(file.parts);
    out.push({
      name: definition.name,
      bytes,
      expected: {
        fixture: definition.name,
        description: definition.description,
        file: `${definition.name}.grb2`,
        fnv64: file.fnv64,
        bytes: bytes.byteLength,
        skipped_messages: file.skippedMessages,
        messages: await expectedMessages(dataset, store, definition.request.lonConvention),
      },
    });
  }
  return out;
}

export function readCommittedFixture(name: string): { bytes: Uint8Array; expected: GribFixtureExpected } {
  return {
    bytes: new Uint8Array(readFileSync(join(GRIB_FIXTURE_DIR, `${name}.grb2`))),
    expected: JSON.parse(readFileSync(join(GRIB_FIXTURE_DIR, `${name}.expected.json`), 'utf8')) as GribFixtureExpected,
  };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

async function expectedMessages(
  dataset: GribDatasetPlan,
  store: TileForecastStore,
  lonConvention: GribExportRequest['lonConvention'],
): Promise<GribExpectedMessage[]> {
  const lattice = dataset.lattice!;
  const { n } = lattice;
  const manifest = store.manifestFor(dataset.layer)!;
  const tiles = new Map<string, DecodedTile>();
  for (const planned of dataset.tiles) {
    const tile = planned.present ? await store.readTile(dataset.layer, planned.id) : null;
    if (tile) tiles.set(planned.id, tile);
  }
  const sourceAt = (tileVar: string, time: string, kLat: number, kLon: number): number => {
    const row = Math.floor(kLat / n);
    const col = Math.floor(kLon / n);
    const tile = tiles.get(tileIdFromOrigin({ lat0: row * 10, lon0: col * 10 }));
    if (!tile) return NaN;
    const { header } = tile;
    const i = kLat - n * row;
    const j = kLon - n * col;
    const t = axisTimesMs(header, dataset.axis!).indexOf(Date.parse(time));
    if (i >= header.nlat || j >= header.nlon || t < 0) return NaN;
    return tile.arrays[tileVar]![(t * header.nlat + i) * header.nlon + j]!;
  };
  const corners = latticeCornersMicro(lattice, lonConvention);
  const cycle = new Date(Date.parse(dataset.cycle!));
  const messages: GribExpectedMessage[] = [];
  for (const step of dataset.steps) {
    for (const variable of dataset.variables) {
      const quantum = manifest.variables.find((v) => v.name === variable.tileVar)!.scale;
      const toOutput = (v: number) => (variable.convert === 'kt-to-ms' ? v / MS_TO_KT : v);
      const field: number[] = [];
      for (let kLat = lattice.kN; kLat >= lattice.kS; kLat--) {
        for (let kLon = lattice.kW; kLon <= lattice.kE; kLon++) {
          field.push(toOutput(sourceAt(variable.tileVar, step.time, kLat, kLon)));
        }
      }
      const missing = field.filter(Number.isNaN).length;
      if (missing === field.length) continue; // skipped, not written
      const ints = field.filter((v) => !Number.isNaN(v)).map((v) => Math.round(v * 10 ** variable.decimalScale));
      const range = Math.max(...ints) - Math.min(...ints);
      const pick = new Set([0, lattice.ni - 1, field.length - lattice.ni, field.length - 1,
        Math.floor(lattice.nj / 2) * lattice.ni + Math.floor(lattice.ni / 2)]);
      pick.add(missing ? field.findIndex(Number.isNaN) : lattice.ni + 1);
      const tolerance = round6(0.5 * 10 ** -variable.decimalScale + toOutput(quantum) / 2);
      messages.push({
        variable: variable.tileVar,
        time: step.time,
        keys: {
          discipline: variable.discipline,
          centre: dataset.spec.centre,
          subCentre: 0,
          tablesVersion: 2,
          significanceOfReferenceTime: 1,
          dataDate: cycle.getUTCFullYear() * 10000 + (cycle.getUTCMonth() + 1) * 100 + cycle.getUTCDate(),
          dataTime: cycle.getUTCHours() * 100 + cycle.getUTCMinutes(),
          productionStatusOfProcessedData: 0,
          typeOfProcessedData: 1,
          parameterCategory: variable.category,
          parameterNumber: variable.number,
          typeOfGeneratingProcess: 2,
          generatingProcessIdentifier: dataset.spec.generatingProcess,
          indicatorOfUnitOfTimeRange: 1,
          forecastTime: step.forecastHours,
          typeOfFirstFixedSurface: variable.level.type,
          scaleFactorOfFirstFixedSurface: 0,
          scaledValueOfFirstFixedSurface: variable.level.value,
          shapeOfTheEarth: 6,
          Ni: lattice.ni,
          Nj: lattice.nj,
          latitudeOfFirstGridPointInDegrees: corners.la1 / 1e6,
          longitudeOfFirstGridPointInDegrees: corners.lo1 / 1e6,
          latitudeOfLastGridPointInDegrees: corners.la2 / 1e6,
          longitudeOfLastGridPointInDegrees: corners.lo2 / 1e6,
          iDirectionIncrementInDegrees: lattice.stepMicro / 1e6,
          jDirectionIncrementInDegrees: lattice.stepMicro / 1e6,
          resolutionAndComponentFlags: 48,
          scanningMode: 0,
          bitmapPresent: missing ? 1 : 0,
          numberOfDataPoints: field.length,
          numberOfMissing: missing,
          // Constant fields are written with nbits = 0, D = 0 and R = the value.
          decimalScaleFactor: range === 0 ? 0 : variable.decimalScale,
          bitsPerValue: range === 0 ? 0 : Math.ceil(Math.log2(range + 1)),
          packingType: 'grid_simple',
        },
        points: [...pick].sort((a, b) => a - b).map((index) => {
          const kLat = lattice.kN - Math.floor(index / lattice.ni);
          const kLon = lattice.kW + (index % lattice.ni);
          const source = field[index]!;
          return {
            lat: (kLat * 10) / n,
            lon: (kLon * 10) / n,
            source: Number.isNaN(source) ? null : round6(source),
            written: Number.isNaN(source) ? null : gribRound(source, variable.decimalScale),
            tolerance,
          };
        }),
      });
    }
  }
  return messages;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
