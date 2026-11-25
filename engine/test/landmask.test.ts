import { describe, expect, it } from 'vitest';
import { haversineNm, interpolatePosition } from '../src/geo.js';
import { isLand, segmentCrossesLand, type LandMask } from '../src/routing/landmask.js';

type P = { lat: number; lon: number };

function maskOf(lat0: number, lon0: number, d: number, nlat: number, nlon: number, landCells: Array<[number, number]>): LandMask {
  const land = Array<number>(nlat * nlon).fill(0);
  for (const [i, j] of landCells) land[i * nlon + j] = 1;
  return { schema_version: 1, kind: 'land_mask', lat0, lon0, dlat: d, dlon: d, nlat, nlon, land };
}

/** The land check before 2026-11-25, kept here only to prove the walk flags everything it flagged. */
function sampledCrossesLand(mask: LandMask, a: P, b: P): boolean {
  const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
  const steps = Math.max(2, Math.ceil(dist / 0.4));
  for (let k = 0; k <= steps; k++) {
    const p = interpolatePosition(a, b, k / steps);
    if (isLand(mask, p.lat, p.lon)) return true;
  }
  return false;
}

/**
 * Brute-force reference: clip the leg (straight in lat/lon) against every land cell, closed
 * (Liang-Barsky). A contact that is only the leg's own endpoint is left to isLand at that point.
 */
function referenceCrossesLand(mask: LandMask, a: P, b: P): boolean {
  if (isLand(mask, a.lat, a.lon) || isLand(mask, b.lat, b.lon)) return true;
  const ua = (a.lat - mask.lat0) / mask.dlat;
  const va = (a.lon - mask.lon0) / mask.dlon;
  const du = (b.lat - mask.lat0) / mask.dlat - ua;
  const dv = (b.lon - mask.lon0) / mask.dlon - va;
  if (du === 0 && dv === 0) return false;
  // An end exactly on a corner between two diagonal land cells (the other two sea) keeps its contacts.
  const cellLand = (i: number, j: number) =>
    i >= 0 && i < mask.nlat && j >= 0 && j < mask.nlon && mask.land[i * mask.nlon + j] === 1;
  const pinch = (u: number, v: number) => {
    if (Math.abs(u - Math.round(u)) !== 0.5 || Math.abs(v - Math.round(v)) !== 0.5) return false;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const sw = cellLand(i, j); const se = cellLand(i, j + 1); const nw = cellLand(i + 1, j); const ne = cellLand(i + 1, j + 1);
    return sw === ne && se === nw && sw !== se;
  };
  const keepA = pinch(ua, va);
  const keepB = pinch(ua + du, va + dv);
  for (let i = 0; i < mask.nlat; i++) {
    for (let j = 0; j < mask.nlon; j++) {
      if (mask.land[i * mask.nlon + j] !== 1) continue;
      let t0 = 0;
      let t1 = 1;
      let inside = true;
      for (const [p, q] of [[-du, ua - (i - 0.5)], [du, i + 0.5 - ua], [-dv, va - (j - 0.5)], [dv, j + 0.5 - va]] as const) {
        if (p === 0) {
          if (q < 0) inside = false;
          continue;
        }
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
      if (!inside || t0 > t1) continue;
      if ((t1 === 0 && !keepA) || (t0 === 1 && !keepB)) continue; // touches only at an endpoint
      return true;
    }
  }
  return false;
}

/** Both directions must agree; returns the common answer. */
function crosses(mask: LandMask, a: P, b: P): boolean {
  const forward = segmentCrossesLand(mask, a, b);
  expect(segmentCrossesLand(mask, b, a)).toBe(forward);
  return forward;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('segmentCrossesLand: exact walk over the mask cells', () => {
  it('flags a leg clipping one land cell corner for 0.25 nm (the Brest roads → Ouessant edge)', () => {
    // The production mask's 0.05° cells around (48.30, -4.80), with only that cell land:
    // the computed-route edge was 0.250 nm inside it and the 0.4 nm sampler stepped over it.
    const mask = maskOf(48.0, -5.0, 0.05, 13, 11, [[6, 4]]);
    const a = { lat: 48.27, lon: -4.81 };
    const b = { lat: 48.29, lon: -4.85 };
    expect(sampledCrossesLand(mask, a, b)).toBe(false);
    expect(referenceCrossesLand(mask, a, b)).toBe(true);
    expect(crosses(mask, a, b)).toBe(true);
  });

  it('flags a leg clipping one land cell for about 0.2 nm (an edge near the Newport → NYC one)', () => {
    // Land cell (41.35, -71.45) of the production grid; this edge, 0.01° from the computed one,
    // enters it across its south-east corner where no 0.4 nm sample falls.
    const mask = maskOf(41.0, -71.7, 0.05, 13, 13, [[7, 5]]);
    const a = { lat: 41.336, lon: -71.39 };
    const b = { lat: 41.32, lon: -71.446 };
    expect(sampledCrossesLand(mask, a, b)).toBe(false);
    expect(referenceCrossesLand(mask, a, b)).toBe(true);
    expect(crosses(mask, a, b)).toBe(true);
  });

  it('flags a corner clip far shorter than any sample spacing', () => {
    // Cell (5, 5) spans lat/lon [0.225, 0.275] on a 0.05° grid from 0. The anti-diagonal
    // lat + lon = 0.451 cuts its south-west corner over 0.0014° (0.08 nm).
    const mask = maskOf(0, 0, 0.05, 8, 8, [[5, 5]]);
    const a = { lat: 0.2200, lon: 0.2310 };
    const b = { lat: 0.2310, lon: 0.2200 };
    expect(isLand(mask, a.lat, a.lon)).toBe(false);
    expect(isLand(mask, b.lat, b.lon)).toBe(false);
    expect(sampledCrossesLand(mask, a, b)).toBe(false);
    expect(referenceCrossesLand(mask, a, b)).toBe(true);
    expect(crosses(mask, a, b)).toBe(true);
    // Moved 0.002° south-west (lat + lon = 0.449), the same leg misses the cell.
    const a2 = { lat: 0.2190, lon: 0.2300 };
    const b2 = { lat: 0.2300, lon: 0.2190 };
    expect(referenceCrossesLand(mask, a2, b2)).toBe(false);
    expect(crosses(mask, a2, b2)).toBe(false);
  });

  it('north-south and east-west legs: a land cell in the line is flagged, the next column or row is not', () => {
    // 0.25° cells (exact in binary): cell (2, 2) spans [0.375, 0.625] in lat and lon.
    const mask = maskOf(0, 0, 0.25, 5, 5, [[2, 2]]);
    expect(crosses(mask, { lat: 0, lon: 0.5 }, { lat: 1, lon: 0.5 })).toBe(true);
    expect(crosses(mask, { lat: 0.5, lon: 0 }, { lat: 0.5, lon: 1 })).toBe(true);
    expect(crosses(mask, { lat: 0, lon: 0.3 }, { lat: 1, lon: 0.3 })).toBe(false);
    expect(crosses(mask, { lat: 0.7, lon: 0 }, { lat: 0.7, lon: 1 })).toBe(false);
    // Short legs ending just short of the cell.
    expect(crosses(mask, { lat: 0.5, lon: 0.1 }, { lat: 0.5, lon: 0.37 })).toBe(false);
    expect(crosses(mask, { lat: 0.5, lon: 0.1 }, { lat: 0.5, lon: 0.38 })).toBe(true);
  });

  it('a leg along a land cell edge, or through its corner, counts as touching it', () => {
    const mask = maskOf(0, 0, 0.25, 5, 5, [[2, 2]]);
    // Along the south edge (lat 0.375) and the east edge (lon 0.625), passing the whole cell.
    expect(crosses(mask, { lat: 0.375, lon: 0 }, { lat: 0.375, lon: 1 })).toBe(true);
    expect(crosses(mask, { lat: 0, lon: 0.625 }, { lat: 1, lon: 0.625 })).toBe(true);
    // Through the south-west corner (0.375, 0.375) only, on the anti-diagonal.
    expect(crosses(mask, { lat: 0.25, lon: 0.5 }, { lat: 0.5, lon: 0.25 })).toBe(true);
    // The same leg a hair off the corner does not.
    expect(crosses(mask, { lat: 0.25, lon: 0.4999 }, { lat: 0.4999, lon: 0.25 })).toBe(false);
  });

  it('a diagonal wall of land cells meeting only at corners cannot be slipped through at a corner, in one leg or two', () => {
    // Cells (1, 3), (2, 2), (3, 1): (1, 3) and (2, 2) share the corner (0.375, 0.625).
    const mask = maskOf(0, 0, 0.25, 5, 5, [[1, 3], [2, 2], [3, 1]]);
    const a = { lat: 0.25, lon: 0.5 };
    const b = { lat: 0.5, lon: 0.75 };
    expect(isLand(mask, a.lat, a.lon)).toBe(false);
    expect(isLand(mask, b.lat, b.lon)).toBe(false);
    expect(sampledCrossesLand(mask, a, b)).toBe(false);
    expect(crosses(mask, a, b)).toBe(true);
    // Nor through two legs meeting at a node on that corner, which isLand calls sea.
    const c = { lat: 0.375, lon: 0.625 };
    expect(isLand(mask, c.lat, c.lon)).toBe(false);
    expect(crosses(mask, a, c)).toBe(true);
    expect(crosses(mask, c, b)).toBe(true);
    // A node a hair (4e-9 of a cell) inside the sea cell (2, 3) past the corner: the leg
    // reaching it through the corner touches the wall; leaving it into (2, 3) is sea.
    const near = { lat: 0.375 + 1e-9, lon: 0.625 + 1e-9 };
    expect(isLand(mask, near.lat, near.lon)).toBe(false);
    expect(crosses(mask, a, near)).toBe(true);
    expect(crosses(mask, near, b)).toBe(false);
  });

  it('an end on a corner keeps the end-point exception unless the corner is a pinch', () => {
    // Corner (0.375, 0.625) of 0.25° cells: SW (1, 2), SE (1, 3), NW (2, 2), NE (2, 3);
    // isLand puts the corner itself in NE (2, 3), sea in every mask below.
    const c = { lat: 0.375, lon: 0.625 };
    const intoNE = { lat: 0.5, lon: 0.75 };
    const intoNW = { lat: 0.5, lon: 0.5 };
    const intoSE = { lat: 0.25, lon: 0.75 };
    // One land cell (SW): leaving into any sea cell is sea.
    const one = maskOf(0, 0, 0.25, 5, 5, [[1, 2]]);
    expect(crosses(one, c, intoNE)).toBe(false);
    expect(crosses(one, c, intoNW)).toBe(false);
    expect(crosses(one, c, intoSE)).toBe(false);
    // Two edge-adjacent land cells (SW, SE): the sea above is one region.
    const two = maskOf(0, 0, 0.25, 5, 5, [[1, 2], [1, 3]]);
    expect(crosses(two, c, intoNE)).toBe(false);
    expect(crosses(two, c, intoNW)).toBe(false);
    // Three land cells (SW, SE, NW): only NE is sea, and leaving into it is sea.
    const three = maskOf(0, 0, 0.25, 5, 5, [[1, 2], [1, 3], [2, 2]]);
    expect(crosses(three, c, intoNE)).toBe(false);
    expect(crosses(three, c, intoNW)).toBe(true);
    // Pinch (SW, NE land would put c on land; here SE and NW land): no exception.
    const pinch = maskOf(0, 0, 0.25, 5, 5, [[1, 3], [2, 2]]);
    expect(crosses(pinch, c, intoNE)).toBe(true);
    expect(crosses(pinch, c, { lat: 0.25, lon: 0.5 })).toBe(true);
  });

  it('an endpoint on a land cell boundary is judged by isLand, as every other point check is', () => {
    const mask = maskOf(0, 0, 0.25, 5, 5, [[2, 2]]);
    // (0.375, 0.5) is on the cell's south edge; Math.round puts it in the land cell: on land.
    expect(isLand(mask, 0.375, 0.5)).toBe(true);
    expect(crosses(mask, { lat: 0.375, lon: 0.5 }, { lat: 0, lon: 0.5 })).toBe(true);
    // (0.625, 0.5) is on its north edge; Math.round puts it in the sea cell above. A leg
    // leaving it northward touches the land cell only at that sea point and stays sea.
    expect(isLand(mask, 0.625, 0.5)).toBe(false);
    expect(crosses(mask, { lat: 0.625, lon: 0.5 }, { lat: 1, lon: 0.5 })).toBe(false);
    expect(crosses(mask, { lat: 0.625, lon: 0.5 }, { lat: 1, lon: 1 })).toBe(false);
    // From the north-east corner (0.625, 0.625), also a sea point, outward.
    expect(isLand(mask, 0.625, 0.625)).toBe(false);
    expect(crosses(mask, { lat: 0.625, lon: 0.625 }, { lat: 1, lon: 1 })).toBe(false);
    // But running along the edge from there, or back across the cell, touches land.
    expect(crosses(mask, { lat: 0.625, lon: 0.625 }, { lat: 0.625, lon: 0 })).toBe(true);
    expect(crosses(mask, { lat: 0.625, lon: 0.625 }, { lat: 0, lon: 0 })).toBe(true);
  });

  it('a zero-length leg is the point check', () => {
    const mask = maskOf(0, 0, 0.25, 5, 5, [[2, 2]]);
    for (const p of [{ lat: 0.5, lon: 0.5 }, { lat: 0.375, lon: 0.375 }, { lat: 0.625, lon: 0.5 }, { lat: 0.1, lon: 0.9 }, { lat: 9, lon: 9 }]) {
      expect(segmentCrossesLand(mask, p, p)).toBe(isLand(mask, p.lat, p.lon));
    }
  });

  it('a comb of one-cell teeth: legs between teeth are sea, legs grazing a tooth are land', () => {
    // Row 3 is land in every even column (0.25° cells: row 3 spans lat [0.625, 0.875]).
    const teeth = Array.from({ length: 5 }, (_, k) => [3, 2 * k] as [number, number]);
    const mask = maskOf(0, 0, 0.25, 7, 10, teeth);
    // North-south through the odd-column gaps (column 1 spans lon [0.125, 0.375]).
    expect(crosses(mask, { lat: 0, lon: 0.25 }, { lat: 1.5, lon: 0.25 })).toBe(false);
    expect(crosses(mask, { lat: 0, lon: 0.13 }, { lat: 1.5, lon: 0.37 })).toBe(false);
    // Slanted enough to clip the tooth next to the gap.
    expect(crosses(mask, { lat: 0, lon: 0.13 }, { lat: 1.5, lon: 0.6 })).toBe(true);
    // Exactly along the gap's side (lon 0.375 is a tooth's west edge): touching.
    expect(crosses(mask, { lat: 0, lon: 0.375 }, { lat: 1.5, lon: 0.375 })).toBe(true);
    // East-west just south of the teeth and just north of them.
    expect(crosses(mask, { lat: 0.6, lon: 0 }, { lat: 0.6, lon: 2.4 })).toBe(false);
    expect(crosses(mask, { lat: 0.9, lon: 0 }, { lat: 0.9, lon: 2.4 })).toBe(false);
    // A shallow leg from one gap to the next crosses the tooth between them.
    expect(crosses(mask, { lat: 0.7, lon: 0.25 }, { lat: 0.8, lon: 0.75 })).toBe(true);
  });

  it('a checkerboard: every diagonal through cell corners touches land, a leg inside one sea cell does not', () => {
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2 === 0) cells.push([i, j]);
    const mask = maskOf(0, 0, 0.25, 8, 8, cells);
    // Cell (0, 1) is sea and spans lat [-0.125, 0.125], lon [0.125, 0.375].
    expect(crosses(mask, { lat: -0.1, lon: 0.15 }, { lat: 0.1, lon: 0.35 })).toBe(false);
    // The diagonal of sea cells (i + j odd) runs through the corners shared with land cells.
    expect(crosses(mask, { lat: 0, lon: 0.25 }, { lat: 1.5, lon: 1.75 })).toBe(true);
  });

  it('outside the mask is sea; a leg reaching in from outside is still walked', () => {
    // Land at the mask's north-east corner cell (4, 4): lat/lon [0.875, 1.125].
    const mask = maskOf(0, 0, 0.25, 5, 5, [[4, 4]]);
    expect(crosses(mask, { lat: 2, lon: 2 }, { lat: 3, lon: 1.5 })).toBe(false);
    expect(crosses(mask, { lat: -2, lon: 1 }, { lat: 2, lon: 1 })).toBe(true);
    expect(crosses(mask, { lat: 1, lon: -5 }, { lat: 1, lon: 5 })).toBe(true);
    // Beyond the cell's outer edge (1.125) the mask has no cells: sea, even right against it.
    expect(crosses(mask, { lat: 1.2, lon: -5 }, { lat: 1.2, lon: 5 })).toBe(false);
  });

  it('longitudes are not wrapped: a leg is taken straight between its raw longitudes', () => {
    // A global-width mask with land at lon 0. A leg from 179.9 to -179.9 runs, as the
    // sampler interpolated it, the long way through lon 0, not 0.2° across the antimeridian.
    // (The sampler spaced its 32 points by the 12 nm great-circle length, 11.6° of longitude
    // apart, and stepped over the land; the walk does not.)
    const mask = maskOf(-1, -180, 1, 3, 361, [[1, 180]]);
    expect(isLand(mask, 0, 0)).toBe(true);
    expect(crosses(mask, { lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 })).toBe(true);
    expect(crosses(mask, { lat: 0, lon: 179.9 }, { lat: 0, lon: 179.95 })).toBe(false);
  });

  it('fails closed on non-finite or out-of-range coordinates', () => {
    const sea = maskOf(0, 0, 0.25, 5, 5, []);
    const ok = { lat: 0.5, lon: 0.5 };
    for (const bad of [
      { lat: Number.NaN, lon: 0.5 }, { lat: 0.5, lon: Number.NaN },
      { lat: Number.POSITIVE_INFINITY, lon: 0.5 }, { lat: 0.5, lon: Number.NEGATIVE_INFINITY },
      { lat: 90.5, lon: 0.5 }, { lat: -91, lon: 0.5 }, { lat: 0.5, lon: 360.5 }, { lat: 0.5, lon: -1e300 },
    ]) {
      expect(crosses(sea, ok, bad), JSON.stringify(bad)).toBe(true);
      expect(segmentCrossesLand(sea, bad, bad), JSON.stringify(bad)).toBe(true);
    }
    expect(crosses(sea, ok, { lat: 0.75, lon: 0.25 })).toBe(false);
    expect(crosses(sea, { lat: 90, lon: -360 }, { lat: -90, lon: 360 })).toBe(false);
  });

  it('matches the brute-force reference and flags everything the 0.4 nm sampler flagged (random masks and legs)', () => {
    const rand = mulberry32(20261125);
    let flagged = 0;
    let missedBySampler = 0;
    for (let m = 0; m < 60; m++) {
      const d = [0.01, 0.02, 0.037, 0.05, 0.1][m % 5]!;
      const nlat = 8 + Math.floor(rand() * 20);
      const nlon = 8 + Math.floor(rand() * 20);
      const density = 0.05 + rand() * 0.4;
      const lat0 = -60 + rand() * 120;
      const lon0 = -170 + rand() * 340;
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) if (rand() < density) cells.push([i, j]);
      const mask = maskOf(lat0, lon0, d, nlat, nlon, cells);
      const point = (): P => ({
        lat: lat0 + (rand() * (nlat + 2) - 1.5) * d,
        lon: lon0 + (rand() * (nlon + 2) - 1.5) * d,
      });
      for (let k = 0; k < 150; k++) {
        const a = point();
        // Mostly router-sized legs (up to a few cells), some across the whole mask.
        const b = rand() < 0.8
          ? { lat: a.lat + (rand() - 0.5) * 4 * d * rand(), lon: a.lon + (rand() - 0.5) * 4 * d * rand() }
          : point();
        const walked = crosses(mask, a, b);
        expect(walked, JSON.stringify({ m, k, a, b })).toBe(referenceCrossesLand(mask, a, b));
        const sampled = sampledCrossesLand(mask, a, b);
        if (sampled) expect(walked, JSON.stringify({ m, k, a, b })).toBe(true);
        if (walked) flagged += 1;
        if (walked && !sampled) missedBySampler += 1;
      }
    }
    expect(flagged).toBeGreaterThan(1000);
    expect(missedBySampler).toBeGreaterThan(0);
  }, 60_000);

  it('flags everything the sampler flagged on legs between cell edges, corners and router-like rounded points', () => {
    // Endpoints on cell boundaries and corners, exact in binary on 0.25° cells (where the walk
    // must equal the reference), and four-decimal router coordinates on the production 0.05°
    // grid, where floating point decides which cell Math.round picks.
    const rand = mulberry32(7);
    const exact = maskOf(0, 0, 0.25, 12, 12, []);
    const production = maskOf(48, -5, 0.05, 12, 12, []);
    for (const mask of [exact, production]) {
      for (let m = 0; m < 20; m++) {
        mask.land = mask.land.map(() => (rand() < 0.3 ? 1 : 0));
        const snapped = (): P => {
          const half = (n: number) => (Math.floor(rand() * 2 * n) - 1) / 2; // whole or half cells
          return {
            lat: Math.round((mask.lat0 + half(mask.nlat) * mask.dlat) * 10000) / 10000,
            lon: Math.round((mask.lon0 + half(mask.nlon) * mask.dlon) * 10000) / 10000,
          };
        };
        for (let k = 0; k < 200; k++) {
          const a = snapped();
          const c = snapped();
          const pick = rand();
          const b = pick < 0.4 ? c : pick < 0.7 ? { lat: a.lat, lon: c.lon } : { lat: c.lat, lon: a.lon };
          const walked = crosses(mask, a, b);
          if (sampledCrossesLand(mask, a, b)) expect(walked, JSON.stringify({ a, b })).toBe(true);
          if (mask === exact) expect(walked, JSON.stringify({ a, b })).toBe(referenceCrossesLand(mask, a, b));
        }
      }
    }
  }, 60_000);
});
