/**
 * Region-grid sampling (contracts/region-grid.schema.json): bilinear in space,
 * linear in time. The ONLY spatial interpolation in the engine — fetching,
 * decoding, regridding and coastal gap-filling all live in the Python factory.
 * Land cells are null; sampling falls back to the nearest non-null corner.
 */

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

    const corners = [
      { v: this.at(tIdx, i0, j0, component), w: (1 - wi) * (1 - wj) },
      { v: this.at(tIdx, i0 + 1, j0, component), w: wi * (1 - wj) },
      { v: this.at(tIdx, i0, j0 + 1, component), w: (1 - wi) * wj },
      { v: this.at(tIdx, i0 + 1, j0 + 1, component), w: wi * wj },
    ];

    if (corners.every((c) => c.v !== null)) {
      return corners.reduce((sum, c) => sum + (c.v as number) * c.w, 0);
    }
    // near the coast: nearest non-null corner (Python already gap-filled ≤5 km offshore)
    const valid = corners.filter((c) => c.v !== null);
    if (!valid.length) return null;
    return valid.reduce((best, c) => (c.w > best.w ? c : best)).v;
  }

  /** sample u/v at (lat, lon, time); null outside coverage (space or time) */
  sample(lat: number, lon: number, timeMs: number): GridSample | null {
    const times = this.timesMs;
    if (!times.length || timeMs < times[0]! || timeMs > times[times.length - 1]!) return null;
    let k = times.findIndex((t) => t >= timeMs);
    if (k < 0) return null;
    if (k === 0) k = 1;
    const t0 = k - 1;
    const t1 = k;
    const alpha = (timeMs - times[t0]!) / Math.max(1, times[t1]! - times[t0]!);

    const parts: number[] = [];
    for (const component of ['u_kt', 'v_kt'] as const) {
      const v0 = this.sampleAtTime(t0, lat, lon, component);
      const v1 = this.sampleAtTime(t1, lat, lon, component);
      if (v0 === null || v1 === null) return null;
      parts.push(v0 + (v1 - v0) * alpha);
    }
    return { u_kt: round2(parts[0]!), v_kt: round2(parts[1]!) };
  }
}

const DEG = Math.PI / 180;

/** current component along a course (°true): + fair, − foul */
export function alongCourseKt(sample: GridSample, courseDegTrue: number): number {
  return round2(sample.u_kt * Math.sin(courseDegTrue * DEG) + sample.v_kt * Math.cos(courseDegTrue * DEG));
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
