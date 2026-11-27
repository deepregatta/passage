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
  // A whole-globe outline's last column is centred one cell short of 180°: the cell centred at 180°
  // is its first column again, read as one more column so that a window reaching 180° holds it.
  const lastColumn = wrapsRound(metadata) ? metadata.nlon : metadata.nlon - 1;
  const j1 = Math.min(lastColumn, Math.ceil((bbox.maxLon - metadata.lon0) / metadata.dlon));
  if (i1 < i0 || j1 < j0) throw new Error('Route is outside the coastline mask');
  return { i0, i1, j0, j1 };
}

/** Whether the outline's columns go once round the globe from 180°W, so its column `nlon` is column 0. */
function wrapsRound(metadata: PackedLandMaskMetadata): boolean {
  return Math.abs(metadata.nlon * metadata.dlon - 360) < 1e-6 && Math.abs(metadata.lon0 + 180) < 1e-6;
}

/** The outline's source column for window column `j` of windowCells (column `nlon` is column 0). */
export function outlineColumn(metadata: PackedLandMaskMetadata, j: number): number {
  return j % metadata.nlon;
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
      const sourceBit = (i0 + i) * metadata.nlon + outlineColumn(metadata, j0 + j);
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
 * cell, and on the fine routing index (a LandCellMask) never in a closed pocket of sea, unless
 * the other end lies in the same pocket (then both stay). There a harbour, a dock or a drying
 * creek is often a pocket of a few cells that no route can leave; such an end moves to the
 * nearest sea cell, within the snap's reach, whose water is open: larger than
 * SNAP_POCKET_CELLS or running to the edge of the window. Two ends in two different pockets
 * both move out to open water; neither moves into the other's pocket.
 *
 * An end that moves (it was on land or in a pocket) moves to a cell with room round it: all
 * eight neighbours sea. A one-cell slot of sea can be the nearest open water, and a route
 * cannot beat out of it into the wind. With no such cell in reach it takes the nearest open
 * cell; with none of those it stays where snapToSea put it, and the router says the water is
 * closed. An end the sailor put on open sea stays where it is.
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
  const water = openWater(mask);
  const pa = water.pocketOf(a);
  // Both ends in one closed pocket: a passage inside it, left as asked.
  if (pa && pa.has(water.cellOf(b))) return { start: a, finish: b };
  return { start: water.settle(start, a, pa), finish: water.settle(finish, b, water.pocketOf(b)) };
}

/** snapEndsToSea's reading of a fine window: closed pockets, open water and room round a cell. */
function openWater(mask: RoutingLandMask) {
  const landAt = landAtOf(mask);
  const { nlat, nlon } = mask;
  const index = (p: { lat: number; lon: number }) =>
    [Math.round((p.lat - mask.lat0) / mask.dlat), Math.round((p.lon - mask.lon0) / mask.dlon)] as const;
  const cellOf = (p: { lat: number; lon: number }) => { const [i, j] = index(p); return i * nlon + j; };
  /** The cells of the closed pocket holding sea cell (i, j), or null when its water is open. */
  const pocket = (i: number, j: number): Set<number> | null => {
    const first = i * nlon + j;
    const seen = new Set<number>([first]);
    const stack = [first];
    while (stack.length > 0) {
      const cell = stack.pop()!;
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
  /** Whether the eight cells round in-window cell (i, j) are all sea in the window. */
  const roomy = (i: number, j: number) => {
    if (i < 1 || i > nlat - 2 || j < 1 || j > nlon - 2) return false;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (landAt(i + di, j + dj)) return false;
    return true;
  };
  const inside = (i: number, j: number) => i >= 0 && i < nlat && j >= 0 && j < nlon;
  const pocketOf = (p: { lat: number; lon: number }) => { const [i, j] = index(p); return inside(i, j) ? pocket(i, j) : null; };
  /** The nearest open sea cell to `point` (with room when `needRoom`), outside the known pockets in `closed`. */
  const nearestOpen = (point: { lat: number; lon: number }, closed: Set<number>, needRoom: boolean) => {
    const [ci, cj] = index(point);
    const maxCells = Math.max(12, Math.round(SNAP_REACH_DEG / Math.min(mask.dlat, mask.dlon)));
    for (let r = 0; r <= maxCells; r++) {
      // The ring's sea cells outside known pockets, nearest first.
      const ring: Array<{ i: number; j: number; d2: number }> = [];
      for (let di = -r; di <= r; di++) {
        const edgeRow = di === -r || di === r;
        for (let dj = -r; dj <= r; dj += edgeRow || r === 0 ? 1 : 2 * r) {
          const i = ci + di;
          const j = cj + dj;
          if (!inside(i, j) || closed.has(i * nlon + j) || landAt(i, j) || (needRoom && !roomy(i, j))) continue;
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
    return null;
  };
  /** Where the end asked at `point`, snapped to `snapped` (in closed pocket `own`, or null), settles. */
  const settle = (point: { lat: number; lon: number }, snapped: { lat: number; lon: number }, own: Set<number> | null) => {
    const [si, sj] = index(snapped);
    if (!inside(si, sj)) return snapped;
    const moved = snapped.lat !== point.lat || snapped.lon !== point.lon;
    if (!own && (!moved || roomy(si, sj))) return snapped;
    const closed = new Set(own ?? []);
    return nearestOpen(point, closed, true) ?? (own ? nearestOpen(point, closed, false) : snapped) ?? snapped;
  };
  return { cellOf, pocketOf, settle };
}
