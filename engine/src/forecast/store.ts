/**
 * ForecastStore: the engine's only weather-data source. Implementations read
 * immutable PFT1 tile runs (contracts/forecast-latest.schema.json points at
 * them) and assemble the point-forecast and region-grid shapes the findings
 * assembler and router already consume.
 */

import type { RegionGrid } from '../grids.js';
import type { VariableStatistic } from './tileCodec.js';
import type { Bbox } from './tileMath.js';
import type {
  EnsemblePointForecast,
  HazardPointForecast,
  PointForecast,
  TileRequestMeta,
  WavePointForecast,
} from './types.js';

export interface LatestLayer {
  run_id: string;
  previous_run_id?: string | null;
  cycle: string;
  member_count?: number;
  published_at: string;
  /** Hours between the layer's scheduled publications, from the producer (optional). */
  cadence_hours?: number;
}

export interface LatestDoc {
  schema_version: number;
  updated_at: string;
  layers: Record<string, LatestLayer>;
}

export interface ManifestTimeAxis {
  base: string;
  offsets_h: number[];
}

export interface RunManifest {
  schema_version: number;
  run_id: string;
  layer: string;
  model: string;
  cycle: string;
  member_count: number;
  resolution_deg: number;
  horizon_h: number;
  time_axes: Record<string, ManifestTimeAxis>;
  variables: Array<{
    name: string;
    axis: string;
    dtype: string;
    scale: number;
    per_member?: boolean;
    statistic?: VariableStatistic;
  }>;
  tiling: { tile_deg: number; path_template: string };
  tiles: Record<string, { bytes: number; fnv64: string; decoded_bytes?: number; uncompressed_bytes?: number }>;
  coverage?: Bbox;
  served_grid?: { lat0: number; lon0: number; dlat: number; dlon: number; nlat: number; nlon: number };
  capabilities?: string[];
  attribution?: string;
  provenance?: Record<string, unknown>;
  totals: { tile_count: number; bytes: number };
  published_at: string;
}

/**
 * A tile of a pinned run answered 404: forecast-tiles keeps only the current
 * and previous run of each layer, so a page that stays open long enough
 * outlives its runs. Refresh the store (`TileForecastStore.refresh`) and
 * retry. `status` stays 404 for callers that test the HTTP status.
 */
export class ForecastRunGoneError extends Error {
  readonly status = 404;
  constructor(
    readonly layer: string,
    readonly runId: string,
    options?: { cause?: unknown },
  ) {
    super(`forecast run ${runId} is no longer published (HTTP 404)`, options);
    this.name = 'ForecastRunGoneError';
  }
}

/** The ForecastRunGoneError behind an error, following `cause` links. */
export function forecastRunGone(error: unknown): ForecastRunGoneError | null {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof ForecastRunGoneError) return e;
  }
  return null;
}

export interface TileFetchOptions {
  cache?: 'force-cache' | 'reload';
}

export interface TileTransport {
  fetchLatest(): Promise<LatestDoc>;
  fetchRegionalLatest?(): Promise<LatestDoc>;
  fetchManifest(runId: string): Promise<RunManifest>;
  /** Stored gzip bytes, so the store can verify the manifest hash before decoding. */
  fetchTile(runId: string, path: string, options?: TileFetchOptions): Promise<Uint8Array>;
}

export interface TileCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, runId: string): Promise<void>;
  /** Remove one corrupt entry without evicting healthy tiles in the same run. */
  delete(key: string): Promise<void>;
  /** drop everything not belonging to the given run ids */
  evictExcept(runIds: string[]): Promise<void>;
}

export class MemoryTileCache implements TileCache {
  private store = new Map<string, { bytes: Uint8Array; runId: string }>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.bytes ?? null;
  }
  async put(key: string, bytes: Uint8Array, runId: string): Promise<void> {
    this.store.set(key, { bytes, runId });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async evictExcept(runIds: string[]): Promise<void> {
    const keep = new Set(runIds);
    for (const [key, entry] of this.store) {
      if (!keep.has(entry.runId)) this.store.delete(key);
    }
  }
}

export interface LayerInfo {
  regional?: boolean;
  attribution?: string;
  layer: string;
  model: string;
  run_id: string;
  cycle: string;
  resolution_deg: number;
  member_count: number;
  published_at: string;
  /** latest.json's `cadence_hours` for the layer, when the producer publishes one. */
  cadence_hours?: number;
}

export interface ForecastStore {
  /** load latest.json + per-layer manifests; idempotent */
  init(): Promise<void>;
  /** layers actually available after init (a layer outage drops it, not the analysis) */
  describe(): Record<string, LayerInfo>;
  getPointForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: PointForecast[]; meta: TileRequestMeta }>;
  getEnsembleForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: EnsemblePointForecast[]; meta: TileRequestMeta } | null>;
  getWaveForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: WavePointForecast[]; meta: TileRequestMeta } | null>;
  getHazardForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] } | null>;
  getWindGrid(bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid>;
  getCurrentGrid(bbox: Bbox, startIso: string, hours: number): Promise<RegionGrid | null>;
}
