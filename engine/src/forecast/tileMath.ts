/**
 * Tile geometry and time-axis helpers for PFT1 forecast tiles
 * (docs/forecast-tile-format.md): 10°×10° tiles named by their SW corner,
 * half-open on both axes, longitudes in [−180, 180).
 */

import { parseUtc, toIso } from '../eta.js';
import type { TileHeader } from './tileCodec.js';

export const TILE_DEG = 10;

export interface TileOrigin {
  lat0: number;
  lon0: number;
}

export function tileOrigin(lat: number, lon: number): TileOrigin {
  const normLon = lon >= 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
  return {
    lat0: Math.floor(lat / TILE_DEG) * TILE_DEG,
    lon0: Math.floor(normLon / TILE_DEG) * TILE_DEG,
  };
}

export function tileIdFromOrigin(origin: TileOrigin): string {
  const ns = origin.lat0 >= 0 ? 'N' : 'S';
  const ew = origin.lon0 >= 0 ? 'E' : 'W';
  const lat = String(Math.abs(origin.lat0)).padStart(2, '0');
  const lon = String(Math.abs(origin.lon0)).padStart(3, '0');
  return `${ns}${lat}${ew}${lon}`;
}

export function tileIdFor(lat: number, lon: number): string {
  return tileIdFromOrigin(tileOrigin(lat, lon));
}

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Tile ids intersecting the bbox. Antimeridian-crossing boxes are rejected,
 * matching routeBbox() which never produces them. */
export function tilesForBbox(bbox: Bbox): string[] {
  if (bbox.minLon > bbox.maxLon) {
    throw new Error('antimeridian-crossing bounding boxes are not supported');
  }
  const latLo = Math.floor(Math.max(bbox.minLat, -90) / TILE_DEG) * TILE_DEG;
  const latHi = Math.floor(Math.min(bbox.maxLat, 89.999) / TILE_DEG) * TILE_DEG;
  const lonLo = Math.floor(Math.max(bbox.minLon, -180) / TILE_DEG) * TILE_DEG;
  const lonHi = Math.floor(Math.min(bbox.maxLon, 179.999) / TILE_DEG) * TILE_DEG;
  const ids: string[] = [];
  for (let lat0 = latLo; lat0 <= latHi; lat0 += TILE_DEG) {
    for (let lon0 = lonLo; lon0 <= lonHi; lon0 += TILE_DEG) {
      ids.push(tileIdFromOrigin({ lat0, lon0 }));
    }
  }
  return ids;
}

/** Millisecond timestamps of a tile time axis. */
export function axisTimesMs(header: TileHeader, axis: string): number[] {
  const ax = header.time_axes[axis];
  if (!ax) throw new Error(`unknown time axis: ${axis}`);
  const baseMs = parseUtc(ax.base);
  return ax.offsets_h.map((h) => baseMs + h * 3_600_000);
}

/** Index of the grid point nearest to (lat, lon) in a tile, or null when the
 * point is outside the tile's grid. Flat index = i * nlon + j (per time step). */
export function nearestGridIndex(
  header: TileHeader,
  lat: number,
  lon: number,
): { i: number; j: number; flat: number } | null {
  const i = Math.round((lat - header.lat0) / header.dlat);
  const j = Math.round((lon - header.lon0) / header.dlon);
  if (i < 0 || i >= header.nlat || j < 0 || j >= header.nlon) return null;
  return { i, j, flat: i * header.nlon + j };
}

/**
 * Linearly resample a (possibly non-hourly) series onto whole UTC hours
 * covering [startMs, endMs]. Null propagates: an output hour is null unless
 * both bracketing source steps are finite. No extrapolation outside the axis.
 * Directions must not be resampled with this — interpolate u/v instead.
 */
export function resampleToHourly(
  timesMs: number[],
  values: Array<number | null>,
  startMs: number,
  endMs: number,
): { times: string[]; values: Array<number | null> } {
  const HOUR = 3_600_000;
  const first = Math.floor(startMs / HOUR) * HOUR;
  const last = Math.ceil(endMs / HOUR) * HOUR;
  const outTimes: string[] = [];
  const outValues: Array<number | null> = [];
  let k = 1;
  for (let t = first; t <= last; t += HOUR) {
    outTimes.push(toIso(t));
    if (!timesMs.length || t < timesMs[0]! || t > timesMs[timesMs.length - 1]!) {
      outValues.push(null);
      continue;
    }
    while (k < timesMs.length && timesMs[k]! < t) k++;
    const t1 = timesMs[k]!;
    const t0 = timesMs[k - 1]!;
    const v0 = values[k - 1] ?? null;
    const v1 = values[k] ?? null;
    if (t === t0) {
      outValues.push(v0);
    } else if (t === t1) {
      outValues.push(v1);
    } else if (v0 === null || v1 === null) {
      outValues.push(null);
    } else {
      const alpha = (t - t0) / (t1 - t0);
      outValues.push(v0 + (v1 - v0) * alpha);
    }
  }
  return { times: outTimes, values: outValues };
}
