/**
 * GRIB export runner (docs/grib-export.md): executes a plan one dataset (file)
 * and one tile at a time, so at most one decoded tile is alive; crops each
 * tile onto the export lattice, then encodes one GRIB2 message per step and
 * variable. Runs on the main thread in the browser, yielding between tiles
 * and while encoding, with abort and progress hooks.
 */

import { fnv1a64HexParts } from '../hash.js';
import { axisTimesMs } from '../forecast/tileMath.js';
import type { DecodedTile } from '../forecast/tileCodec.js';
import { windFromDeg } from '../vectors.js';
import { encodeGrib2Message, gribRound, type LonConvention } from './grib2.js';
import { MS_TO_KT, type GribDatasetKind, type GribVariableSpec } from './gribDatasets.js';
import { latticeBounds, type GribDatasetPlan, type GribExportPlan } from './exportPlan.js';

export interface GribExportSource {
  /** decoded tile, or null when the run does not publish it */
  tile(layer: string, tileId: string): Promise<DecodedTile | null>;
}

export interface GribExportProgress {
  datasetId: string;
  stage: 'tiles' | 'encode';
  /** work units done / total across the whole export (tiles + messages) */
  done: number;
  total: number;
}

export interface GribExportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: GribExportProgress) => void;
}

export interface GribCheckpointStep {
  time: string;
  /** derived from the rounded values actually written; null = missing */
  values: Record<string, number | null>;
}

export interface GribCheckpoint {
  lat: number;
  lon: number;
  /** the lattice point whose values are reported */
  grid_lat: number;
  grid_lon: number;
  steps: GribCheckpointStep[];
}

export interface GribExportFile {
  datasetId: string;
  layer: string;
  name: string;
  /** message bytes, concatenated they are the file */
  parts: Uint8Array[];
  bytes: number;
  fnv64: string;
  messages: number;
  /** all-missing messages that were not written */
  skippedMessages: number;
  run_id: string;
  cycle: string;
  model: string;
  times: string[];
  grid: {
    ni: number;
    nj: number;
    south: number;
    north: number;
    west: number;
    east: number;
    step_deg: number;
    lon_convention: LonConvention;
  };
  /** fraction of present values over every grid point of every message */
  coverage: number;
  checkpoints: GribCheckpoint[];
}

export type GribExportErrorCode = 'forecast-updated';

export class GribExportError extends Error {
  constructor(
    readonly code: GribExportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GribExportError';
  }
}

export const FORECAST_UPDATED_MESSAGE = 'The forecast has been updated. Reload the page and try again.';

const CHECKPOINT_STEPS = 3;
// Encoding yields once this much main-thread time has passed.
const ENCODE_SLICE_MS = 12;

/** Adapter for the viewer/CLI store: reads through its checksum and cache path without retaining. */
export function gribExportSourceFromStore(store: {
  readTile(layer: string, tileId: string, options?: { retain?: boolean }): Promise<DecodedTile | null>;
}): GribExportSource {
  return { tile: (layer, tileId) => store.readTile(layer, tileId, { retain: false }) };
}

export async function runGribExport(
  source: GribExportSource,
  plan: GribExportPlan,
  options: GribExportOptions = {},
): Promise<GribExportFile[]> {
  const { signal, onProgress } = options;
  const datasets = plan.datasets.filter((dataset) => dataset.availability === 'ok');
  const total = datasets.reduce(
    (sum, d) => sum + d.tiles.filter((tile) => tile.present).length + d.messages,
    0,
  );
  let done = 0;
  const files: GribExportFile[] = [];
  for (const dataset of datasets) {
    signal?.throwIfAborted();
    const tick = (stage: GribExportProgress['stage']) => {
      done += 1;
      onProgress?.({ datasetId: dataset.datasetId, stage, done, total });
    };
    const cubes = await readCubes(source, dataset, signal, () => tick('tiles'));
    files.push(await encodeFile(dataset, cubes, plan, signal, () => tick('encode')));
  }
  return files;
}

/** One Float32 cube per variable, [step][row north→south][col west→east], in tile units. */
async function readCubes(
  source: GribExportSource,
  dataset: GribDatasetPlan,
  signal: AbortSignal | undefined,
  tick: () => void,
): Promise<Float32Array[]> {
  const lattice = dataset.lattice!;
  const plane = lattice.ni * lattice.nj;
  const cubes = dataset.variables.map(() => new Float32Array(dataset.steps.length * plane).fill(NaN));
  for (const planned of dataset.tiles) {
    if (!planned.present) continue;
    signal?.throwIfAborted();
    // The decoded tile goes out of scope here, before the yield and the next read.
    await readTileInto(source, dataset, planned.id, cubes);
    tick();
    await yieldToEventLoop();
  }
  return cubes;
}

async function readTileInto(
  source: GribExportSource,
  dataset: GribDatasetPlan,
  tileId: string,
  cubes: Float32Array[],
): Promise<void> {
  let tile: DecodedTile | null;
  try {
    tile = await source.tile(dataset.layer, tileId);
  } catch (error) {
    // The run was rotated away while the page stayed open.
    if ((error as { status?: unknown } | null)?.status === 404) {
      throw new GribExportError('forecast-updated', FORECAST_UPDATED_MESSAGE, { cause: error });
    }
    throw error;
  }
  if (!tile) return;
  if (tile.header.run_id !== dataset.run_id) {
    throw new GribExportError('forecast-updated', FORECAST_UPDATED_MESSAGE);
  }
  copyTile(tile, dataset, cubes);
}

/**
 * Forward-map every native point of the tile onto its nearest lattice point
 * (using the tile header's own origin and step) and copy the selected steps.
 * On the 0.25° layers this is exact; on the CMEMS grids it absorbs the
 * provider's small origin offsets and float32 step drift.
 */
function copyTile(tile: DecodedTile, dataset: GribDatasetPlan, cubes: Float32Array[]): void {
  const { header } = tile;
  const lattice = dataset.lattice!;
  const scale = lattice.n / 10;
  const rows: number[] = []; // pairs: tile row i, lattice row (north→south)
  for (let i = 0; i < header.nlat; i++) {
    const k = Math.round((header.lat0 + i * header.dlat) * scale);
    if (k >= lattice.kS && k <= lattice.kN) rows.push(i, lattice.kN - k);
  }
  const cols: number[] = []; // pairs: tile column j, lattice column
  for (let j = 0; j < header.nlon; j++) {
    const k = Math.round((header.lon0 + j * header.dlon) * scale);
    if (k >= lattice.kW && k <= lattice.kE) cols.push(j, k - lattice.kW);
  }
  if (!rows.length || !cols.length) return;

  const tileIndex = new Map(axisTimesMs(header, dataset.axis!).map((ms, index) => [ms, index]));
  const stepIndices = dataset.steps.map((step) => tileIndex.get(Date.parse(step.time)));
  const tilePlane = header.nlat * header.nlon;
  const plane = lattice.ni * lattice.nj;
  dataset.variables.forEach((variable, v) => {
    const src = tile.arrays[variable.tileVar];
    if (!src) return;
    const dst = cubes[v]!;
    stepIndices.forEach((t, s) => {
      if (t === undefined) return;
      for (let r = 0; r < rows.length; r += 2) {
        const srcRow = t * tilePlane + rows[r]! * header.nlon;
        const dstRow = s * plane + rows[r + 1]! * lattice.ni;
        for (let c = 0; c < cols.length; c += 2) dst[dstRow + cols[c + 1]!] = src[srcRow + cols[c]!]!;
      }
    });
  });
}

async function encodeFile(
  dataset: GribDatasetPlan,
  cubes: Float32Array[],
  plan: GribExportPlan,
  signal: AbortSignal | undefined,
  tick: () => void,
): Promise<GribExportFile> {
  const lattice = dataset.lattice!;
  const plane = lattice.ni * lattice.nj;
  const { spec } = dataset;
  const lonConvention = plan.request.lonConvention;
  const field = new Float64Array(plane);
  const parts: Uint8Array[] = [];
  let skipped = 0;
  let presentValues = 0;
  let sliceStart = Date.now();
  for (let s = 0; s < dataset.steps.length; s++) {
    const step = dataset.steps[s]!;
    for (let v = 0; v < dataset.variables.length; v++) {
      signal?.throwIfAborted();
      const variable = dataset.variables[v]!;
      const cube = cubes[v]!;
      for (let k = 0; k < plane; k++) {
        const value = toOutputUnits(variable, cube[s * plane + k]!);
        field[k] = value;
        if (!Number.isNaN(value)) presentValues += 1;
      }
      const message = encodeGrib2Message({
        discipline: variable.discipline,
        centre: spec.centre,
        generatingProcess: spec.generatingProcess,
        cycle: dataset.cycle!,
        forecastHours: step.forecastHours,
        category: variable.category,
        number: variable.number,
        level: variable.level,
        decimalScale: variable.decimalScale,
        lattice,
        lonConvention,
        values: field,
      });
      if (message) parts.push(message);
      else skipped += 1;
      tick();
    }
    if (Date.now() - sliceStart >= ENCODE_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = Date.now();
    }
  }

  const bounds = latticeBounds(lattice);
  return {
    datasetId: dataset.datasetId,
    layer: dataset.layer,
    name: dataset.fileName!,
    parts,
    bytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
    fnv64: fnv1a64HexParts(parts),
    messages: parts.length,
    skippedMessages: skipped,
    run_id: dataset.run_id!,
    cycle: dataset.cycle!,
    model: dataset.model!,
    times: dataset.steps.map((step) => step.time),
    grid: {
      ni: lattice.ni,
      nj: lattice.nj,
      south: bounds.south,
      north: bounds.north,
      west: bounds.west,
      east: bounds.east,
      step_deg: bounds.step,
      lon_convention: lonConvention,
    },
    coverage: dataset.messages ? presentValues / (dataset.messages * plane) : 0,
    checkpoints: (plan.request.checkpoints ?? []).map((point) => checkpoint(point, dataset, cubes)),
  };
}

/** Values at the lattice point nearest the requested point for the first steps, as written. */
function checkpoint(
  point: { lat: number; lon: number },
  dataset: GribDatasetPlan,
  cubes: Float32Array[],
): GribCheckpoint {
  const lattice = dataset.lattice!;
  const scale = lattice.n / 10;
  const clamp = (k: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, k));
  const kLat = clamp(Math.round(point.lat * scale), lattice.kS, lattice.kN);
  const kLon = clamp(Math.round(point.lon * scale), lattice.kW, lattice.kE);
  const plane = lattice.ni * lattice.nj;
  const offset = (lattice.kN - kLat) * lattice.ni + (kLon - lattice.kW);
  const steps = dataset.steps.slice(0, CHECKPOINT_STEPS).map((step, s) => {
    const written: Record<string, number | null> = {};
    dataset.variables.forEach((variable, v) => {
      const value = toOutputUnits(variable, cubes[v]![s * plane + offset]!);
      written[variable.tileVar] = Number.isNaN(value) ? null : gribRound(value, variable.decimalScale);
    });
    return { time: step.time, values: describeValues(dataset.spec.kind, written) };
  });
  return { lat: point.lat, lon: point.lon, grid_lat: (kLat * 10) / lattice.n, grid_lon: (kLon * 10) / lattice.n, steps };
}

/** Sailor-facing spot values: wind in kt and FROM degrees, currents in kt and set (TOWARDS). */
function describeValues(kind: GribDatasetKind, written: Record<string, number | null>): Record<string, number | null> {
  const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
  const vector = (u: number | null | undefined, v: number | null | undefined) =>
    u === null || u === undefined || v === null || v === undefined ? null : { u, v };
  if (kind === 'wind') {
    const wind = vector(written.wind_u_kt, written.wind_v_kt);
    const out: Record<string, number | null> = {
      wind_kt: wind ? round(Math.hypot(wind.u, wind.v) * MS_TO_KT, 1) : null,
      wind_from_deg: wind ? Math.round(windFromDeg(wind.u, wind.v)) % 360 : null,
    };
    if ('gust_kt' in written) out.gust_kt = written.gust_kt === null ? null : round(written.gust_kt! * MS_TO_KT, 1);
    return out;
  }
  if (kind === 'currents') {
    const current = vector(written.cur_u_kt, written.cur_v_kt);
    return {
      current_kt: current ? round(Math.hypot(current.u, current.v) * MS_TO_KT, 2) : null,
      current_set_deg: current ? Math.round((Math.atan2(current.u, current.v) * 180) / Math.PI + 360) % 360 : null,
    };
  }
  return written;
}

function toOutputUnits(variable: GribVariableSpec, value: number): number {
  return variable.convert === 'kt-to-ms' ? value / MS_TO_KT : value;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
