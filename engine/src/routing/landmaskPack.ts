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
