/**
 * What an action reads from the tile store, as data, and what that costs to
 * download. Built from the store's own geometry (storeGeometry.ts: layer names,
 * cache keys, the mosaic lattice), the tiles a point read can open (tileMath.ts)
 * and the choice between ECMWF layers (modelRuns.ts). Pure and DOM-free; nothing
 * here reads a tile. `docs/capabilities.md` records what is and is not verified.
 */

import { ECMWF_LAYERS, ecmwfLayersRead } from './modelRuns.js';
import type { RunManifest } from './store.js';
import {
  CURRENTS_LAYER, ENSEMBLE_LAYER, WAVES_LAYER, WEATHER_LAYER, mosaicLattice, mosaicPoints, publishedTileBytes, tileCacheKey,
} from './storeGeometry.js';
import { pointTileIds, tilesForBbox, type Bbox } from './tileMath.js';

export type ManifestLookup = (layer: string) => RunManifest | null | undefined;

/** A place a read happens at. */
export interface TilePoint {
  lat: number;
  lon: number;
}

/**
 * One read of one layer: a region grid over `bbox` (getWindGrid, getCurrentGrid),
 * a set of sample `points` (the point forecasts), or reads at points not yet
 * known somewhere inside `area` (every tile the box touches, one cell wider).
 */
export type TileRequest =
  | { layer: string; bbox: Bbox }
  | { layer: string; points: readonly TilePoint[] }
  | { layer: string; area: Bbox };

/** The layers an action can read; one the catalogue does not name is skipped by the store. */
export type ListedLayers = readonly string[];

export interface PlannedTile {
  layer: string;
  tileId: string;
  bytes: number;
  key: string;
}

export interface TilePlan {
  /** distinct (layer, tile) pairs, in first-requested order */
  tiles: PlannedTile[];
  /** requested layers the catalogue lists but no manifest was loaded for: not quotable */
  missingLayers: string[];
}

/**
 * How far past an `area` a read can open a tile. A computed scan routes every
 * candidate inside the routing lattice, which `mosaicLattice` snaps with
 * `Math.round`: its first row can lie up to half a routing cell (0.125° on the
 * 0.25° wind layer; 0.25° if that layer were 0.5°) outside the box. The leg
 * midpoints are then snapped to the 0.25° audit cell (up to 0.125° more). From
 * its point a read reaches the neighbour across a 10° line within one cell of
 * the audited layer (`resolution_deg`, 0.5° at most today). So the margin is
 * the layer's cell plus 0.25° + 0.125°, rounded up generously to
 * `AREA_SNAP_MARGIN_DEG`.
 */
export const AREA_SNAP_MARGIN_DEG = 0.375;

function expand(area: Bbox, resolutionDeg: number): Bbox {
  const deg = resolutionDeg + AREA_SNAP_MARGIN_DEG;
  return { minLat: area.minLat - deg, maxLat: area.maxLat + deg, minLon: area.minLon - deg, maxLon: area.maxLon + deg };
}

function requestTileIds(manifest: RunManifest, request: TileRequest): string[] {
  if ('points' in request) return request.points.flatMap((p) => pointTileIds(manifest, p.lat, p.lon));
  if ('bbox' in request) {
    const ids: string[] = [];
    for (const p of mosaicPoints(mosaicLattice(manifest, request.bbox))) ids.push(...pointTileIds(manifest, p.lat, p.lon));
    return ids;
  }
  return tilesForBbox(expand(request.area, manifest.resolution_deg), manifest.tiling.tile_deg)
    .filter((id) => manifest.tiles[id]);
}

/**
 * The tiles a list of reads opens, each (layer, tile) once however many reads
 * ask for it. A tile the manifest does not publish adds nothing (the action
 * itself reports missing data). A layer with no loaded manifest is skipped:
 * when the catalogue (`listed`) names it, it is reported in `missingLayers`;
 * when `listed` is given and does not name it, the store would not read it and
 * it is dropped silently.
 */
export function planTileRequests(
  requests: readonly TileRequest[],
  manifests: ManifestLookup,
  options: { listed?: ListedLayers } = {},
): TilePlan {
  const tiles = new Map<string, PlannedTile>();
  const missing = new Set<string>();
  for (const request of requests) {
    const manifest = manifests(request.layer);
    if (!manifest) {
      if (!options.listed || options.listed.includes(request.layer)) missing.add(request.layer);
      continue;
    }
    for (const tileId of requestTileIds(manifest, request)) {
      const bytes = publishedTileBytes(manifest, tileId);
      const id = `${request.layer}\u0000${tileId}`;
      if (bytes === null || tiles.has(id)) continue;
      tiles.set(id, { layer: request.layer, tileId, bytes, key: tileCacheKey(manifest, tileId) });
    }
  }
  return { tiles: [...tiles.values()], missingLayers: [...missing] };
}

export interface TileQuoteLayer {
  layer: string;
  tiles: number;
  bytes: number;
  cachedTiles: number;
  cachedBytes: number;
}

export interface TileQuote {
  layers: TileQuoteLayer[];
  /** the published tiles the reads open, and their compressed bytes */
  tiles: number;
  bytes: number;
  /** of those, the ones the cache already holds */
  cachedTiles: number;
  cachedBytes: number;
  /** the rest: what is left to fetch */
  downloadTiles: number;
  downloadBytes: number;
  /** a requested layer could not be quoted, so the real download can be larger */
  lowerBound: boolean;
  missingLayers: string[];
}

/**
 * What a list of reads would download: compressed bytes and tile counts per
 * layer and in all, less the tiles `isCached` says are already on the device
 * (the store's `hasTile`). Without it, or when it fails for a tile, nothing is
 * subtracted. Never reads a tile.
 */
export async function quoteTileDownload(
  requests: readonly TileRequest[],
  manifests: ManifestLookup,
  options: { isCached?: ((tile: PlannedTile) => boolean | Promise<boolean>) | null; listed?: ListedLayers } = {},
): Promise<TileQuote> {
  const plan = planTileRequests(requests, manifests, options.listed ? { listed: options.listed } : {});
  const isCached = options.isCached;
  const cached = await Promise.all(plan.tiles.map(async (tile) => {
    if (!isCached) return false;
    try {
      return (await isCached(tile)) === true;
    } catch {
      return false;
    }
  }));
  const byLayer = new Map<string, TileQuoteLayer>();
  plan.tiles.forEach((tile, i) => {
    const entry = byLayer.get(tile.layer) ?? { layer: tile.layer, tiles: 0, bytes: 0, cachedTiles: 0, cachedBytes: 0 };
    entry.tiles += 1;
    entry.bytes += tile.bytes;
    if (cached[i]) {
      entry.cachedTiles += 1;
      entry.cachedBytes += tile.bytes;
    }
    byLayer.set(tile.layer, entry);
  });
  const layers = [...byLayer.values()];
  const sum = (pick: (layer: TileQuoteLayer) => number) => layers.reduce((total, layer) => total + pick(layer), 0);
  const tiles = sum((l) => l.tiles);
  const bytes = sum((l) => l.bytes);
  const cachedTiles = sum((l) => l.cachedTiles);
  const cachedBytes = sum((l) => l.cachedBytes);
  return {
    layers, tiles, bytes, cachedTiles, cachedBytes,
    downloadTiles: tiles - cachedTiles,
    downloadBytes: bytes - cachedBytes,
    lowerBound: plan.missingLayers.length > 0,
    missingLayers: plan.missingLayers,
  };
}

/** Compute: the wind and current grids over the route box (what loadRoutingInputs asks the store for). */
export function routingTileRequests(bbox: Bbox): TileRequest[] {
  return [{ layer: WEATHER_LAYER, bbox }, { layer: CURRENTS_LAYER, bbox }];
}

export interface AuditTileReads {
  /** where the audit samples: the leg points, or, when they are not known yet, the area they fall in */
  where: { points: readonly TilePoint[] } | { area: Bbox };
  /** the analysis window, which selects among the ECMWF layers; without it every one is counted */
  window?: { startMs: number; endMs: number };
  /** the store's configured regional models, in its order */
  regionalLayers?: readonly string[];
  /** the box of the currents the audit reads itself; absent when it is handed a current input */
  currents?: Bbox | null;
}

/** Whether the request overlaps the regional layer's coverage, the one thing the store needs to read it. */
function regionalOverlaps(manifest: RunManifest, where: AuditTileReads['where']): boolean {
  const c = manifest.coverage;
  if (!c) return false;
  if ('area' in where) {
    const a = where.area;
    return a.minLat <= c.maxLat && a.maxLat >= c.minLat && a.minLon <= c.maxLon && a.maxLon >= c.minLon;
  }
  return where.points.some((p) => p.lat >= c.minLat && p.lat <= c.maxLat && p.lon >= c.minLon && p.lon <= c.maxLon);
}

/**
 * Check, and each candidate of a scan: the point forecasts (`weather`,
 * `ensemble`, `waves`), the hazard series (`weather` again, the ECMWF layers
 * the window picks, every regional model that overlaps the request) and,
 * when the audit reads them itself, the current tiles. Mirrors `runAnalysis`
 * and `TileForecastStore.getHazardForecasts`; the drift tests hold the two
 * together.
 */
export function auditTileRequests(manifests: ManifestLookup, reads: AuditTileReads): TileRequest[] {
  const { where, window } = reads;
  const requests: TileRequest[] = [WEATHER_LAYER, ENSEMBLE_LAYER, WAVES_LAYER].map((layer) => ({ layer, ...where }));

  const loaded = ECMWF_LAYERS.flatMap((layer) => manifests(layer) ?? []);
  const ecmwf = window ? ecmwfLayersRead(loaded, window.startMs, window.endMs) : [...ECMWF_LAYERS];
  for (const layer of ECMWF_LAYERS) {
    if (!manifests(layer) || ecmwf.includes(layer)) requests.push({ layer, ...where });
  }

  // Every enabled regional model whose coverage overlaps the request. The store may still skip one (its
  // transfer budget, decoded-memory limits that depend on live state, the period, a point outside coverage),
  // and the budget is per candidate for a scan: copying that here could drop a layer the store reads.
  for (const layer of reads.regionalLayers ?? []) {
    const manifest = manifests(layer);
    if (!manifest || regionalOverlaps(manifest, where)) requests.push({ layer, ...where });
  }

  if (reads.currents) requests.push({ layer: CURRENTS_LAYER, bbox: reads.currents });
  return requests;
}
