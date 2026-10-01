/**
 * TileForecastStore: assembles point forecasts and region grids from
 * precomputed PFT1 tile runs. Point sampling is a nearest-grid-point lookup
 * (leg midpoints are snapped to the 0.25° audit cell, which matches the
 * weather layer's native grid) that crosses into the neighbouring tile when
 * the nearest point is its edge row/column, resampled to whole hours for the
 * findings assembler. Region grids keep the tiles' native time axis —
 * GridSampler interpolates in time.
 */

import { windFromDeg } from '../vectors.js';
import { coarsenedGridNote } from '../fetch/liveGrids.js';
import type { RegionGrid } from '../grids.js';
import { toIso } from '../eta.js';
import { fnv1a64Hex } from '../hash.js';
import { gunzip } from './httpTransport.js';
import { decodeTile, type DecodedTile } from './tileCodec.js';
import { ECMWF_LAYERS, newestRunAt, runSpan, type ServedRange } from './modelRuns.js';
import {
  axisTimesMs,
  edgeNeighbourProbes,
  hourlyTimesMs,
  nearestGridIndex,
  normalizeLon,
  resampleToHourly,
  tileIdFor,
  type Bbox,
  type GridIndex,
} from './tileMath.js';
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

const MS_PER_HOUR = 3_600_000;

export interface TileForecastStoreOptions {
  transport: TileTransport;
  cache?: TileCache;
  now?: () => number;
  /** Retained Float32 array bytes across all layers; default 64 MiB, 0 disables retention.
   * Excludes headers, compressed TileCache bytes, active loads and consumer outputs.
   */
  maxDecodedBytes?: number;
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
  private decodedBytes = 0;
  // Map insertion order is LRU order; layer maps and this index share tile objects.
  private decodedLru = new Map<DecodedTile, { state: LayerState; tileId: string; bytes: number }>();

  constructor(options: TileForecastStoreOptions) {
    this.transport = options.transport;
    this.cache = options.cache ?? new MemoryTileCache();
    this.now = options.now ?? Date.now;
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
    this.latest = await this.transport.fetchLatest();
    const loaded = await Promise.all(
      Object.entries(this.latest.layers).map(async ([layer, entry]) => {
        // current run first; fall back to the retained previous run so a
        // half-published or missing manifest never takes the layer down
        const manifest = await this.readManifest([entry.run_id, entry.previous_run_id]);
        return manifest ? { layer, entry, manifest } : null;
      }),
    );
    // Publish in latest.json order, independent of fetch completion order, and
    // only after all reads settle so a failed init cannot leave late layer writes.
    for (const result of loaded) {
      if (!result) continue;
      this.layers.set(result.layer, this.newState(result.manifest, result.entry));
    }
    if (!this.layers.has('weather')) {
      throw new Error('Forecast tiles unavailable: no readable weather run');
    }
    this.checkedAtMs = readAtMs;
    await this.cache.evictExcept(this.liveRunIds()).catch(() => {});
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
    const latest = await this.transport.fetchLatest();
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
    for (const { layer, entry, manifest } of loaded) {
      const pinned = this.layers.get(layer);
      if (!manifest) {
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
        ...(cadence !== undefined ? { cadence_hours: cadence } : {}),
      };
    }
    return out;
  }

  /** The pinned run manifest for a layer, or null when the layer is unavailable. */
  manifestFor(layer: string): RunManifest | null {
    return this.layers.get(layer)?.manifest ?? null;
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
      promise: this.loadTile(state.manifest, tileId).then(result => {
        if (entry.retain && !state.retired) this.retainTile(state, tileId, result.tile);
        return result;
      }).finally(() => state.inFlight.delete(tileId)),
    };
    state.inFlight.set(tileId, entry);
    return entry.promise;
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
    const tile = await this.tileFor(state, tileIdFor(lat, x), stats);
    if (tile) {
      const idx = nearestGridIndex(tile.header, lat, x);
      if (idx) return { tile, idx };
    }
    for (const probe of edgeNeighbourProbes(tile?.header ?? null, lat, x, state.manifest.resolution_deg)) {
      if (!state.manifest.tiles[probe.tileId]) continue;
      const neighbour = await this.tileFor(state, probe.tileId, stats);
      const idx = neighbour && nearestGridIndex(neighbour.header, probe.lat, probe.lon);
      if (neighbour && idx) return { tile: neighbour, idx };
    }
    return null;
  }

  private async loadTile(manifest: RunManifest, tileId: string): Promise<{ tile: DecodedTile; cached: boolean }> {
    const path = manifest.tiling.path_template.replace('{tile_id}', tileId);
    const key = `${manifest.run_id}/${path}`;
    const expected = manifest.tiles[tileId]!;
    const validate = async (bytes: Uint8Array): Promise<DecodedTile> => {
      if (bytes.byteLength !== expected.bytes || fnv1a64Hex(bytes) !== expected.fnv64) {
        throw new Error(`forecast tile invalid: ${key} (checksum mismatch)`);
      }
      try {
        return decodeTile(await gunzip(bytes));
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
      await this.cache.put(key, bytes, manifest.run_id).catch(() => {});
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

  /** raw series at a located grid point, on the variable's native axis */
  private seriesAt({ tile, idx }: GridHit, name: string): SampledSeries | null {
    const variable = tile.header.variables.find((v) => v.name === name);
    if (!variable) return null;
    const timesMs = axisTimesMs(tile.header, variable.axis);
    const arr = tile.arrays[name]!;
    const stride = tile.header.nlat * tile.header.nlon;
    const values: Array<number | null> = new Array(timesMs.length);
    for (let t = 0; t < timesMs.length; t++) {
      const v = arr[t * stride + idx.flat]!;
      values[t] = Number.isNaN(v) ? null : v;
    }
    return { timesMs, values };
  }

  /** per-member series (mean + per-member anomaly encoding) at a located grid point */
  private memberSeriesAt(
    hit: GridHit,
    meanName: string,
    anomName: string,
  ): { timesMs: number[]; members: Array<Array<number | null>> } | null {
    const { tile, idx } = hit;
    const mean = this.seriesAt(hit, meanName);
    const anomVar = tile.header.variables.find((v) => v.name === anomName);
    if (!mean || !anomVar) return null;
    const arr = tile.arrays[anomName]!;
    const stride = tile.header.nlat * tile.header.nlon;
    const nTime = mean.timesMs.length;
    const memberStride = nTime * stride;
    const members: Array<Array<number | null>> = [];
    for (let m = 0; m < tile.header.member_count; m++) {
      const series: Array<number | null> = new Array(nTime);
      for (let t = 0; t < nTime; t++) {
        const anom = arr[m * memberStride + t * stride + idx.flat]!;
        const base = mean.values[t] ?? null;
        series[t] = base === null || Number.isNaN(anom) ? null : base + anom;
      }
      members.push(series);
    }
    return { timesMs: mean.timesMs, members };
  }

  // ------------------------------------------------------- point forecasts

  async getPointForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: PointForecast[]; meta: TileRequestMeta }> {
    await this.init();
    // one run for the whole call, even if refresh() swaps the layer meanwhile
    const state = this.layers.get('weather')!;
    const stats = this.newStats();
    const forecasts: PointForecast[] = [];
    for (const p of points) {
      const hit = await this.locate(state, p.lat, p.lon, stats);
      const u = hit && this.seriesAt(hit, 'wind_u_kt');
      const v = hit && this.seriesAt(hit, 'wind_v_kt');
      const gust = hit && this.seriesAt(hit, 'gust_kt');
      if (!hit || !u || !v || !gust) {
        forecasts.push({ lat: p.lat, lon: p.lon, times: [], wind_kt: [], gust_kt: [], wind_dir_deg: [] });
        continue;
      }
      const uH = resampleToHourly(u.timesMs, u.values, startMs, endMs);
      const vH = resampleToHourly(v.timesMs, v.values, startMs, endMs);
      const gustH = resampleToHourly(gust.timesMs, gust.values, startMs, endMs);
      const { speed, direction } = windFromUv(uH.values, vH.values);
      forecasts.push({
        lat: p.lat,
        lon: p.lon,
        times: uH.times,
        wind_kt: speed,
        gust_kt: gustH.values,
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
    const state = this.layers.get('ensemble');
    if (!state) return null;
    const stats = this.newStats();
    const forecasts: EnsemblePointForecast[] = [];
    for (const p of points) {
      const hit = await this.locate(state, p.lat, p.lon, stats);
      const wind = hit && this.memberSeriesAt(hit, 'wind_kt_mean', 'wind_kt_anom');
      if (!hit || !wind) {
        forecasts.push({ lat: p.lat, lon: p.lon, times: [], wind_kt_members: [], gust_kt_members: [] });
        continue;
      }
      const gust = this.memberSeriesAt(hit, 'gust_kt_mean', 'gust_kt_anom');
      const resampled = wind.members.map(
        (series) => resampleToHourly(wind.timesMs, series, startMs, endMs).values,
      );
      const times = resampleToHourly(wind.timesMs, wind.members[0] ?? [], startMs, endMs).times;
      forecasts.push({
        lat: p.lat,
        lon: p.lon,
        times,
        wind_kt_members: resampled,
        gust_kt_members: gust
          ? gust.members.map((series) => resampleToHourly(gust.timesMs, series, startMs, endMs).values)
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
    const state = this.layers.get('waves');
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
    const forecasts: WavePointForecast[] = [];
    for (const p of points) {
      const hit = await this.locate(state, p.lat, p.lon, stats);
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
      if (hit) {
        for (const [field, varName] of scalarVars) {
          const series = this.seriesAt(hit, varName);
          if (!series) continue;
          const h = resampleToHourly(series.timesMs, series.values, startMs, endMs);
          out[field] = h.values;
          if (!out.times.length) out.times = h.times;
        }
        for (const [field, varName] of dirVars) {
          const series = this.seriesAt(hit, varName);
          if (!series) continue;
          out[field] = resampleDirectionToHourly(series.timesMs, series.values, startMs, endMs);
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
    for (const layers of [['weather'], ECMWF_LAYERS]) {
      // one run per layer for the whole call, even if refresh() swaps one meanwhile
      const states = layers.flatMap((layer) => this.layers.get(layer) ?? []);
      if (!states.length) continue;
      if (states.length === 1) {
        const read = await this.hazardRead(states[0]!, points, startMs, endMs);
        byModel[states[0]!.manifest.model] = read.forecasts;
        meta.push(read.meta);
        continue;
      }
      const spans = states.map((state) => runSpan(state.manifest, 'wind_u_kt'));
      const hours = hourlyTimesMs(startMs, endMs);
      const choice = hours.map((t) => newestRunAt(spans, t));
      const reads = await Promise.all(states.map((state, i) =>
        choice.includes(i) ? this.hazardRead(state, points, startMs, endMs) : null));
      byModel[states[0]!.manifest.model] = points.map((p, j) =>
        combineHazardSeries(p, hours, choice, reads.map((read) => read?.forecasts[j] ?? null)));
      reads.forEach((read, i) => {
        if (read) meta.push({ ...read.meta, served: servedRanges(hours, choice, i) });
      });
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
    const forecasts: HazardPointForecast[] = [];
    for (const p of points) {
      const hit = await this.locate(state, p.lat, p.lon, stats);
      const out = emptyHazard(p);
      if (hit) {
        const u = this.seriesAt(hit, 'wind_u_kt');
        const v = this.seriesAt(hit, 'wind_v_kt');
        if (u && v) {
          const uH = resampleToHourly(u.timesMs, u.values, startMs, endMs);
          const vH = resampleToHourly(v.timesMs, v.values, startMs, endMs);
          const { speed, direction } = windFromUv(uH.values, vH.values);
          out.times = uH.times;
          out.wind_kt = speed;
          out.wind_dir_deg = direction;
        }
        for (const field of HAZARD_SCALARS) {
          const series = this.seriesAt(hit, field);
          if (!series) continue;
          const h = resampleToHourly(series.timesMs, series.values, startMs, endMs);
          out[field] = h.values;
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
    const grid = await this.mosaicGrid('weather', ['wind_u_kt', 'wind_v_kt'], 'wind10m', bbox, startIso, hours);
    if (!grid) throw new Error('Forecast tiles unavailable for this area');
    return grid;
  }

  async getCurrentGrid(bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid | null> {
    await this.init();
    if (!this.layers.has('currents')) return null;
    try {
      return await this.mosaicGrid('currents', ['cur_u_kt', 'cur_v_kt'], 'surface_current', bbox, startIso, hours);
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
    targetPoints = 4000,
  ): Promise<RegionGrid | null> {
    const state = this.layers.get(layer);
    if (!state) return null;
    const manifest = state.manifest;
    const res = manifest.resolution_deg;

    // native-resolution lattice covering the bbox, snapped to the tile grid
    const snap = (x: number) => Math.round(x / res) * res;
    let stride = 1;
    const rawNlat = Math.floor((bbox.maxLat - bbox.minLat) / res) + 1;
    const rawNlon = Math.floor((bbox.maxLon - bbox.minLon) / res) + 1;
    while ((Math.ceil(rawNlat / stride) + 1) * (Math.ceil(rawNlon / stride) + 1) > targetPoints) {
      stride += 1;
    }
    const dlat = res * stride;
    const dlon = res * stride;
    const lat0 = snap(bbox.minLat);
    const lon0 = snap(bbox.minLon);
    const nlat = Math.max(2, Math.floor((bbox.maxLat - lat0) / dlat) + 1);
    const nlon = Math.max(2, Math.floor((bbox.maxLon - lon0) / dlon) + 1);

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
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const lat = lat0 + i * dlat;
        const lon = lon0 + j * dlon;
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
    speed[k] = round2(Math.hypot(uk, vk));
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

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
