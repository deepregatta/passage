/**
 * The store's own geometry, shared by the store's reads and by the download
 * quote (tileRequests.ts), so the two cannot drift: the layers its reads are
 * made of, where a tile lives and what it is cached under, and the lattice a
 * region grid is mosaicked on. Pure; depends on nothing but types.
 */

import type { RunManifest } from './store.js';
import type { Bbox } from './tileMath.js';

/** The layers the store's reads are made of. */
export const WEATHER_LAYER = 'weather';
export const ENSEMBLE_LAYER = 'ensemble';
export const WAVES_LAYER = 'waves';
export const CURRENTS_LAYER = 'currents';

/** Point budget of a region grid: the lattice is strided down to fit it. */
export const MOSAIC_TARGET_POINTS = 4000;

/** Where a tile of a run is fetched from. */
export function tilePath(manifest: RunManifest, tileId: string): string {
  return manifest.tiling.path_template.replace('{tile_id}', tileId);
}

/** The key a tile has in a TileCache; the store and the quote must agree on it. */
export function tileCacheKey(manifest: RunManifest, tileId: string): string {
  return `${manifest.run_id}/${tilePath(manifest, tileId)}`;
}

/** Compressed bytes of a published tile, or null when the manifest does not list it. */
export function publishedTileBytes(manifest: RunManifest, tileId: string): number | null {
  const tile = manifest.tiles[tileId];
  return tile ? tile.bytes : null;
}

export interface MosaicLattice {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  /** native steps per lattice step; above 1 the area exceeded the point budget */
  stride: number;
}

/**
 * The lattice a region grid is mosaicked on: the layer's native lattice
 * covering the bbox (snapped to the served grid), strided down while it would
 * exceed `targetPoints`.
 */
export function mosaicLattice(
  manifest: Pick<RunManifest, 'resolution_deg' | 'served_grid'>,
  bbox: Bbox,
  targetPoints = MOSAIC_TARGET_POINTS,
): MosaicLattice {
  const res = manifest.resolution_deg;
  const native = manifest.served_grid;
  const snap = (x: number, origin = 0) => origin + Math.round((x - origin) / res) * res;
  let stride = 1;
  const rawNlat = Math.floor((bbox.maxLat - bbox.minLat) / res) + 1;
  const rawNlon = Math.floor((bbox.maxLon - bbox.minLon) / res) + 1;
  while ((Math.ceil(rawNlat / stride) + 1) * (Math.ceil(rawNlon / stride) + 1) > targetPoints) {
    stride += 1;
  }
  const dlat = res * stride;
  const dlon = res * stride;
  const lat0 = snap(bbox.minLat, native?.lat0);
  const lon0 = snap(bbox.minLon, native?.lon0);
  const nlat = Math.max(2, Math.floor((bbox.maxLat - lat0) / dlat) + 1);
  const nlon = Math.max(2, Math.floor((bbox.maxLon - lon0) / dlon) + 1);
  return { lat0, lon0, dlat, dlon, nlat, nlon, stride };
}

/** The lattice points, row by row (south to north, west to east in each row). */
export function* mosaicPoints(
  lattice: MosaicLattice,
): Generator<{ i: number; j: number; lat: number; lon: number }> {
  const { lat0, lon0, dlat, dlon, nlat, nlon } = lattice;
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) yield { i, j, lat: lat0 + i * dlat, lon: lon0 + j * dlon };
  }
}

