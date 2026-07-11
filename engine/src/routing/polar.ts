/**
 * Boat polar interpolation (contracts/polar.schema.json): bilinear over the
 * TWS×TWA table, symmetric in TWA, clamped at table edges. A no-go cone below
 * MIN_TWA returns 0 — the router must tack, not sail through the wind.
 */

export interface Polar {
  schema_version: number;
  polar_id: string;
  label: string;
  tws_kt: number[];
  twa_deg: number[];
  speeds_kt: number[][];
  source: { kind: string; match_type?: string | null; matched_value?: string | null };
}

const MIN_TWA_DEG = 33;

export function boatSpeedKt(polar: Polar, twsKt: number, twaDeg: number): number {
  const twa = Math.abs(twaDeg);
  if (twa < MIN_TWA_DEG) return 0;

  const speed = bilinear(polar.tws_kt, polar.twa_deg, polar.speeds_kt, twsKt, twa);
  return Math.max(0, speed);
}

function bilinear(
  xs: number[],
  ys: number[],
  table: number[][],
  x: number,
  y: number,
): number {
  const xi = bracket(xs, x);
  const yi = bracket(ys, y);
  const x0 = xs[xi]!;
  const x1 = xs[xi + 1] ?? x0;
  const y0 = ys[yi]!;
  const y1 = ys[yi + 1] ?? y0;
  const tx = x1 === x0 ? 0 : clamp01((x - x0) / (x1 - x0));
  const ty = y1 === y0 ? 0 : clamp01((y - y0) / (y1 - y0));

  const v00 = table[xi]?.[yi] ?? 0;
  const v10 = table[xi + 1]?.[yi] ?? v00;
  const v01 = table[xi]?.[yi + 1] ?? v00;
  const v11 = table[xi + 1]?.[yi + 1] ?? v10;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/** index i such that xs[i] <= x (clamped into the table) */
function bracket(xs: number[], x: number): number {
  if (x <= xs[0]!) return 0;
  for (let i = 0; i < xs.length - 1; i++) {
    if (x < xs[i + 1]!) return i;
  }
  return xs.length - 2 >= 0 ? xs.length - 2 : 0;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
