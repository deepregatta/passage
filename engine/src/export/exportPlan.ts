/**
 * GRIB export planning (docs/grib-export.md): from a padded bbox, a time
 * window and the pinned run manifests, decide per dataset the export lattice,
 * the forecast steps, the tiles to read and the expected sizes. Synchronous
 * and I/O-free, so the UI can show availability and estimates before any
 * tile is fetched.
 */

import { parseUtc, toIso } from '../eta.js';
import type { RunManifest } from '../forecast/store.js';
import { tileIdFromOrigin, type Bbox } from '../forecast/tileMath.js';
import type { GribLattice, LonConvention } from './grib2.js';
import { GRIB_DATASETS, type GribDatasetSpec, type GribVariableSpec } from './gribDatasets.js';

export type GribStep = 'all' | 3 | 6;

export interface GribCheckpointRequest {
  lat: number;
  lon: number;
}

export interface GribExportRequest {
  /** export area, margin already applied; must not cross the antimeridian */
  bbox: Bbox;
  datasetIds: readonly string[];
  startIso: string;
  endIso: string;
  step: GribStep;
  lonConvention: LonConvention;
  /** spot values to report (the route's first and last waypoints) */
  checkpoints?: readonly GribCheckpointRequest[];
  /** tiles are a dev or CLI fixture, not the live runs: files get a passage-fixture_ prefix */
  fixture?: boolean;
}

export type GribAvailability = 'ok' | 'no-layer' | 'no-tiles' | 'outside-horizon';

export interface GribPlannedStep {
  /** index on the tile time axis */
  index: number;
  time: string;
  /** whole hours after the cycle */
  forecastHours: number;
}

export interface GribPlannedTile {
  id: string;
  /** listed in the manifest; unpublished (all-land) tiles stay missing */
  present: boolean;
  bytes: number;
}

export interface GribDatasetPlan {
  datasetId: string;
  label: string;
  layer: string;
  availability: GribAvailability;
  spec: GribDatasetSpec;
  run_id: string | null;
  cycle: string | null;
  model: string | null;
  /** exported variables: the registry's, restricted to those the manifest lists */
  variables: GribVariableSpec[];
  axis: string | null;
  lattice: GribLattice | null;
  steps: GribPlannedStep[];
  tiles: GribPlannedTile[];
  messages: number;
  estBytes: number;
  /** compressed tile bytes to fetch with a cold cache (sum over present tiles) */
  downloadBytesUpperBound: number;
  fileName: string | null;
}

export interface GribExportPlan {
  request: GribExportRequest;
  datasets: GribDatasetPlan[];
}

export type GribManifests =
  | Readonly<Record<string, RunManifest | null | undefined>>
  | ((layer: string) => RunManifest | null | undefined);

const HOUR_MS = 3_600_000;
// Sections 0, 1, 3, 4, 5, the bitmap-less section 6, the section-7 header and 8.
const MESSAGE_OVERHEAD_BYTES = 16 + 21 + 72 + 34 + 21 + 6 + 5 + 4;
// Lattice indices snap to integers within this tolerance before floor/ceil.
const K_EPSILON = 1e-9;

export function planGribExport(manifests: GribManifests, request: GribExportRequest): GribExportPlan {
  validateRequest(request);
  const lookup = typeof manifests === 'function' ? manifests : (layer: string) => manifests[layer];
  const startMs = parseUtc(request.startIso);
  const endMs = parseUtc(request.endIso);
  const datasets = request.datasetIds.map((id) => {
    const spec = GRIB_DATASETS.find((dataset) => dataset.id === id);
    if (!spec) throw new Error(`Unknown GRIB dataset: ${id}`);
    return planDataset(spec, lookup(spec.layer) ?? null, request, startMs, endMs);
  });
  return { request, datasets };
}

/**
 * The lattice at the manifest's resolution covering the bbox: whole lattice
 * steps, widened outward so the requested area is always inside the grid.
 */
export function gribLattice(bbox: Bbox, resolutionDeg: number): GribLattice {
  if (!(resolutionDeg > 0) || !Number.isFinite(resolutionDeg)) {
    throw new Error(`Invalid grid resolution: ${resolutionDeg}`);
  }
  const n = Math.round(10 / resolutionDeg);
  if (n < 1 || n > 3600) throw new Error(`Unsupported grid resolution: ${resolutionDeg}`);
  const scale = n / 10;
  const kS = Math.max(-9 * n, Math.floor(bbox.minLat * scale + K_EPSILON));
  const kN = Math.min(9 * n, Math.ceil(bbox.maxLat * scale - K_EPSILON));
  const kW = Math.max(-18 * n, Math.floor(bbox.minLon * scale + K_EPSILON));
  const kE = Math.min(18 * n, Math.ceil(bbox.maxLon * scale - K_EPSILON));
  return { n, stepMicro: Math.round(1e7 / n), kS, kN, kW, kE, ni: kE - kW + 1, nj: kN - kS + 1 };
}

/** Lattice edges in degrees (exact k·10/n, not the rounded micro-degree header values). */
export function latticeBounds(lattice: GribLattice): { south: number; north: number; west: number; east: number; step: number } {
  const deg = (k: number) => (k * 10) / lattice.n;
  return {
    south: deg(lattice.kS),
    north: deg(lattice.kN),
    west: deg(lattice.kW),
    east: deg(lattice.kE),
    step: 10 / lattice.n,
  };
}

/**
 * Whether the tile grids sit exactly on the lattice. The 0.25° layers do;
 * the CMEMS layers carry the provider's own float32-derived origin and step
 * (e.g. GLO12 0.08333588°), so a lattice point on a 10° line can take its
 * nearest native point from the neighbouring tile.
 */
export function tilesAlignedToLattice(resolutionDeg: number, n: number): boolean {
  return Math.abs(resolutionDeg * n - 10) < 1e-6;
}

function planDataset(
  spec: GribDatasetSpec,
  manifest: RunManifest | null,
  request: GribExportRequest,
  startMs: number,
  endMs: number,
): GribDatasetPlan {
  const empty: GribDatasetPlan = {
    datasetId: spec.id,
    label: spec.label,
    layer: spec.layer,
    availability: 'no-layer',
    spec,
    run_id: manifest?.run_id ?? null,
    cycle: manifest?.cycle ?? null,
    model: manifest?.model ?? null,
    variables: [],
    axis: null,
    lattice: null,
    steps: [],
    tiles: [],
    messages: 0,
    estBytes: 0,
    downloadBytesUpperBound: 0,
    fileName: null,
  };
  if (!manifest) return empty;

  // All exported variables share one axis: the first listed variable's.
  const listed = new Map(manifest.variables.filter((v) => !v.per_member).map((v) => [v.name, v]));
  const axis = spec.variables.map((v) => listed.get(v.tileVar)?.axis).find((a) => a !== undefined);
  const variables = spec.variables.filter((v) => axis !== undefined && listed.get(v.tileVar)?.axis === axis);
  const timeAxis = axis === undefined ? undefined : manifest.time_axes[axis];
  if (axis === undefined || !timeAxis || !variables.length) return empty;

  const lattice = gribLattice(request.bbox, manifest.resolution_deg);
  const tiles = planTiles(manifest, lattice);
  const downloadBytesUpperBound = tiles.reduce((sum, tile) => sum + tile.bytes, 0);
  const steps = selectSteps(manifest.cycle, timeAxis, request.step, startMs, endMs);
  const availability: GribAvailability = !tiles.some((tile) => tile.present)
    ? 'no-tiles'
    : steps === null
      ? 'outside-horizon'
      : 'ok';
  const planned = { ...empty, availability, variables, axis, lattice, tiles };
  if (availability !== 'ok') return planned;
  const selected = steps!;
  const points = lattice.ni * lattice.nj;
  const bitmapBytes = spec.hasLand ? Math.ceil(points / 8) : 0;
  const bytesPerStep = variables.reduce(
    (sum, v) => sum + MESSAGE_OVERHEAD_BYTES + bitmapBytes + Math.ceil((points * v.estBits) / 8),
    0,
  );
  return {
    ...planned,
    steps: selected,
    messages: selected.length * variables.length,
    estBytes: selected.length * bytesPerStep,
    downloadBytesUpperBound,
    fileName: gribFileName(spec.id, manifest.cycle, lattice, request.fixture === true),
  };
}

/**
 * Tiles whose native points can land on the lattice, in manifest order, then
 * unpublished ones. Integer tile arithmetic on lattice indices avoids float
 * edge cases; unaligned (CMEMS) grids also take the neighbour across a 10°
 * line that the lattice edge sits exactly on.
 */
function planTiles(manifest: RunManifest, lattice: GribLattice): GribPlannedTile[] {
  const { n } = lattice;
  const pad = tilesAlignedToLattice(manifest.resolution_deg, n) ? 0 : 0.5;
  const rowLo = Math.max(-9, Math.floor((lattice.kS - pad) / n));
  const rowHi = Math.min(8, Math.floor((lattice.kN + pad) / n));
  const colLo = Math.max(-18, Math.floor((lattice.kW - pad) / n));
  const colHi = Math.min(17, Math.floor((lattice.kE + pad) / n));
  const wanted = new Set<string>();
  for (let row = rowLo; row <= rowHi; row++) {
    for (let col = colLo; col <= colHi; col++) {
      wanted.add(tileIdFromOrigin({ lat0: row * 10, lon0: col * 10 }));
    }
  }
  const present = Object.keys(manifest.tiles).filter((id) => wanted.has(id));
  const absent = [...wanted].filter((id) => !manifest.tiles[id]).sort();
  return [
    ...present.map((id) => ({ id, present: true, bytes: manifest.tiles[id]!.bytes })),
    ...absent.map((id) => ({ id, present: false, bytes: 0 })),
  ];
}

/**
 * Axis steps inside [start, end] after thinning, plus the step before start
 * and the step after end when those fall between steps, so apps can
 * interpolate across the whole window. Null when the window misses the axis.
 */
function selectSteps(
  cycle: string,
  axis: { base: string; offsets_h: number[] },
  step: GribStep,
  startMs: number,
  endMs: number,
): GribPlannedStep[] | null {
  const cycleMs = parseUtc(cycle);
  const baseMs = parseUtc(axis.base);
  const all = axis.offsets_h
    .map((offset, index) => ({ index, offset, ms: baseMs + offset * HOUR_MS }))
    .filter((s) => step === 'all' || s.offset % step === 0);
  if (!all.length || startMs > all[all.length - 1]!.ms || endMs < all[0]!.ms) return null;
  let first = all.findIndex((s) => s.ms >= startMs);
  if (all[first]!.ms > startMs && first > 0) first -= 1;
  let last = all.length - 1;
  while (all[last]!.ms > endMs) last -= 1;
  if (all[last]!.ms < endMs && last < all.length - 1) last += 1;
  return all.slice(first, last + 1).map((s) => {
    const forecastHours = (s.ms - cycleMs) / HOUR_MS;
    if (!Number.isInteger(forecastHours) || forecastHours < 0) {
      throw new Error(`Forecast step ${toIso(s.ms)} is not a whole hour after the cycle ${cycle}`);
    }
    return { index: s.index, time: toIso(s.ms), forecastHours };
  });
}

/** passage_<dataset>_<YYYYMMDDTHHZ>_<SW>_<NE>.grb2 with whole-degree corners. */
export function gribFileName(datasetId: string, cycle: string, lattice: GribLattice, fixture: boolean): string {
  const bounds = latticeBounds(lattice);
  const d = new Date(parseUtc(cycle));
  const pad = (v: number, width: number) => String(v).padStart(width, '0');
  const cycleCompact = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}Z`;
  const lat = (v: number) => `${v < 0 ? 'S' : 'N'}${pad(Math.abs(v), 2)}`;
  const lon = (v: number) => `${v < 0 ? 'W' : 'E'}${pad(Math.abs(v), 3)}`;
  const sw = `${lat(Math.floor(bounds.south))}${lon(Math.floor(bounds.west))}`;
  const ne = `${lat(Math.ceil(bounds.north))}${lon(Math.ceil(bounds.east))}`;
  return `${fixture ? 'passage-fixture' : 'passage'}_${datasetId}_${cycleCompact}_${sw}_${ne}.grb2`;
}

function validateRequest(request: GribExportRequest): void {
  const { minLat, maxLat, minLon, maxLon } = request.bbox;
  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) throw new Error('GRIB export bbox must be finite');
  if (minLat > maxLat) throw new Error('GRIB export bbox has minLat above maxLat');
  if (minLon > maxLon) throw new Error('antimeridian-crossing bounding boxes are not supported');
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) {
    throw new Error('GRIB export bbox is outside −90..90 / −180..180');
  }
  if (parseUtc(request.endIso) < parseUtc(request.startIso)) throw new Error('GRIB export window ends before it starts');
  if (request.step !== 'all' && request.step !== 3 && request.step !== 6) {
    throw new Error(`Unsupported GRIB step: ${String(request.step)}`);
  }
  if (request.lonConvention !== '0-360' && request.lonConvention !== 'signed') {
    throw new Error(`Unsupported longitude convention: ${String(request.lonConvention)}`);
  }
}
