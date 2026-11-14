/**
 * TileForecastStore: assembles point forecasts and region grids from
 * precomputed PFT1 tile runs. A point read interpolates between the grid
 * points around the exact query point on each layer's own grid (bilinear;
 * wind as u/v components; directions as unit vectors), crossing into the
 * neighbouring tile for a grid point beyond a 10° line, with one rule for
 * missing grid points (interpolateAtPoint), then resamples to whole hours for
 * the findings assembler (engine semantics `passage-audit-4`; until then the
 * audit read the nearest grid point of a point rounded to 0.25°). Region
 * grids keep the tiles' native lattice and time axis — GridSampler
 * interpolates in time.
 */

import { REGIONAL_LAYERS, REGIONAL_TRANSFER_BYTES, REGIONAL_WORKING_BYTES, regionalResources, regionalAdmission, regionalTileBudget, RegionalUnavailableError } from './regional.js';
import { windFromDeg } from '../vectors.js';
import { coarsenedGridNote } from '../fetch/liveGrids.js';
import type { RegionGrid } from '../grids.js';
import { toIso } from '../eta.js';
import { fnv1a64Hex } from '../hash.js';
import { gunzip } from './httpTransport.js';
import { decodeTile, type DecodedTile } from './tileCodec.js';
import { ECMWF_LAYERS, ecmwfRunChoice, type ServedRange } from './modelRuns.js';
import {
  axisTimesMs,
  edgeNeighbourProbes,
  nearestGridIndex,
  normalizeLon,
  resampleToHourly,
  tileIdFor,
  type Bbox,
  type GridIndex,
} from './tileMath.js';
import {
  CURRENTS_LAYER, ENSEMBLE_LAYER, MOSAIC_TARGET_POINTS, WAVES_LAYER, WEATHER_LAYER, mosaicLattice, mosaicPoints, tileCacheKey, tilePath,
} from './storeGeometry.js';
import type {
  ForecastStore,
  LatestDoc,
  LatestLayer,
  LayerInfo,
  RunManifest,
  TileCache,
  TileTransport,
} from './store.js';
import { ForecastRunGoneError, MemoryTileCache } from './store.js';
import type {
  EnsemblePointForecast,
  HazardPointForecast,
  PointForecast,
  TileRequestMeta,
  WavePointForecast,
} from './types.js';

interface LayerState {
  manifest: RunManifest;
  /** The layer's latest.json entry when this run was pinned or last confirmed. */
  entry: LatestLayer;
  /** Retained tiles, governed by the store-wide decoded LRU budget. */
  decoded: Map<string, DecodedTile>;
  /** One shared load per tile; `retain` is set once any caller wants the result kept. */
  inFlight: Map<string, { promise: Promise<{ tile: DecodedTile; cached: boolean }>; retain: boolean }>;
  /** Replaced by refresh(): loads still in flight for it must not be retained. */
  retired?: boolean;
}

/** The native grid point nearest a query point: its tile and index there. */
interface GridHit {
  tile: DecodedTile;
  idx: GridIndex;
}

interface SampledSeries {
  timesMs: number[];
  values: Array<number | null>;
}

/** The read window of a point forecast, ms (resampled to whole hours, start floored, end ceiled). */
interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** The grid points a point read interpolates between, nearest first; `hit` null when no published tile holds one. */
interface Neighbourhood {
  corners: Array<{ hit: GridHit | null; weight: number }>;
}

/**
 * The published precision of variables read together: the finest `scale` any
 * of them has in the tiles around the point (an ensemble member is mean plus
 * anomaly). Null when no tile there carries them.
 */
function precisionOf(nb: Neighbourhood, names: readonly string[]): number | null {
  let step: number | null = null;
  for (const { hit } of nb.corners) {
    for (const v of hit?.tile.header.variables ?? []) {
      if (names.includes(v.name) && v.scale > 0 && (step === null || v.scale < step)) step = v.scale;
    }
  }
  return step;
}

/**
 * Values rounded to `step`, arithmetically (no strings), in the direction a
 * limit check would find more hazardous (engine semantics `passage-audit-4`):
 * 'up' for quantities compared with a maximum (wind speed, gust, ensemble
 * members, wave heights, CAPE), 'down' for one compared with a minimum
 * (visibility) and for the wave period the steepness is computed from (a
 * shorter period is a steeper sea), 'nearest' for the rest (directions, other
 * periods, temperatures, precipitation). Property: for every comparison of a
 * single value with a limit (`>` a limit and `>=` the approaching threshold for
 * maxima, `<` for visibility) the rounded value is never less hazardous than
 * the value read, and differs from it by less than one step. Two tests combine
 * values and are outside the property: the relative model spread in
 * `hourDivergence` and the wind-under-10-kt fog screen can move either way
 * within one step of their threshold. A value already on the
 * lattice within float noise (a thousandth of a step: 1e-5 kt at 0.01, which
 * covers float32 tile values and e.g. 17.800000000000001) stays on it. The archived inputs are these rounded values, exactly
 * what was evaluated.
 */
export function roundToward(values: Array<number | null>, step: number | null, mode: 'up' | 'down' | 'nearest'): Array<number | null> {
  if (step === null) return values;
  const f = 10 ** Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  // float noise: tile values are float32, off their lattice by up to ~1e-6 kt at 20 kt (1e-4 of 0.01)
  const EPS = 1e-3;
  const lattice = mode === 'up'
    ? (x: number) => Math.ceil(x / step - EPS)
    : mode === 'down' ? (x: number) => Math.floor(x / step + EPS) : (x: number) => Math.round(x / step);
  return values.map((v) => (v === null ? null : Math.round(lattice(v) * step * f) / f));
}

/** The step compared quantities are kept at: 0.01 (kt, m), finer than any limit is stated in. */
const COMPARED_STEP = 0.01;

/** Fractional grid positions within 1e-9 of a node are on it (no weight for a neighbour). */
function snapToNode(f: number): number {
  const r = Math.round(f);
  return Math.abs(f - r) < 1e-9 ? r : f;
}

/** The native steps resampleToHourly reads for a window: the last at or before its first hour to the first at or after its last. */
function windowSteps(axis: number[], window: TimeWindow): [number, number] {
  if (!axis.length) return [0, -1];
  const first = Math.floor(window.startMs / MS_PER_HOUR) * MS_PER_HOUR;
  const last = Math.ceil(window.endMs / MS_PER_HOUR) * MS_PER_HOUR;
  let k0 = 0;
  while (k0 + 1 < axis.length && axis[k0 + 1]! <= first) k0++;
  let k1 = axis.length - 1;
  while (k1 - 1 >= 0 && axis[k1 - 1]! >= last) k1--;
  return [k0, Math.max(k0, k1)];
}

/**
 * Bilinear interpolation between a point's surrounding grid points, with the
 * audit's missing-neighbour rule (engine semantics `passage-audit-4`):
 * `perCorner[c][v]` is grid point c's series of variable v (nearest grid point
 * first; null when the grid point is missing altogether) and `weights[c]` its
 * bilinear weight. At each time, when every grid point has every variable,
 * each variable is the weighted mean; when any of them misses one (a
 * land-masked wave cell, a grid point outside the published tiles), every
 * variable is the nearest grid point's that has them all; when none has, the
 * value is missing. Variables read together (wind u and v, a direction's sine
 * and cosine) therefore always come from the same grid points.
 */
export function interpolateAtPoint(
  perCorner: ReadonlyArray<ReadonlyArray<ReadonlyArray<number | null> | null>>,
  weights: readonly number[],
): Array<Array<number | null>> {
  const nVars = perCorner[0]?.length ?? 0;
  const n = perCorner.flat().find((s) => s)?.length ?? 0;
  const out: Array<Array<number | null>> = Array.from({ length: nVars }, () => new Array<number | null>(n).fill(null));
  for (let t = 0; t < n; t++) {
    let nearestValid = -1;
    let allValid = true;
    for (let c = 0; c < perCorner.length; c++) {
      let valid = true;
      for (let v = 0; v < nVars; v++) {
        const x = perCorner[c]![v]?.[t];
        if (x === null || x === undefined || !Number.isFinite(x)) { valid = false; break; }
      }
      if (valid) { if (nearestValid < 0) nearestValid = c; } else allValid = false;
    }
    if (nearestValid < 0) continue;
    for (let v = 0; v < nVars; v++) {
      if (allValid) {
        let sum = 0, wsum = 0;
        for (let c = 0; c < perCorner.length; c++) {
          sum += weights[c]! * perCorner[c]![v]![t]!;
          wsum += weights[c]!;
        }
        out[v]![t] = sum / wsum;
      } else {
        out[v]![t] = perCorner[nearestValid]![v]![t]!;
      }
    }
  }
  return out;
}

const MS_PER_HOUR = 3_600_000;

export interface TileForecastStoreOptions {
  transport: TileTransport;
  cache?: TileCache;
  now?: () => number;
  /** Retained Float32 array bytes across all layers; default 64 MiB, 0 disables retention.
   * Excludes headers, compressed TileCache bytes, active loads and consumer outputs.
   */
  maxDecodedBytes?: number;
  /** Explicit feature/model opt-in; empty means no regional network reads. */
  regionalLayers?: readonly string[];
}

export class TileForecastStore implements ForecastStore {
  private transport: TileTransport;
  private cache: TileCache;
  private now: () => number;
  private layers = new Map<string, LayerState>();
  private latest: LatestDoc | null = null;
  private initPromise: Promise<void> | null = null;
  private refreshPromise: Promise<string[]> | null = null;
  /** When latest.json was last read successfully (store clock), or null before. */
  private checkedAtMs: number | null = null;
  private readonly maxDecodedBytes: number;
  private readonly regionalLayers: readonly string[];
  private regionalLoad: Promise<unknown> = Promise.resolve();
  private decodedBytes = 0;
  // Map insertion order is LRU order; layer maps and this index share tile objects.
  private decodedLru = new Map<DecodedTile, { state: LayerState; tileId: string; bytes: number }>();

  constructor(options: TileForecastStoreOptions) {
    this.transport = options.transport;
    this.cache = options.cache ?? new MemoryTileCache();
    this.now = options.now ?? Date.now;
    this.regionalLayers = options.regionalLayers ?? [];
    if (this.regionalLayers.some(layer => !REGIONAL_LAYERS.includes(layer))) {
      throw new Error('Unknown regional model allowlist');
    }
    this.maxDecodedBytes = options.maxDecodedBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxDecodedBytes) || this.maxDecodedBytes < 0) {
      throw new Error('maxDecodedBytes must be a non-negative safe integer');
    }
  }

  init(): Promise<void> {
    this.initPromise ??= this.initOnce().catch((error) => {
      // Retry from a clean state after a transient latest/manifest failure.
      this.layers.clear();
      this.decodedLru.clear();
      this.decodedBytes = 0;
      this.latest = null;
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    const readAtMs = this.now();
    this.latest = await this.readCatalogues();
    const loaded = await Promise.all(
      Object.entries(this.latest.layers).map(async ([layer, entry]) => {
        // current run first; fall back to the retained previous run so a
        // half-published or missing manifest never takes the layer down
        const manifest = await this.readManifest([entry.run_id, entry.previous_run_id]);
        return manifest?.layer === layer ? { layer, entry, manifest } : null;
      }),
    );
    // Publish in latest.json order, independent of fetch completion order, and
    // only after all reads settle so a failed init cannot leave late layer writes.
    for (const result of loaded) {
      if (!result) continue;
      this.layers.set(result.layer, this.newState(result.manifest, result.entry));
    }
    if (!this.layers.has(WEATHER_LAYER)) {
      throw new Error('Forecast tiles unavailable: no readable weather run');
    }
    this.checkedAtMs = readAtMs;
    await this.cache.evictExcept(this.liveRunIds()).catch(() => {});
  }

  private async readCatalogues(): Promise<LatestDoc> {
    const root = await this.transport.fetchLatest();
    const layers = Object.fromEntries(Object.entries(root.layers).filter(([layer]) => !REGIONAL_LAYERS.includes(layer)));
    if (this.regionalLayers.length && this.transport.fetchRegionalLatest) {
      try {
        const regional = await this.transport.fetchRegionalLatest();
        for (const layer of this.regionalLayers) {
          if (regional.layers[layer] && !root.layers[layer]) layers[layer] = regional.layers[layer]!;
        }
      } catch { /* Optional catalogue failure leaves the root briefing usable. */ }
    }
    return { ...root, layers };
  }

  private newState(manifest: RunManifest, entry: LatestLayer): LayerState {
    return { manifest, entry, decoded: new Map(), inFlight: new Map() };
  }

  /** The first readable manifest among the run ids, or null. */
  private async readManifest(runIds: Array<string | null | undefined>): Promise<RunManifest | null> {
    for (const runId of runIds) {
      if (!runId) continue;
      try {
        return await this.transport.fetchManifest(runId);
      } catch {
        // try the next run
      }
    }
    return null;
  }

  private liveRunIds(): string[] {
    return [...this.layers.values()].map((state) => state.manifest.run_id);
  }

  /** When latest.json was last read (init or refresh), in the store's clock; null before. */
  lastCheckedMs(): number | null {
    return this.checkedAtMs;
  }

  /**
   * Re-read latest.json and swap in every layer whose run changed. New
   * manifests load first; the swap then happens at once, dropping each
   * changed layer's decoded tiles while unchanged layers keep theirs. A layer
   * whose new manifest cannot be read keeps its pinned run (it may still be
   * the retained previous one). Call it between user actions, never during
   * one, so that an action reads a single run per layer. Before init it is
   * init. Resolves to the layers whose run changed.
   */
  async refresh(): Promise<string[]> {
    if (!this.initPromise) {
      await this.init();
      return [];
    }
    await this.initPromise;
    this.refreshPromise ??= this.refreshOnce().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<string[]> {
    const readAtMs = this.now();
    const latest = await this.readCatalogues();
    const loaded = await Promise.all(
      Object.entries(latest.layers).map(async ([layer, entry]) => {
        const pinned = this.layers.get(layer);
        if (pinned?.manifest.run_id === entry.run_id) return { layer, entry, manifest: null };
        const manifest = await this.readManifest([
          entry.run_id,
          // the pinned run may itself be the retained previous one
          entry.previous_run_id === pinned?.manifest.run_id ? null : entry.previous_run_id,
        ]);
        return { layer, entry, manifest };
      }),
    );
    const changed: string[] = [];
    for (const [layer, state] of this.layers) {
      if (REGIONAL_LAYERS.includes(layer) && !latest.layers[layer]) {
        this.retire(state);
        this.layers.delete(layer);
        changed.push(layer);
      }
    }
    for (const { layer, entry, manifest } of loaded) {
      const pinned = this.layers.get(layer);
      if (!manifest || manifest.layer !== layer) {
        if (pinned) pinned.entry = entry;
        continue;
      }
      if (pinned) this.retire(pinned);
      this.layers.set(layer, this.newState(manifest, entry));
      changed.push(layer);
    }
    this.latest = latest;
    this.checkedAtMs = readAtMs;
    if (changed.length) await this.cache.evictExcept(this.liveRunIds()).catch(() => {});
    return changed;
  }

  /** Drop a replaced layer's decoded tiles from the LRU budget. */
  private retire(state: LayerState): void {
    state.retired = true;
    for (const tile of state.decoded.values()) {
      const entry = this.decodedLru.get(tile);
      if (!entry) continue;
      this.decodedLru.delete(tile);
      this.decodedBytes -= entry.bytes;
    }
    state.decoded.clear();
  }

  describe(): Record<string, LayerInfo> {
    const out: Record<string, LayerInfo> = {};
    for (const [layer, state] of this.layers) {
      const m = state.manifest;
      const cadence = state.entry.cadence_hours;
      out[layer] = {
        layer,
        model: m.model,
        run_id: m.run_id,
        cycle: m.cycle,
        resolution_deg: m.resolution_deg,
        member_count: m.member_count,
        published_at: m.published_at,
        ...(REGIONAL_LAYERS.includes(layer) ? { regional: true, attribution: m.attribution } : {}),
        ...(cadence !== undefined ? { cadence_hours: cadence } : {}),
      };
    }
    return out;
  }

  /** The pinned run manifest for a layer, or null when the layer is unavailable. */
  manifestFor(layer: string): RunManifest | null {
    return this.layers.get(layer)?.manifest ?? null;
  }

  /** The layers the catalogue (latest.json, plus the allowed regional models) names, loaded or not. */
  listedLayers(): string[] {
    return Object.keys(this.latest?.layers ?? {});
  }

  /** The regional models this store was allowed to read, in its order. */
  regionalLayerIds(): readonly string[] {
    return this.regionalLayers;
  }

  /**
   * Whether a tile of the pinned run is already on this device, so reading it
   * would fetch nothing: retained decoded in memory, or held by the cache.
   * Probes without side effects and never fetches; a cache without `has`, or a
   * failing one, reports false.
   */
  async hasTile(layer: string, tileId: string): Promise<boolean> {
    const state = this.layers.get(layer);
    if (!state) return false;
    if (state.decoded.has(tileId)) return true;
    try {
      return (await this.cache.has?.(tileCacheKey(state.manifest, tileId))) === true;
    } catch {
      return false;
    }
  }

  /**
   * One decoded tile of the pinned run, through the same checksum, cache and
   * shared in-flight path as the analysis. Null when the manifest does not
   * publish it. With `retain: false` (the default) the read neither enters
   * nor reorders the decoded LRU, so bulk readers such as the GRIB export
   * never evict the analysis's tiles.
   */
  async readTile(layer: string, tileId: string, options: { retain?: boolean } = {}): Promise<DecodedTile | null> {
    await this.init();
    const state = this.layers.get(layer);
    if (!state || !state.manifest.tiles[tileId]) return null;
    const retain = options.retain ?? false;
    const memo = state.decoded.get(tileId);
    if (memo !== undefined) {
      if (retain) this.touch(memo);
      return memo;
    }
    return (await this.sharedLoad(state, tileId, retain)).tile;
  }

  // ---------------------------------------------------------------- tiles

  private touch(tile: DecodedTile): void {
    const entry = this.decodedLru.get(tile)!;
    this.decodedLru.delete(tile);
    this.decodedLru.set(tile, entry);
  }

  private sharedLoad(state: LayerState, tileId: string, retain: boolean): Promise<{ tile: DecodedTile; cached: boolean }> {
    const pending = state.inFlight.get(tileId);
    if (pending) {
      pending.retain ||= retain;
      return pending.promise;
    }
    const entry: { promise: Promise<{ tile: DecodedTile; cached: boolean }>; retain: boolean } = {
      retain,
      promise: this.queuedLoad(state.manifest, tileId).then(result => {
        if (entry.retain && !state.retired) this.retainTile(state, tileId, result.tile);
        return result;
      }).finally(() => state.inFlight.delete(tileId)),
    };
    state.inFlight.set(tileId, entry);
    return entry.promise;
  }

  private queuedLoad(manifest: RunManifest, tileId: string) {
    if (!REGIONAL_LAYERS.includes(manifest.layer)) return this.loadTile(manifest, tileId);
    const task = this.regionalLoad.then(() => {
      const transient = regionalTileBudget(manifest.tiles[tileId]!);
      const retained = () => [...this.decodedLru.values()].filter(e => REGIONAL_LAYERS.includes(e.state.manifest.layer)).reduce((sum, e) => sum + e.bytes, 0);
      for (const [tile, entry] of this.decodedLru) {
        if (retained() + transient <= REGIONAL_WORKING_BYTES) break;
        if (!REGIONAL_LAYERS.includes(entry.state.manifest.layer)) continue;
        entry.state.decoded.delete(entry.tileId);
        this.decodedLru.delete(tile);
        this.decodedBytes -= entry.bytes;
      }
      return this.loadTile(manifest, tileId);
    });
    this.regionalLoad = task.catch(() => {});
    return task;
  }

  private retainTile(state: LayerState, tileId: string, tile: DecodedTile): void {
    const bytes = Object.values(tile.arrays).reduce((sum, array) => sum + array.byteLength, 0);
    // Oversized tiles still serve current callers. Do not flush useful smaller
    // entries to make room for something that cannot fit; retain no empty tiles.
    if (bytes === 0 || bytes > this.maxDecodedBytes) return;
    while (this.decodedBytes + bytes > this.maxDecodedBytes) {
      const [oldest, entry] = this.decodedLru.entries().next().value!;
      entry.state.decoded.delete(entry.tileId);
      this.decodedLru.delete(oldest);
      this.decodedBytes -= entry.bytes;
    }
    state.decoded.set(tileId, tile);
    this.decodedLru.set(tile, { state, tileId, bytes });
    this.decodedBytes += bytes;
  }

  private async tileFor(
    state: LayerState,
    tileId: string,
    stats: { tiles: Set<string>; cached: number },
  ): Promise<DecodedTile | null> {
    const memo = state.decoded.get(tileId);
    if (memo !== undefined) {
      this.touch(memo);
      stats.tiles.add(tileId);
      stats.cached += 1;
      return memo;
    }

    stats.tiles.add(tileId);
    if (!state.manifest.tiles[tileId]) {
      return null;
    }
    const result = await this.sharedLoad(state, tileId, true);
    // Each caller owns its metadata; sharing a download is not a cache hit.
    if (result.cached) stats.cached += 1;
    return result.tile;
  }

  /**
   * The native grid point nearest (lat, lon): in the tile containing the
   * point, or in the neighbour across a 10° line when that point is the
   * neighbour's edge row/column (edgeNeighbourProbes). Unpublished neighbours
   * are skipped without being recorded in the stats.
   */
  private async locate(
    state: LayerState | undefined,
    lat: number,
    lon: number,
    stats: { tiles: Set<string>; cached: number },
  ): Promise<GridHit | null> {
    if (!state) return null;
    const x = normalizeLon(lon);
    const tile = await this.tileFor(state, tileIdFor(lat, x, state.manifest.tiling.tile_deg), stats);
    if (tile) {
      const idx = nearestGridIndex(tile.header, lat, x);
      if (idx) return { tile, idx };
    }
    for (const probe of edgeNeighbourProbes(tile?.header ?? null, lat, x, state.manifest.resolution_deg, state.manifest.tiling.tile_deg)) {
      if (!state.manifest.tiles[probe.tileId]) continue;
      const neighbour = await this.tileFor(state, probe.tileId, stats);
      const idx = neighbour && nearestGridIndex(neighbour.header, probe.lat, probe.lon);
      if (neighbour && idx) return { tile: neighbour, idx };
    }
    return null;
  }

  private async loadTile(manifest: RunManifest, tileId: string): Promise<{ tile: DecodedTile; cached: boolean }> {
    const path = tilePath(manifest, tileId);
    const key = tileCacheKey(manifest, tileId);
    const expected = manifest.tiles[tileId]!;
    const validate = async (bytes: Uint8Array): Promise<DecodedTile> => {
      if (bytes.byteLength !== expected.bytes || fnv1a64Hex(bytes) !== expected.fnv64) {
        throw new Error(`forecast tile invalid: ${key} (checksum mismatch)`);
      }
      try {
        const regional = REGIONAL_LAYERS.includes(manifest.layer);
        const tile = decodeTile(await gunzip(bytes, regional ? expected.uncompressed_bytes : undefined), regional ? expected.decoded_bytes : undefined);
        if (tile.header.run_id !== manifest.run_id || tile.header.layer !== manifest.layer || tile.header.tile_id !== tileId) {
          throw new Error('tile belongs to a different run, layer or coordinate');
        }
        return tile;
      } catch (cause) {
        throw new Error(`forecast tile invalid: ${key} (decode failed)`, { cause });
      }
    };
    const cached = await this.cache.get(key).catch(() => null);
    let reload = false;
    if (cached) {
      try {
        return { tile: await validate(cached), cached: true };
      } catch {
        // This also migrates old uncompressed cache entries on first use.
        await this.cache.delete(key).catch(() => {});
        reload = true;
      }
    }
    for (;;) {
      let bytes: Uint8Array;
      try {
        bytes = await this.transport.fetchTile(manifest.run_id, path, { cache: reload ? 'reload' : 'force-cache' });
      } catch (error) {
        // The run was deleted after newer ones were published: refresh, then retry.
        if ((error as { status?: unknown } | null)?.status === 404) {
          throw new ForecastRunGoneError(manifest.layer, manifest.run_id, { cause: error });
        }
        throw error;
      }
      let tile: DecodedTile;
      try {
        tile = await validate(bytes);
      } catch (error) {
        // A corrupt browser HTTP cache gets one bypass, as does a bad TileCache.
        if (reload) throw error;
        reload = true;
        continue;
      }
      // IndexedDB retains compressed regional tiles on disk; an in-memory
      // fallback must not accumulate them outside the regional working set.
      if (!REGIONAL_LAYERS.includes(manifest.layer) || !(this.cache instanceof MemoryTileCache)) {
        await this.cache.put(key, bytes, manifest.run_id).catch(() => {});
      }
      return { tile, cached: false };
    }
  }

  private newStats() {
    return { tiles: new Set<string>(), cached: 0 };
  }

  private meta(
    state: LayerState,
    stats: { tiles: Set<string>; cached: number },
    points: number,
  ): TileRequestMeta {
    const m = state.manifest;
    return {
      source: 'tiles',
      ...(m.attribution ? { attribution: m.attribution } : {}),
      layer: m.layer,
      model: m.model,
      run_id: m.run_id,
      cycle: m.cycle,
      resolution_deg: m.resolution_deg,
      ...(m.member_count > 1 ? { member_count: m.member_count } : {}),
      tiles: [...stats.tiles].sort(),
      fetched_at: new Date(this.now()).toISOString(),
      cached_tiles: stats.cached,
      points,
    };
  }

  /**
   * Raw series at a located grid point, on the variable's native axis. With a
   * window, only the steps from the last one at or before the window's first
   * whole hour to the first one at or after its last (what resampleToHourly
   * reads); without one, the whole axis.
   */
  private seriesAt({ tile, idx }: GridHit, name: string, window?: TimeWindow): SampledSeries | null {
    const variable = tile.header.variables.find((v) => v.name === name);
    if (!variable) return null;
    const axis = axisTimesMs(tile.header, variable.axis);
    const [k0, k1] = window ? windowSteps(axis, window) : [0, axis.length - 1];
    const timesMs = axis.slice(k0, k1 + 1);
    const arr = tile.arrays[name]!;
    const stride = tile.header.nlat * tile.header.nlon;
    const values: Array<number | null> = new Array(timesMs.length);
    for (let t = 0; t < timesMs.length; t++) {
      const v = arr[(k0 + t) * stride + idx.flat]!;
      values[t] = Number.isNaN(v) ? null : v;
    }
    return { timesMs, values };
  }

  /** per-member series (mean + per-member anomaly encoding) at a located grid point */
  private memberSeriesAt(
    hit: GridHit,
    meanName: string,
    anomName: string,
    window?: TimeWindow,
  ): { timesMs: number[]; members: Array<Array<number | null>> } | null {
    const { tile, idx } = hit;
    const meanVar = tile.header.variables.find((v) => v.name === meanName);
    const mean = this.seriesAt(hit, meanName, window);
    const anomVar = tile.header.variables.find((v) => v.name === anomName);
    if (!meanVar || !mean || !anomVar) return null;
    const axis = axisTimesMs(tile.header, meanVar.axis);
    const [k0] = window ? windowSteps(axis, window) : [0];
    const arr = tile.arrays[anomName]!;
    const stride = tile.header.nlat * tile.header.nlon;
    const nTime = mean.timesMs.length;
    const memberStride = axis.length * stride;
    const members: Array<Array<number | null>> = [];
    for (let m = 0; m < tile.header.member_count; m++) {
      const series: Array<number | null> = new Array(nTime);
      for (let t = 0; t < nTime; t++) {
        const anom = arr[m * memberStride + (k0 + t) * stride + idx.flat]!;
        const base = mean.values[t] ?? null;
        series[t] = base === null || Number.isNaN(anom) ? null : base + anom;
      }
      members.push(series);
    }
    return { timesMs: mean.timesMs, members };
  }

  /**
   * The grid points of the layer's own grid around (lat, lon) that a point
   * read interpolates between, nearest first, with their bilinear weights
   * (only those with a weight above zero: a point on a grid line or node
   * needs two or one). The lattice comes from the tile holding the point or,
   * when that tile is unpublished, from a published neighbour within one cell
   * (edgeNeighbourProbes). A grid point in the neighbouring tile across a 10°
   * line is found the way `locate` finds an edge row or column. A grid point
   * that no published tile holds is kept with `hit: null` (missing), unless it
   * is the nearest one: then, and when no published tile gives a lattice, the
   * result is null and the read is missing, as before.
   */
  private async neighbourhood(
    state: LayerState,
    lat: number,
    lon: number,
    stats: { tiles: Set<string>; cached: number },
  ): Promise<Neighbourhood | null> {
    const manifest = state.manifest;
    const deg = manifest.tiling.tile_deg;
    const x = normalizeLon(lon);
    let ref: { tile: DecodedTile; lat: number; lon: number } | null = null;
    const home = await this.tileFor(state, tileIdFor(lat, x, deg), stats);
    if (home) ref = { tile: home, lat, lon: x };
    else {
      for (const probe of edgeNeighbourProbes(null, lat, x, manifest.resolution_deg, deg)) {
        if (!manifest.tiles[probe.tileId]) continue;
        const tile = await this.tileFor(state, probe.tileId, stats);
        if (tile) {
          ref = { tile, lat: probe.lat, lon: probe.lon };
          break;
        }
      }
    }
    if (!ref) return null;
    const h = ref.tile.header;
    const fi = snapToNode((ref.lat - h.lat0) / h.dlat);
    const fj = snapToNode((ref.lon - h.lon0) / h.dlon);
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const wi = fi - i0;
    const wj = fj - j0;
    const candidates = ([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([a, b], order) => ({
      a, b, order,
      weight: (a ? wi : 1 - wi) * (b ? wj : 1 - wj),
      distance: Math.hypot(a ? 1 - wi : wi, b ? 1 - wj : wj),
    })).filter((c) => c.weight > 0).sort((p, q) => p.distance - q.distance || p.order - q.order);
    const corners: Neighbourhood['corners'] = [];
    for (const c of candidates) {
      const i = i0 + c.a;
      const j = j0 + c.b;
      const hit: GridHit | null = i >= 0 && i < h.nlat && j >= 0 && j < h.nlon
        ? { tile: ref.tile, idx: { i, j, flat: i * h.nlon + j } }
        : await this.locateNode(state, h.lat0 + i * h.dlat, h.lon0 + j * h.dlon, stats);
      // The nearest grid point outside every published tile: the read is missing, as when the
      // audit read the nearest grid point. Only values missing inside published tiles
      // (land-masked cells) are replaced by the nearest valid neighbour (interpolateAtPoint).
      if (!hit && !corners.length) return null;
      corners.push({ hit, weight: c.weight });
    }
    return { corners };
  }

  /**
   * The grid point at (lat, lon), a node of the layer's lattice outside the
   * tile it was computed from: in the tile holding it, or across a 10° line
   * (`locate`'s edge probes). Unpublished tiles are skipped without being
   * recorded. Null when no published tile holds it.
   */
  private async locateNode(
    state: LayerState,
    lat: number,
    lon: number,
    stats: { tiles: Set<string>; cached: number },
  ): Promise<GridHit | null> {
    const manifest = state.manifest;
    const x = normalizeLon(lon);
    const id = tileIdFor(lat, x, manifest.tiling.tile_deg);
    const tile = manifest.tiles[id] ? await this.tileFor(state, id, stats) : null;
    if (tile) {
      const idx = nearestGridIndex(tile.header, lat, x);
      if (idx) return { tile, idx };
    }
    for (const probe of edgeNeighbourProbes(tile?.header ?? null, lat, x, manifest.resolution_deg, manifest.tiling.tile_deg)) {
      if (!manifest.tiles[probe.tileId]) continue;
      const neighbour = await this.tileFor(state, probe.tileId, stats);
      const idx = neighbour && nearestGridIndex(neighbour.header, probe.lat, probe.lon);
      if (neighbour && idx) return { tile: neighbour, idx };
    }
    return null;
  }

  /**
   * Variables read together at one query point: each grid point's series of
   * every name (null where that grid point is missing or lacks the variable),
   * combined by `interpolateAtPoint`. All tiles of a run share its time axes.
   */
  private interpolatedSeries(
    nb: Neighbourhood, names: readonly string[], window: TimeWindow,
    transforms?: ReadonlyArray<(v: number) => number>,
  ) {
    const perCorner = nb.corners.map(({ hit }) => names.map((name) => (hit ? this.seriesAt(hit, name, window) : null)));
    const reference = perCorner.flat().find((s): s is SampledSeries => s !== null);
    if (!reference) return null;
    const n = reference.timesMs.length;
    const aligned = perCorner.map((series) => series.map((s, k) => {
      if (!s || s.timesMs.length !== n) return null;
      const transform = transforms?.[k];
      return transform ? s.values.map((v) => (v === null ? null : transform(v))) : s.values;
    }));
    return { timesMs: reference.timesMs, values: interpolateAtPoint(aligned, nb.corners.map((c) => c.weight)) };
  }

  /** Every ensemble member's series at one query point, each combined by `interpolateAtPoint`. */
  private interpolatedMembers(nb: Neighbourhood, meanName: string, anomName: string, window: TimeWindow) {
    const perCorner = nb.corners.map(({ hit }) => (hit ? this.memberSeriesAt(hit, meanName, anomName, window) : null));
    const reference = perCorner.find((s) => s !== null);
    if (!reference) return null;
    const n = reference.timesMs.length;
    const weights = nb.corners.map((c) => c.weight);
    const members = reference.members.map((_, m) => interpolateAtPoint(
      perCorner.map((s) => [s && s.timesMs.length === n ? s.members[m] ?? null : null]), weights,
    )[0]!);
    return { timesMs: reference.timesMs, members };
  }

  // ------------------------------------------------------- point forecasts

  async getPointForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: PointForecast[]; meta: TileRequestMeta }> {
    await this.init();
    // one run for the whole call, even if refresh() swaps the layer meanwhile
    const state = this.layers.get(WEATHER_LAYER)!;
    const stats = this.newStats();
    const window = { startMs, endMs };
    const forecasts: PointForecast[] = [];
    for (const p of points) {
      const nb = await this.neighbourhood(state, p.lat, p.lon, stats);
      const uv = nb && this.interpolatedSeries(nb, ['wind_u_kt', 'wind_v_kt'], window);
      const gust = nb && this.interpolatedSeries(nb, ['gust_kt'], window);
      if (!nb || !uv || !gust) {
        forecasts.push({ lat: p.lat, lon: p.lon, times: [], wind_kt: [], gust_kt: [], wind_dir_deg: [] });
        continue;
      }
      // wind is interpolated as u/v components, then turned into speed and direction
      const uH = resampleToHourly(uv.timesMs, uv.values[0]!, startMs, endMs);
      const vH = resampleToHourly(uv.timesMs, uv.values[1]!, startMs, endMs);
      const gustH = resampleToHourly(gust.timesMs, gust.values[0]!, startMs, endMs);
      const { speed, direction } = windFromUv(uH.values, vH.values);
      forecasts.push({
        lat: p.lat,
        lon: p.lon,
        times: uH.times,
        wind_kt: speed,
        gust_kt: roundToward(gustH.values, COMPARED_STEP, 'up'),
        wind_dir_deg: direction,
      });
    }
    return { forecasts, meta: this.meta(state, stats, points.length) };
  }

  async getEnsembleForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: EnsemblePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    const state = this.layers.get(ENSEMBLE_LAYER);
    if (!state) return null;
    const stats = this.newStats();
    const window = { startMs, endMs };
    const forecasts: EnsemblePointForecast[] = [];
    for (const p of points) {
      // the ensemble's own (0.5°) grid around the exact point, never a point already rounded to another grid
      const nb = await this.neighbourhood(state, p.lat, p.lon, stats);
      const wind = nb && this.interpolatedMembers(nb, 'wind_kt_mean', 'wind_kt_anom', window);
      if (!nb || !wind) {
        forecasts.push({ lat: p.lat, lon: p.lon, times: [], wind_kt_members: [], gust_kt_members: [] });
        continue;
      }
      const gust = this.interpolatedMembers(nb, 'gust_kt_mean', 'gust_kt_anom', window);
      const resampled = wind.members.map(
        (series) => roundToward(resampleToHourly(wind.timesMs, series, startMs, endMs).values, COMPARED_STEP, 'up'),
      );
      const times = resampleToHourly(wind.timesMs, wind.members[0] ?? [], startMs, endMs).times;
      forecasts.push({
        lat: p.lat,
        lon: p.lon,
        times,
        wind_kt_members: resampled,
        gust_kt_members: gust
          ? gust.members.map((series) => roundToward(resampleToHourly(gust.timesMs, series, startMs, endMs).values, COMPARED_STEP, 'up'))
          : [],
      });
    }
    return { forecasts, meta: this.meta(state, stats, points.length) };
  }

  async getWaveForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: WavePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    const state = this.layers.get(WAVES_LAYER);
    if (!state) return null;
    const stats = this.newStats();
    const scalarVars = [
      ['hs_m', 'hs_m'],
      ['period_s', 'period_s'],
      ['wind_wave_h_m', 'wind_wave_h_m'],
      ['wind_wave_period_s', 'wind_wave_period_s'],
      ['swell_h_m', 'swell_h_m'],
      ['swell_period_s', 'swell_period_s'],
    ] as const;
    const dirVars = [
      ['dir_deg', 'dir_deg'],
      ['wind_wave_dir_deg', 'wind_wave_dir_deg'],
      ['swell_dir_deg', 'swell_dir_deg'],
    ] as const;
    const window = { startMs, endMs };
    const forecasts: WavePointForecast[] = [];
    for (const p of points) {
      const nb = await this.neighbourhood(state, p.lat, p.lon, stats);
      const out: WavePointForecast = {
        lat: p.lat,
        lon: p.lon,
        times: [],
        hs_m: [],
        period_s: [],
        dir_deg: [],
        wind_wave_h_m: [],
        wind_wave_period_s: [],
        wind_wave_dir_deg: [],
        swell_h_m: [],
        swell_period_s: [],
        swell_dir_deg: [],
      };
      if (nb) {
        // land-masked wave cells are missing neighbours: the nearest valid one stands in (interpolateAtPoint)
        for (const [field, varName] of scalarVars) {
          const series = this.interpolatedSeries(nb, [varName], window);
          if (!series) continue;
          const h = resampleToHourly(series.timesMs, series.values[0]!, startMs, endMs);
          out[field] = WAVE_HEIGHTS.has(varName) ? roundToward(h.values, COMPARED_STEP, 'up')
            : roundToward(h.values, precisionOf(nb, [varName]), varName === 'period_s' ? 'down' : 'nearest');
          if (!out.times.length) out.times = h.times;
        }
        for (const [field, varName] of dirVars) {
          // directions are interpolated as unit vectors (sine and cosine together)
          const unit = this.interpolatedSeries(nb, [varName, varName], window, [sinDeg, cosDeg]);
          if (!unit) continue;
          const degrees = unit.values[0]!.map((sin, t) => {
            const cos = unit.values[1]![t] ?? null;
            return sin === null || cos === null ? null : ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
          });
          out[field] = resampleDirectionToHourly(unit.timesMs, degrees, startMs, endMs);
        }
      }
      forecasts.push(out);
    }
    return { forecasts, meta: this.meta(state, stats, points.length) };
  }

  /**
   * Hourly hazard series per deterministic model: GFS, and ECMWF combined
   * across its 240 h layer and its 06Z/18Z one (modelRuns.ts). For each hour
   * the ECMWF series takes the newest cycle covering it, and each run that
   * served an hour is recorded with the ranges it served (`served`).
   */
  async getHazardForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] } | null> {
    await this.init();
    const byModel: Record<string, HazardPointForecast[]> = {};
    const meta: TileRequestMeta[] = [];
    for (const layers of [[WEATHER_LAYER], ECMWF_LAYERS]) {
      // one run per layer for the whole call, even if refresh() swaps one meanwhile
      const states = layers.flatMap((layer) => this.layers.get(layer) ?? []);
      if (!states.length) continue;
      if (states.length === 1) {
        const read = await this.hazardRead(states[0]!, points, startMs, endMs);
        byModel[states[0]!.manifest.model] = read.forecasts;
        meta.push(read.meta);
        continue;
      }
      const { hours, choice } = ecmwfRunChoice(states.map((state) => state.manifest), startMs, endMs);
      const reads = await Promise.all(states.map((state, i) =>
        choice.includes(i) ? this.hazardRead(state, points, startMs, endMs) : null));
      byModel[states[0]!.manifest.model] = points.map((p, j) =>
        combineHazardSeries(p, hours, choice, reads.map((read) => read?.forecasts[j] ?? null)));
      reads.forEach((read, i) => {
        if (read) meta.push({ ...read.meta, served: servedRanges(hours, choice, i) });
      });
    }
    let regionalBytes = 0, regionalDecodedBytes = 0;
    // Optional comparisons must coexist with the current root workload and
    // each other's decode buffers. Otherwise the LRU would churn every warm read.
    const rootDecodedBytes = [...this.decodedLru.values()]
      .filter(entry => !REGIONAL_LAYERS.includes(entry.state.manifest.layer))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    for (const layer of this.regionalLayers) {
      const state = this.layers.get(layer);
      if (!state) continue;
      try {
        const resources = regionalResources(state.manifest, points, startMs, endMs);
        if (regionalBytes + resources.transferBytes > REGIONAL_TRANSFER_BYTES ||
            rootDecodedBytes + regionalDecodedBytes + resources.decodedBytes > this.maxDecodedBytes ||
            regionalDecodedBytes + resources.peakBytes > REGIONAL_WORKING_BYTES) continue;
        regionalBytes += resources.transferBytes;
        regionalDecodedBytes += resources.decodedBytes;
        const read = await this.hazardRead(state, points, startMs, endMs);
        if (read.forecasts.some(fc => !fc.wind_kt.length || fc.wind_kt.some(v => v === null))) continue;
        byModel[state.manifest.model] = read.forecasts;
        meta.push(read.meta);
      } catch (error) {
        if (error instanceof ForecastRunGoneError) throw error;
        // No regional contribution on missing coverage, budget or source failure.
      }
    }
    return Object.keys(byModel).length ? { byModel, meta } : null;
  }

  private async hazardRead(
    state: LayerState,
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: HazardPointForecast[]; meta: TileRequestMeta }> {
    const stats = this.newStats();
    const window = { startMs, endMs };
    const forecasts: HazardPointForecast[] = [];
    for (const p of points) {
      // each model on its own grid around the exact point, so every model describes the same place
      const nb = await this.neighbourhood(state, p.lat, p.lon, stats);
      const out = emptyHazard(p);
      if (nb) {
        const uv = this.interpolatedSeries(nb, ['wind_u_kt', 'wind_v_kt'], window);
        if (uv) {
          const uH = resampleToHourly(uv.timesMs, uv.values[0]!, startMs, endMs);
          const vH = resampleToHourly(uv.timesMs, uv.values[1]!, startMs, endMs);
          const { speed, direction } = windFromUv(uH.values, vH.values);
          out.times = uH.times;
          out.wind_kt = speed;
          out.wind_dir_deg = direction;
        }
        for (const field of HAZARD_SCALARS) {
          const series = this.interpolatedSeries(nb, [field], window);
          if (!series) continue;
          const h = resampleToHourly(series.timesMs, series.values[0]!, startMs, endMs);
          out[field] = field === 'gust_kt' ? roundToward(h.values, COMPARED_STEP, 'up')
            : roundToward(h.values, precisionOf(nb, [field]), field === 'visibility_m' ? 'down' : field === 'cape_jkg' ? 'up' : 'nearest');
          if (!out.times.length) out.times = h.times;
        }
      }
      forecasts.push(out);
    }
    return { forecasts, meta: this.meta(state, stats, points.length) };
  }

  // ------------------------------------------------------------ grids

  async getWindGrid(bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid> {
    await this.init();
    const grid = await this.mosaicGrid(WEATHER_LAYER, ['wind_u_kt', 'wind_v_kt'], 'wind10m', bbox, startIso, hours);
    if (!grid) throw new Error('Forecast tiles unavailable for this area');
    return grid;
  }

  async getRegionalWindGrid(layer: string, bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid> {
    await this.init();
    const state = this.layers.get(layer);
    if (!this.regionalLayers.includes(layer) || !state) throw new RegionalUnavailableError('Regional model unavailable');
    const g = state.manifest.served_grid;
    if (!g) throw new RegionalUnavailableError('Regional grid unavailable');
    const points: Array<{lat: number; lon: number}> = [];
    const nlat = Math.floor((bbox.maxLat - bbox.minLat) / g.dlat) + 2;
    const nlon = Math.floor((bbox.maxLon - bbox.minLon) / g.dlon) + 2;
    if (nlat * nlon > 4000) throw new RegionalUnavailableError('Choose a smaller region at native resolution');
    for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) {
      points.push({lat: g.lat0 + Math.round((bbox.minLat - g.lat0) / g.dlat) * g.dlat + i * g.dlat,
        lon: g.lon0 + Math.round((bbox.minLon - g.lon0) / g.dlon) * g.dlon + j * g.dlon});
    }
    const start = Date.parse(startIso);
    regionalAdmission(state.manifest, points, start, start + hours * MS_PER_HOUR);
    const grid = await this.mosaicGrid(layer, ['wind_u_kt','wind_v_kt'], 'wind10m', bbox, startIso, hours);
    if (!grid || grid.u_kt.some(v => v === null) || grid.v_kt.some(v => v === null)) {
      throw new RegionalUnavailableError('Regional model does not cover this region and period');
    }
    return grid;
  }

  async getCurrentGrid(bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid | null> {
    await this.init();
    if (!this.layers.has(CURRENTS_LAYER)) return null;
    try {
      return await this.mosaicGrid(CURRENTS_LAYER, ['cur_u_kt', 'cur_v_kt'], 'surface_current', bbox, startIso, hours);
    } catch (error) {
      // A deleted run is not a currents outage: the caller refreshes and retries.
      if (error instanceof ForecastRunGoneError) throw error;
      return null;
    }
  }

  /**
   * Mosaic the tiles intersecting the bbox into one RegionGrid on the layer's
   * native grid and time axis (subset to [start, start+hours]), striding the
   * spatial resolution down when the area exceeds the routing point budget.
   */
  private async mosaicGrid(
    layer: string,
    [uName, vName]: [string, string],
    kind: RegionGrid['kind'],
    bbox: Bbox,
    startIso: string,
    hours: number,
    targetPoints = MOSAIC_TARGET_POINTS,
  ): Promise<RegionGrid | null> {
    const state = this.layers.get(layer);
    if (!state) return null;
    const manifest = state.manifest;

    // native-resolution lattice covering the bbox, snapped to the tile grid
    const lattice = mosaicLattice(manifest, bbox, targetPoints);
    const { lat0, lon0, dlat, dlon, nlat, nlon, stride } = lattice;

    // time axis: the layer's primary (u-variable) axis clipped to the window
    const uVar = manifest.variables.find((v) => v.name === uName);
    if (!uVar) return null;
    const axis = manifest.time_axes[uVar.axis];
    if (!axis) return null;
    const baseMs = Date.parse(axis.base.endsWith('Z') ? axis.base : `${axis.base}Z`);
    const startMs = Math.floor(Date.parse(startIso) / MS_PER_HOUR) * MS_PER_HOUR;
    const endMs = startMs + hours * MS_PER_HOUR;
    const stepsMs = axis.offsets_h.map((h) => baseMs + h * MS_PER_HOUR);
    // include one step each side so GridSampler can interpolate at the edges
    let firstIdx = 0;
    for (let k = stepsMs.length - 1; k >= 0; k--) {
      if (stepsMs[k]! <= startMs) {
        firstIdx = k;
        break;
      }
    }
    let lastIdx = stepsMs.findIndex((t) => t >= endMs);
    if (lastIdx < 0) lastIdx = stepsMs.length - 1;
    const timeAxisMs = stepsMs.slice(firstIdx, lastIdx + 1);
    if (!timeAxisMs.length) return null;

    const stats = this.newStats();
    const nPoints = nlat * nlon;
    const u = new Array<number | null>(timeAxisMs.length * nPoints).fill(null);
    const v = new Array<number | null>(timeAxisMs.length * nPoints).fill(null);
    // Align each tile once for this window; all its grid points share the axis.
    // Do not keep evicted tiles alive for the duration of a large mosaic.
    const timeIndices = new WeakMap<DecodedTile, Array<number | undefined>>();
    let anyData = false;
    for (const { i, j, lat, lon } of mosaicPoints(lattice)) {
      const hit = await this.locate(state, lat, lon, stats);
      if (!hit) continue;
      const uS = this.seriesAt(hit, uName);
      const vS = this.seriesAt(hit, vName);
      if (!uS || !vS) continue;
      let indices = timeIndices.get(hit.tile);
      if (!indices) {
        const index = new Map(uS.timesMs.map((t, k) => [t, k]));
        indices = timeAxisMs.map((t) => index.get(t));
        timeIndices.set(hit.tile, indices);
      }
      for (let t = 0; t < timeAxisMs.length; t++) {
        const k = indices[t];
        if (k === undefined) continue;
        const uVal = uS.values[k] ?? null;
        const vVal = vS.values[k] ?? null;
        u[(t * nlat + i) * nlon + j] = uVal;
        v[(t * nlat + i) * nlon + j] = vVal;
        if (uVal !== null) anyData = true;
      }
    }
    if (!anyData) {
      if (kind === 'wind10m') throw new Error('Forecast tiles unavailable for this area');
      return null;
    }

    return {
      schema_version: 1,
      kind,
      run_id: manifest.run_id,
      generated_at: new Date(this.now()).toISOString(),
      lat0,
      lon0,
      dlat,
      dlon,
      nlat,
      nlon,
      time_axis: timeAxisMs.map((t) => toIso(t)),
      u_kt: u,
      v_kt: v,
      under_resolved_note:
        stride > 1
          ? coarsenedGridNote(round2(dlat))
          : undefined,
      source: {
        mode: 'live',
        dataset_id: `${manifest.model} tiles (${manifest.run_id})`,
        resolution_deg: dlat,
        fetched_at: new Date(this.now()).toISOString(),
      },
    };
  }
}

const HAZARD_SCALARS = ['gust_kt', 'visibility_m', 'cape_jkg', 'temp_c', 'dew_point_c', 'precip_mm'] as const;
const HAZARD_SERIES = ['wind_kt', 'wind_dir_deg', ...HAZARD_SCALARS] as const;

function emptyHazard(p: { lat: number; lon: number }): HazardPointForecast {
  return {
    lat: p.lat,
    lon: p.lon,
    times: [],
    wind_kt: [],
    gust_kt: [],
    wind_dir_deg: [],
    visibility_m: [],
    cape_jkg: [],
    temp_c: [],
    dew_point_c: [],
    precip_mm: [],
  };
}

/**
 * One point's hourly series taken, hour by hour, from the run `choice` names
 * (−1: no run covers the hour). A run read without a grid point here (or
 * not read) gives nulls; with no grid point in any run the series is empty,
 * as for a single run.
 */
function combineHazardSeries(
  p: { lat: number; lon: number },
  hours: number[],
  choice: number[],
  runs: Array<HazardPointForecast | null>,
): HazardPointForecast {
  const out = emptyHazard(p);
  if (!runs.some((run) => run?.times.length)) return out;
  out.times = hours.map((t) => toIso(t));
  for (const field of HAZARD_SERIES) {
    out[field] = hours.map((_, k) => runs[choice[k]!]?.[field][k] ?? null);
  }
  return out;
}

/** The hourly ranges in which `choice` names run `index`. */
function servedRanges(hours: number[], choice: number[], index: number): ServedRange[] {
  const ranges: ServedRange[] = [];
  let from: number | null = null;
  hours.forEach((t, k) => {
    if (choice[k] === index) from ??= t;
    if (from !== null && (choice[k + 1] !== index || k === hours.length - 1)) {
      ranges.push({ from: toIso(from), to: toIso(t) });
      from = null;
    }
  });
  return ranges;
}

/** meteorological wind: direction the wind comes FROM (0° = northerly) */
function windFromUv(
  u: Array<number | null>,
  v: Array<number | null>,
): { speed: Array<number | null>; direction: Array<number | null> } {
  const speed: Array<number | null> = new Array(u.length);
  const direction: Array<number | null> = new Array(u.length);
  for (let k = 0; k < u.length; k++) {
    const uk = u[k] ?? null;
    const vk = v[k] ?? null;
    if (uk === null || vk === null) {
      speed[k] = null;
      direction[k] = null;
      continue;
    }
    speed[k] = roundToward([Math.hypot(uk, vk)], COMPARED_STEP, 'up')[0]!;
    direction[k] = round1(windFromDeg(uk, vk));
  }
  return { speed, direction };
}

/** resample a direction series via unit vectors (plain linear would wrap wrong at 0/360) */
function resampleDirectionToHourly(
  timesMs: number[],
  values: Array<number | null>,
  startMs: number,
  endMs: number,
): Array<number | null> {
  const sin = values.map((d) => (d === null ? null : Math.sin((d * Math.PI) / 180)));
  const cos = values.map((d) => (d === null ? null : Math.cos((d * Math.PI) / 180)));
  const sinH = resampleToHourly(timesMs, sin, startMs, endMs).values;
  const cosH = resampleToHourly(timesMs, cos, startMs, endMs).values;
  return sinH.map((s, k) => {
    const c = cosH[k] ?? null;
    if (s === null || c === null) return null;
    return round1(((Math.atan2(s, c) * 180) / Math.PI + 360) % 360);
  });
}

const WAVE_HEIGHTS = new Set(['hs_m', 'wind_wave_h_m', 'swell_h_m']);
const sinDeg = (d: number) => Math.sin((d * Math.PI) / 180);
const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
