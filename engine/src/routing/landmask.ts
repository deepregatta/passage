/** Land mask (published by the Python factory from global-land-mask GLOBE data). */

import { haversineNm, interpolatePosition } from '../geo.js';

export interface LandMask {
  schema_version: number;
  kind: 'land_mask';
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  /** 1 = land, 0 = sea; index i*nlon + j */
  land: number[];
}

export function isLand(mask: LandMask, lat: number, lon: number): boolean {
  const i = Math.round((lat - mask.lat0) / mask.dlat);
  const j = Math.round((lon - mask.lon0) / mask.dlon);
  if (i < 0 || i >= mask.nlat || j < 0 || j >= mask.nlon) return false; // outside mask: assume sea
  return mask.land[i * mask.nlon + j] === 1;
}

/** samples every ~0.4 nm along the segment */
export function segmentCrossesLand(
  mask: LandMask,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
  const steps = Math.max(2, Math.ceil(dist / 0.4));
  for (let k = 0; k <= steps; k++) {
    const p = interpolatePosition(a, b, k / steps);
    if (isLand(mask, p.lat, p.lon)) return true;
  }
  return false;
}
