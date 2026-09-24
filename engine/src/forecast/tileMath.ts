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

/** Longitude wrapped once into [−180, 180). */
export function normalizeLon(lon: number): number {
  return lon >= 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
}

export function tileOrigin(lat: number, lon: number): TileOrigin {
  return {
    lat0: Math.floor(lat / TILE_DEG) * TILE_DEG,
    lon0: Math.floor(normalizeLon(lon) / TILE_DEG) * TILE_DEG,
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

export interface GridIndex {
  i: number;
  j: number;
  flat: number;
}

/** Rounded lattice position of (lat, lon) in a tile header, unbounded. */
function roundedGridIndex(header: TileHeader, lat: number, lon: number): { i: number; j: number } {
  return {
    i: Math.round((lat - header.lat0) / header.dlat),
    j: Math.round((lon - header.lon0) / header.dlon),
  };
}

/** Index of the grid point nearest to (lat, lon) in a tile, or null when the
 * point is outside the tile's grid. Flat index = i * nlon + j (per time step). */
export function nearestGridIndex(header: TileHeader, lat: number, lon: number): GridIndex | null {
  const { i, j } = roundedGridIndex(header, lat, lon);
  if (i < 0 || i >= header.nlat || j < 0 || j >= header.nlon) return null;
  return { i, j, flat: i * header.nlon + j };
}

/** A tile to sample, with the query point in that tile's longitude frame. */
export interface TileProbe {
  tileId: string;
  lat: number;
  lon: number;
}

/**
 * Neighbouring tiles that can hold the native grid point nearest (lat, lon)
 * when the tile containing the point does not. Tiles slice the provider grid
 * half-open, so within one cell of a 10° line that point can be the
 * neighbour's first row/column (the point on the line) or, for grids offset
 * from the lines (docs/forecast-tile-format.md), its last. Given the home
 * tile's header, only the side its rounded index overflows is probed; without
 * one (the tile is unpublished), every side within `cellDeg`, edge neighbours
 * before the diagonal. Probe longitudes stay continuous across the
 * antimeridian. Callers check each probe with nearestGridIndex on that tile's
 * own header, which rejects probes whose grid is not nearer.
 */
export function edgeNeighbourProbes(
  header: TileHeader | null,
  lat: number,
  lon: number,
  cellDeg: number,
): TileProbe[] {
  const x = normalizeLon(lon);
  const { lat0, lon0 } = tileOrigin(lat, x);
  const idx = header && roundedGridIndex(header, lat, x);
  const dlat = header?.dlat ?? cellDeg;
  const dlon = header?.dlon ?? cellDeg;
  const di = lat - lat0 < dlat && (!idx || idx.i < 0) ? -1
    : lat0 + TILE_DEG - lat <= dlat && (!idx || idx.i >= header!.nlat) ? 1 : 0;
  const dj = x - lon0 < dlon && (!idx || idx.j < 0) ? -1
    : lon0 + TILE_DEG - x <= dlon && (!idx || idx.j >= header!.nlon) ? 1 : 0;
  const steps: Array<[number, number]> = !header && di && dj ? [[di, 0], [0, dj], [di, dj]] : [[di, dj]];
  const probes: TileProbe[] = [];
  for (const [si, sj] of steps) {
    const pLat0 = lat0 + si * TILE_DEG;
    if ((!si && !sj) || pLat0 < -90 || pLat0 >= 90) continue;
    const pLon0 = lon0 + sj * TILE_DEG;
    const wrap = pLon0 >= 180 ? -360 : pLon0 < -180 ? 360 : 0;
    probes.push({ tileId: tileIdFromOrigin({ lat0: pLat0, lon0: pLon0 + wrap }), lat, lon: x + wrap });
  }
  return probes;
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
