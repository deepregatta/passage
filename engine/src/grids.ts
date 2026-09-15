/**
 * Region-grid sampling (contracts/region-grid.schema.json): bilinear in space,
 * linear in time. Prepared grids can come from the Python factory; browser
 * routing can also build small route-local grids from live point forecasts.
 * Land cells are null; sampling falls back to the nearest non-null corner.
 */

import { alongCourseComponentKt } from './vectors.js';
import { parseUtc } from './eta.js';

export interface RegionGrid {
  schema_version: number;
  kind: 'wind10m' | 'surface_current';
  run_id: string;
  generated_at: string;
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  time_axis: string[];
  u_kt: Array<number | null>;
  v_kt: Array<number | null>;
  under_resolved_note?: string | null;
  source: {
    mode: 'live' | 'fixture' | 'synthetic';
    dataset_id?: string | null;
    resolution_deg?: number | null;
    fetched_at?: string | null;
  };
}

export interface GridSample {
  u_kt: number;
  v_kt: number;
}

export class GridSampler {
  private timesMs: number[];

  constructor(private grid: RegionGrid) {
    this.timesMs = grid.time_axis.map(parseUtc);
  }

  private at(t: number, i: number, j: number, component: 'u_kt' | 'v_kt'): number | null {
    const { nlat, nlon } = this.grid;
    if (i < 0 || i >= nlat || j < 0 || j >= nlon) return null;
    return this.grid[component][(t * nlat + i) * nlon + j] ?? null;
  }

  /** bilinear over the 4 surrounding cells at one time index; nearest non-null fallback */
  private sampleAtTime(tIdx: number, lat: number, lon: number, component: 'u_kt' | 'v_kt'): number | null {
    const { lat0, lon0, dlat, dlon } = this.grid;
    const fi = (lat - lat0) / dlat;
    const fj = (lon - lon0) / dlon;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const wi = fi - i0;
    const wj = fj - j0;

    const v00 = this.at(tIdx, i0, j0, component);
    const v10 = this.at(tIdx, i0 + 1, j0, component);
    const v01 = this.at(tIdx, i0, j0 + 1, component);
    const v11 = this.at(tIdx, i0 + 1, j0 + 1, component);
    const w00 = (1 - wi) * (1 - wj);
    const w10 = wi * (1 - wj);
    const w01 = (1 - wi) * wj;
    const w11 = wi * wj;

    if (v00 !== null && v10 !== null && v01 !== null && v11 !== null) {
      return 0 + v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11;
    }
    // Near the coast, keep the first wet corner on equal weights, in the same
    // order as the bilinear sum. No corner objects/arrays in this routing hot path.
    let best = v00;
    let weight = w00;
    if (v10 !== null && (best === null || w10 > weight)) {
      best = v10;
      weight = w10;
    }
    if (v01 !== null && (best === null || w01 > weight)) {
      best = v01;
      weight = w01;
    }
    if (v11 !== null && (best === null || w11 > weight)) best = v11;
    return best;
  }

  /** sample u/v at (lat, lon, time); null outside coverage (space or time) */
  sample(lat: number, lon: number, timeMs: number): GridSample | null {
    const times = this.timesMs;
    if (!times.length || !Number.isFinite(timeMs) || timeMs < times[0]! || timeMs > times[times.length - 1]!) return null;
    // First timestamp >= timeMs on the ordered axis, including irregular steps.
    let k = 0;
    let hi = times.length - 1;
    while (k < hi) {
      const mid = Math.floor((k + hi) / 2);
      if (times[mid]! < timeMs) k = mid + 1;
      else hi = mid;
    }
    if (k === 0 && times.length > 1) k = 1;
    const t0 = Math.max(0, k - 1);
    const t1 = k;
    const alpha = (timeMs - times[t0]!) / Math.max(1, times[t1]! - times[t0]!);

    const u0 = this.sampleAtTime(t0, lat, lon, 'u_kt');
    const u1 = this.sampleAtTime(t1, lat, lon, 'u_kt');
    if (u0 === null || u1 === null) return null;
    const v0 = this.sampleAtTime(t0, lat, lon, 'v_kt');
    const v1 = this.sampleAtTime(t1, lat, lon, 'v_kt');
    if (v0 === null || v1 === null) return null;
    return { u_kt: round2(u0 + (u1 - u0) * alpha), v_kt: round2(v0 + (v1 - v0) * alpha) };
  }
}

const DEG = Math.PI / 180;

/** current component along a course (°true): + fair, − foul */
export function alongCourseKt(sample: GridSample, courseDegTrue: number): number {
  return round2(alongCourseComponentKt(sample, courseDegTrue));
}

export function crossCourseKt(sample: GridSample, courseDegTrue: number): number {
  return round2(sample.u_kt * Math.cos(courseDegTrue * DEG) - sample.v_kt * Math.sin(courseDegTrue * DEG));
}

/** direction the current sets TOWARD, °true */
export function currentSetDeg(sample: GridSample): number {
  return (Math.atan2(sample.u_kt, sample.v_kt) / DEG + 360) % 360;
}

export function currentSpeedKt(sample: GridSample): number {
  return round2(Math.hypot(sample.u_kt, sample.v_kt));
}

const round2 = (x: number) => Math.round(x * 100) / 100;
