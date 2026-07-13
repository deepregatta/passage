/**
 * TileForecastStore: assembles point forecasts and region grids from
 * precomputed PFT1 tile runs. Point sampling is a nearest-grid-point lookup
 * (leg midpoints are snapped to the 0.25° audit cell, which matches the
 * weather layer's native grid), resampled to whole hours for the findings
 * assembler. Region grids keep the tiles' native time axis — GridSampler
 * interpolates in time.
 */

import type { RegionGrid } from '../grids.js';
import { toIso } from '../eta.js';
import { decodeTile, type DecodedTile, type TileVariable } from './tileCodec.js';
import {
  axisTimesMs,
  nearestGridIndex,
  resampleToHourly,
  tileIdFor,
  tilesForBbox,
  type Bbox,
} from './tileMath.js';
import type {
  ForecastStore,
  LatestDoc,
  LayerInfo,
  RunManifest,
  TileCache,
  TileTransport,
} from './store.js';
import { MemoryTileCache } from './store.js';
import type {
  EnsemblePointForecast,
  HazardPointForecast,
  PointForecast,
  TileRequestMeta,
  WavePointForecast,
} from './types.js';

interface LayerState {
  manifest: RunManifest;
  /** decoded tiles by tile_id (in-memory; raw bytes live in the TileCache) */
  decoded: Map<string, DecodedTile | null>;
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
}

export class TileForecastStore implements ForecastStore {
  private transport: TileTransport;
  private cache: TileCache;
  private now: () => number;
  private layers = new Map<string, LayerState>();
  private latest: LatestDoc | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: TileForecastStoreOptions) {
    this.transport = options.transport;
    this.cache = options.cache ?? new MemoryTileCache();
    this.now = options.now ?? Date.now;
  }

  init(): Promise<void> {
    this.initPromise ??= this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    this.latest = await this.transport.fetchLatest();
    const liveRunIds: string[] = [];
    for (const [layer, entry] of Object.entries(this.latest.layers)) {
      // current run first; fall back to the retained previous run so a
      // half-published or missing manifest never takes the layer down
      for (const runId of [entry.run_id, entry.previous_run_id].filter(
        (id): id is string => Boolean(id),
      )) {
        try {
          const manifest = await this.transport.fetchManifest(runId);
          this.layers.set(layer, { manifest, decoded: new Map() });
          liveRunIds.push(runId);
          break;
        } catch {
          // try the previous run / drop the layer
        }
      }
    }
    if (!this.layers.has('weather')) {
      throw new Error('Forecast tiles unavailable: no readable weather run');
    }
    await this.cache.evictExcept(liveRunIds).catch(() => {});
  }

  describe(): Record<string, LayerInfo> {
    const out: Record<string, LayerInfo> = {};
    for (const [layer, state] of this.layers) {
      const m = state.manifest;
      out[layer] = {
        layer,
        model: m.model,
        run_id: m.run_id,
        cycle: m.cycle,
        resolution_deg: m.resolution_deg,
        member_count: m.member_count,
        published_at: m.published_at,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- tiles

  private async tileFor(
    layer: string,
    lat: number,
    lon: number,
    stats: { tiles: Set<string>; cached: number },
  ): Promise<DecodedTile | null> {
    const state = this.layers.get(layer);
    if (!state) return null;
    const tileId = tileIdFor(lat, lon);
    const memo = state.decoded.get(tileId);
    if (memo !== undefined) {
      stats.tiles.add(tileId);
      if (memo) stats.cached += 1;
      return memo;
    }

    let decoded: DecodedTile | null = null;
    if (state.manifest.tiles[tileId]) {
      const path = state.manifest.tiling.path_template.replace('{tile_id}', tileId);
      const key = `${state.manifest.run_id}/${path}`;
      let bytes = await this.cache.get(key);
      if (bytes) {
        stats.cached += 1;
      } else {
        bytes = await this.transport.fetchTile(state.manifest.run_id, path);
        await this.cache.put(key, bytes, state.manifest.run_id).catch(() => {});
      }
      decoded = decodeTile(bytes);
    }
    state.decoded.set(tileId, decoded);
    stats.tiles.add(tileId);
    return decoded;
  }

  private newStats() {
    return { tiles: new Set<string>(), cached: 0 };
  }

  private meta(
    layer: string,
    stats: { tiles: Set<string>; cached: number },
    points: number,
  ): TileRequestMeta {
    const m = this.layers.get(layer)!.manifest;
    return {
      source: 'tiles',
      layer,
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

  /** raw series at the grid point nearest (lat, lon), on the variable's native axis */
  private seriesAt(tile: DecodedTile, name: string, lat: number, lon: number): SampledSeries | null {
    const variable = tile.header.variables.find((v) => v.name === name);
    if (!variable) return null;
    const idx = nearestGridIndex(tile.header, lat, lon);
    if (!idx) return null;
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

  /** per-member series (mean + per-member anomaly encoding) at the nearest grid point */
  private memberSeriesAt(
    tile: DecodedTile,
    meanName: string,
    anomName: string,
    lat: number,
    lon: number,
  ): { timesMs: number[]; members: Array<Array<number | null>> } | null {
    const mean = this.seriesAt(tile, meanName, lat, lon);
    const anomVar = tile.header.variables.find((v) => v.name === anomName);
    if (!mean || !anomVar) return null;
    const idx = nearestGridIndex(tile.header, lat, lon)!;
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
    const stats = this.newStats();
    const forecasts: PointForecast[] = [];
    for (const p of points) {
      const tile = await this.tileFor('weather', p.lat, p.lon, stats);
      const u = tile && this.seriesAt(tile, 'wind_u_kt', p.lat, p.lon);
      const v = tile && this.seriesAt(tile, 'wind_v_kt', p.lat, p.lon);
      const gust = tile && this.seriesAt(tile, 'gust_kt', p.lat, p.lon);
      if (!tile || !u || !v || !gust) {
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
    return { forecasts, meta: this.meta('weather', stats, points.length) };
  }

  async getEnsembleForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: EnsemblePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    if (!this.layers.has('ensemble')) return null;
    const stats = this.newStats();
    const forecasts: EnsemblePointForecast[] = [];
    for (const p of points) {
      const tile = await this.tileFor('ensemble', p.lat, p.lon, stats);
      const wind = tile && this.memberSeriesAt(tile, 'wind_kt_mean', 'wind_kt_anom', p.lat, p.lon);
      if (!tile || !wind) {
        forecasts.push({ lat: p.lat, lon: p.lon, times: [], wind_kt_members: [], gust_kt_members: [] });
        continue;
      }
      const gust = this.memberSeriesAt(tile, 'gust_kt_mean', 'gust_kt_anom', p.lat, p.lon);
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
    return { forecasts, meta: this.meta('ensemble', stats, points.length) };
  }

  async getWaveForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ forecasts: WavePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    if (!this.layers.has('waves')) return null;
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
      const tile = await this.tileFor('waves', p.lat, p.lon, stats);
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
      if (tile) {
        for (const [field, varName] of scalarVars) {
          const series = this.seriesAt(tile, varName, p.lat, p.lon);
          if (!series) continue;
          const h = resampleToHourly(series.timesMs, series.values, startMs, endMs);
          out[field] = h.values;
          if (!out.times.length) out.times = h.times;
        }
        for (const [field, varName] of dirVars) {
          const series = this.seriesAt(tile, varName, p.lat, p.lon);
          if (!series) continue;
          out[field] = resampleDirectionToHourly(series.timesMs, series.values, startMs, endMs);
        }
      }
      forecasts.push(out);
    }
    return { forecasts, meta: this.meta('waves', stats, points.length) };
  }

  async getHazardForecasts(
    points: Array<{ lat: number; lon: number }>,
    startMs: number,
    endMs: number,
  ): Promise<{ byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] } | null> {
    await this.init();
    const byModel: Record<string, HazardPointForecast[]> = {};
    const meta: TileRequestMeta[] = [];
    for (const layer of ['weather', 'weather-ecmwf']) {
      const state = this.layers.get(layer);
      if (!state) continue;
      const stats = this.newStats();
      const forecasts: HazardPointForecast[] = [];
      for (const p of points) {
        const tile = await this.tileFor(layer, p.lat, p.lon, stats);
        const out: HazardPointForecast = {
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
        if (tile) {
          const u = this.seriesAt(tile, 'wind_u_kt', p.lat, p.lon);
          const v = this.seriesAt(tile, 'wind_v_kt', p.lat, p.lon);
          if (u && v) {
            const uH = resampleToHourly(u.timesMs, u.values, startMs, endMs);
            const vH = resampleToHourly(v.timesMs, v.values, startMs, endMs);
            const { speed, direction } = windFromUv(uH.values, vH.values);
            out.times = uH.times;
            out.wind_kt = speed;
            out.wind_dir_deg = direction;
          }
          for (const [field, varName] of [
            ['gust_kt', 'gust_kt'],
            ['visibility_m', 'visibility_m'],
            ['cape_jkg', 'cape_jkg'],
            ['temp_c', 'temp_c'],
            ['dew_point_c', 'dew_point_c'],
            ['precip_mm', 'precip_mm'],
          ] as const) {
            const series = this.seriesAt(tile, varName, p.lat, p.lon);
            if (!series) continue;
            const h = resampleToHourly(series.timesMs, series.values, startMs, endMs);
            out[field] = h.values;
            if (!out.times.length) out.times = h.times;
          }
        }
        forecasts.push(out);
      }
      byModel[state.manifest.model] = forecasts;
      meta.push(this.meta(layer, stats, points.length));
    }
    return Object.keys(byModel).length ? { byModel, meta } : null;
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
    } catch {
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
    let anyData = false;
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const lat = lat0 + i * dlat;
        const lon = lon0 + j * dlon;
        const tile = await this.tileFor(layer, lat, lon, stats);
        if (!tile) continue;
        const uS = this.seriesAt(tile, uName, lat, lon);
        const vS = this.seriesAt(tile, vName, lat, lon);
        if (!uS || !vS) continue;
        // map the tile's native axis onto the clipped grid axis by timestamp
        const index = new Map(uS.timesMs.map((t, k) => [t, k]));
        for (let t = 0; t < timeAxisMs.length; t++) {
          const k = index.get(timeAxisMs[t]!);
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
          ? `Forecast grid coarsened to ${round2(dlat)}° to keep this crossing within the browser point budget.`
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
    direction[k] = round1(((Math.atan2(-uk, -vk) * 180) / Math.PI + 360) % 360);
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
