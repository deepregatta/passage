import { isLand, landAtOf, type LandMask, type RoutingLandMask } from './landmask.js';

export interface PackedLandMaskMetadata {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  bit_order?: 'lsb';
}

export interface GeoBbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function assertBbox(bbox: GeoBbox): void {
  if (bbox.minLon > bbox.maxLon || bbox.maxLon - bbox.minLon > 180) {
    throw new Error('Antimeridian-crossing routes are not supported yet');
  }
}

/** The rows i0..i1 and columns j0..j1 of the packed global mask a route's window holds. */
export function windowCells(metadata: PackedLandMaskMetadata, bbox: GeoBbox): { i0: number; i1: number; j0: number; j1: number } {
  assertBbox(bbox);
  const i0 = Math.max(0, Math.floor((bbox.minLat - metadata.lat0) / metadata.dlat));
  const i1 = Math.min(metadata.nlat - 1, Math.ceil((bbox.maxLat - metadata.lat0) / metadata.dlat));
  const j0 = Math.max(0, Math.floor((bbox.minLon - metadata.lon0) / metadata.dlon));
  const j1 = Math.min(metadata.nlon - 1, Math.ceil((bbox.maxLon - metadata.lon0) / metadata.dlon));
  if (i1 < i0 || j1 < j0) throw new Error('Route is outside the coastline mask');
  return { i0, i1, j0, j1 };
}

/** Materialise only the packed global-mask cells required by a route. */
export function windowLandMask(
  packed: Uint8Array,
  metadata: PackedLandMaskMetadata,
  bbox: GeoBbox,
): LandMask {
  const { i0, i1, j0, j1 } = windowCells(metadata, bbox);

  const nlat = i1 - i0 + 1;
  const nlon = j1 - j0 + 1;
  const land = new Array<number>(nlat * nlon);
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const sourceBit = (i0 + i) * metadata.nlon + j0 + j;
      land[i * nlon + j] = (packed[sourceBit >> 3]! >> (sourceBit & 7)) & 1;
    }
  }
  return {
    schema_version: 1,
    kind: 'land_mask',
    lat0: metadata.lat0 + i0 * metadata.dlat,
    lon0: metadata.lon0 + j0 * metadata.dlon,
    dlat: metadata.dlat,
    dlon: metadata.dlon,
    nlat,
    nlon,
    land,
  };
}

/**
 * How far snapToSea looks for water, in degrees: twelve cells of the 0.05° outline, the reach
 * it has always had there. A mask with coarser cells keeps twelve cells.
 */
export const SNAP_REACH_DEG = 0.6;

/**
 * Find the nearest sea raster cell around a possibly dilated harbour point: the first square
 * ring of cells around it holding sea, and in it the sea cell nearest in cells, out to
 * `maxCells` rings (by default SNAP_REACH_DEG, and never fewer than twelve cells).
 */
export function snapToSea(
  mask: RoutingLandMask,
  point: { lat: number; lon: number },
  maxCells = Math.max(12, Math.round(SNAP_REACH_DEG / Math.min(mask.dlat, mask.dlon))),
): { lat: number; lon: number } | null {
  if (!isLand(mask, point.lat, point.lon)) return { lat: point.lat, lon: point.lon };
  const landAt = landAtOf(mask);
  const ci = Math.round((point.lat - mask.lat0) / mask.dlat);
  const cj = Math.round((point.lon - mask.lon0) / mask.dlon);
  let best: { i: number; j: number; d2: number } | null = null;
  for (let r = 0; r <= maxCells; r++) {
    for (let di = -r; di <= r; di++) {
      // Only the ring's own cells, in row order: the whole first and last rows, the two ends of the others.
      const edgeRow = di === -r || di === r;
      for (let dj = -r; dj <= r; dj += edgeRow || r === 0 ? 1 : 2 * r) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= mask.nlat || j < 0 || j >= mask.nlon) continue;
        if (landAt(i, j)) continue;
        const d2 = di * di + dj * dj;
        if (!best || d2 < best.d2) best = { i, j, d2 };
      }
    }
    if (best) {
      const found = best as { i: number; j: number; d2: number };
      return {
        lat: mask.lat0 + found.i * mask.dlat,
        lon: mask.lon0 + found.j * mask.dlon,
      };
    }
  }
  return null;
}

/**
 * On the fine routing index, the most sea cells (joined edge to edge) a closed pocket of water
 * may hold for snapEndsToSea to move an end out of it: about 70 km² at 50°N. Measured on the
 * nweu tiles (2026-11-26): the harbour pockets the 0.05° outline routes from hold 1 to 231
 * cells (Cherbourg's Grande Rade one, Cork Harbour 231); the IJsselmeer, closed by its dams,
 * holds about 31,000 and stays closed water.
 */
export const SNAP_POCKET_CELLS = 2000;

/**
 * Both ends of a passage, each on the sea cell the router starts from: snapToSea's nearest sea
 * cell, and on the fine routing index (a LandCellMask) never in a closed pocket of sea that
 * does not hold the other end. There a harbour, a dock or a drying creek is often a pocket of
 * a few cells that no route can leave; such an end moves to the nearest sea cell, within the
 * snap's reach, whose water is larger than SNAP_POCKET_CELLS, runs to the edge of the window,
 * or holds the other end. With none in reach it stays, and the router says the water is closed.
 * On the 0.05° outline this is snapToSea for each end, unchanged.
 */
export function snapEndsToSea(
  mask: RoutingLandMask,
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number },
): { start: { lat: number; lon: number } | null; finish: { lat: number; lon: number } | null } {
  const a = snapToSea(mask, start);
  const b = snapToSea(mask, finish);
  if (mask.kind !== 'land_cells' || !a || !b) return { start: a, finish: b };
  const from = outOfPocket(mask, start, a, b);
  return { start: from, finish: outOfPocket(mask, finish, b, from) };
}

/** `snapped`, or the nearest sea cell to `point` outside a closed pocket that lacks `other` (see snapEndsToSea). */
function outOfPocket(
  mask: RoutingLandMask,
  point: { lat: number; lon: number },
  snapped: { lat: number; lon: number },
  other: { lat: number; lon: number },
): { lat: number; lon: number } {
  const landAt = landAtOf(mask);
  const { nlat, nlon } = mask;
  const cellOf = (p: { lat: number; lon: number }) =>
    [Math.round((p.lat - mask.lat0) / mask.dlat), Math.round((p.lon - mask.lon0) / mask.dlon)] as const;
  const [oi, oj] = cellOf(other);
  const goal = oi * nlon + oj;
  /** The cells of the closed pocket holding sea cell (i, j), or null when its water is open. */
  const pocket = (i: number, j: number): Set<number> | null => {
    const start = i * nlon + j;
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const cell = stack.pop()!;
      if (cell === goal) return null;
      const ci = Math.floor(cell / nlon);
      const cj = cell % nlon;
      if (ci === 0 || ci === nlat - 1 || cj === 0 || cj === nlon - 1) return null;
      for (const [ni, nj] of [[ci - 1, cj], [ci + 1, cj], [ci, cj - 1], [ci, cj + 1]] as const) {
        const next = ni * nlon + nj;
        if (seen.has(next) || landAt(ni, nj)) continue;
        if (seen.size >= SNAP_POCKET_CELLS) return null;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  const [si, sj] = cellOf(snapped);
  if (si < 0 || si >= nlat || sj < 0 || sj >= nlon) return snapped;
  const first = pocket(si, sj);
  if (!first) return snapped;
  const closed = first;
  const [ci, cj] = cellOf(point);
  const maxCells = Math.max(12, Math.round(SNAP_REACH_DEG / Math.min(mask.dlat, mask.dlon)));
  for (let r = 0; r <= maxCells; r++) {
    // The ring's sea cells outside known pockets, nearest first.
    const ring: Array<{ i: number; j: number; d2: number }> = [];
    for (let di = -r; di <= r; di++) {
      const edgeRow = di === -r || di === r;
      for (let dj = -r; dj <= r; dj += edgeRow || r === 0 ? 1 : 2 * r) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= nlat || j < 0 || j >= nlon || closed.has(i * nlon + j) || landAt(i, j)) continue;
        ring.push({ i, j, d2: di * di + dj * dj });
      }
    }
    ring.sort((x, y) => x.d2 - y.d2);
    for (const { i, j } of ring) {
      if (closed.has(i * nlon + j)) continue;
      const cells = pocket(i, j);
      if (!cells) return { lat: mask.lat0 + i * mask.dlat, lon: mask.lon0 + j * mask.dlon };
      for (const cell of cells) closed.add(cell);
    }
  }
  return snapped;
}
