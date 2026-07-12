import { isLand, type LandMask } from './landmask.js';

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

/** Materialise only the packed global-mask cells required by a route. */
export function windowLandMask(
  packed: Uint8Array,
  metadata: PackedLandMaskMetadata,
  bbox: GeoBbox,
): LandMask {
  assertBbox(bbox);
  const i0 = Math.max(0, Math.floor((bbox.minLat - metadata.lat0) / metadata.dlat));
  const i1 = Math.min(metadata.nlat - 1, Math.ceil((bbox.maxLat - metadata.lat0) / metadata.dlat));
  const j0 = Math.max(0, Math.floor((bbox.minLon - metadata.lon0) / metadata.dlon));
  const j1 = Math.min(metadata.nlon - 1, Math.ceil((bbox.maxLon - metadata.lon0) / metadata.dlon));
  if (i1 < i0 || j1 < j0) throw new Error('Route is outside the coastline mask');

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

/** Find the nearest sea raster cell around a possibly dilated harbour point. */
export function snapToSea(
  mask: LandMask,
  point: { lat: number; lon: number },
  maxCells = 12,
): { lat: number; lon: number } | null {
  if (!isLand(mask, point.lat, point.lon)) return { lat: point.lat, lon: point.lon };
  const ci = Math.round((point.lat - mask.lat0) / mask.dlat);
  const cj = Math.round((point.lon - mask.lon0) / mask.dlon);
  let best: { i: number; j: number; d2: number } | null = null;
  for (let r = 0; r <= maxCells; r++) {
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        if (r > 0 && Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= mask.nlat || j < 0 || j >= mask.nlon) continue;
        if (mask.land[i * mask.nlon + j] === 1) continue;
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
