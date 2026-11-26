/**
 * The router's land mask over a route's window: the fine routing index (TLI1, 1/480° cells:
 * land, drying areas and a 200 m outward buffer) wherever the index has a tile, and the 0.05°
 * coastline outline everywhere else. Where no fine tile is, the outline's cell answers, never
 * "sea": TLI1 says nothing outside its tiles, and nothing here reads that silence as water.
 *
 * The window is the outline window windowLandMask gives for the same box, cut into the fine
 * lattice: each 0.05° outline cell, centred on a multiple of 0.05° and so edged on multiples
 * of 1/480°, is exactly 24 × 24 fine cells. Cells are read in place from the decoded tiles
 * and the packed outline (no copy), so a window over a long passage costs no memory.
 * A window no fine tile reaches is the outline window itself, unchanged.
 */

import { landIndexTileCorner, TLI1_CELLS_PER_DEG, type LandIndexManifest, type LandIndexTile } from './landIndex.js';
import type { LandCellMask, RoutingLandMask } from './landmask.js';
import { windowCells, windowLandMask, type GeoBbox, type PackedLandMaskMetadata } from './landmaskPack.js';

/** The packed global 0.05° outline, as published in viewer/public/data/land/global-005.*. */
export interface CoarseLandOutline {
  bytes: Uint8Array;
  metadata: PackedLandMaskMetadata;
}

/** One routing-index version: its manifest and its decoded tiles, by tile id. */
export interface FineLandIndex {
  manifest: LandIndexManifest;
  tiles: Record<string, LandIndexTile | undefined>;
}

/** The tile id whose south-west corner is (lat, lon), e.g. N50W010. */
export function landIndexTileId(lat: number, lon: number): string {
  return `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}` +
    `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
}

/** `value` as a whole number when it is one to within rounding error, else NaN. */
const whole = (value: number) => (Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : Number.NaN);

/**
 * The land mask the router reads for `bbox`: the 0.05° outline window when `fine` is null or
 * reaches no part of it, otherwise a LandCellMask on the 1/480° lattice. Throws when a tile the
 * index lists for the window is missing or is not that index's tile, so a caller never routes
 * on a window with a hole in it.
 */
export function routingLandMask(coarse: CoarseLandOutline, fine: FineLandIndex | null, bbox: GeoBbox): RoutingLandMask {
  const { bytes, metadata } = coarse;
  if (!fine) return windowLandMask(bytes, metadata, bbox);
  const { manifest } = fine;
  const { i0, i1, j0, j1 } = windowCells(metadata, bbox);
  const per = TLI1_CELLS_PER_DEG;
  // The outline's cell size and its south and west cell edges, in fine cells.
  const latRatio = whole(metadata.dlat * per);
  const lonRatio = whole(metadata.dlon * per);
  const latEdge = whole((metadata.lat0 - metadata.dlat / 2) * per);
  const lonEdge = whole((metadata.lon0 - metadata.dlon / 2) * per);
  if (![latRatio, lonRatio, latEdge, lonEdge].every(Number.isFinite)) {
    throw new Error('The coastline outline cells do not fall on the routing-index lattice');
  }
  const k0 = latEdge + i0 * latRatio;
  const c0 = lonEdge + j0 * lonRatio;
  const nlat = (i1 - i0 + 1) * latRatio;
  const nlon = (j1 - j0 + 1) * lonRatio;

  const tileDeg = manifest.grid.tile_deg;
  const tileCells = whole(tileDeg * per);
  if (!Number.isFinite(tileCells) || tileCells < 1) throw new Error(`routing index ${manifest.index_id} has a tile size this version of Passage does not read`);
  const ty0 = Math.floor(k0 / tileCells);
  const ty1 = Math.floor((k0 + nlat - 1) / tileCells);
  const tx0 = Math.floor(c0 / tileCells);
  const tx1 = Math.floor((c0 + nlon - 1) / tileCells);
  const ntx = tx1 - tx0 + 1;
  const listed = new Set(manifest.coverage.tiles);
  const grid: Array<{ bits: Uint8Array; rowBytes: number } | null> = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const id = landIndexTileId(ty * tileDeg, tx * tileDeg);
      if (!listed.has(id)) {
        grid.push(null);
        continue;
      }
      const tile = fine.tiles[id];
      const header = tile?.header;
      if (!tile || !header) throw new Error(`Routing-index tile ${id} of ${manifest.index_id} is missing`);
      const corner = landIndexTileCorner(id);
      if (header.tile_id !== id || header.lat0 !== corner.lat || header.lon0 !== corner.lon ||
        header.nlat !== tileCells || header.nlon !== tileCells) {
        throw new Error(`Routing-index tile ${id} of ${manifest.index_id} is not that tile`);
      }
      if (header.index_id !== manifest.index_id) {
        throw new Error(`Routing-index tile ${id} belongs to index ${header.index_id}, not ${manifest.index_id}`);
      }
      grid.push({ bits: tile.bits, rowBytes: header.row_bytes });
    }
  }
  if (grid.every((tile) => tile === null)) return windowLandMask(bytes, metadata, bbox);

  // Per window row and column: which tile, where in it, and which outline row (bit offset) or column.
  const rowTile = new Int32Array(nlat);
  const rowInTile = new Int32Array(nlat);
  const outlineRowBit = new Float64Array(nlat);
  for (let i = 0; i < nlat; i++) {
    const k = k0 + i;
    const ty = Math.floor(k / tileCells);
    rowTile[i] = (ty - ty0) * ntx;
    rowInTile[i] = k - ty * tileCells;
    outlineRowBit[i] = (i0 + Math.floor(i / latRatio)) * metadata.nlon;
  }
  const colTile = new Int32Array(nlon);
  const colInTile = new Int32Array(nlon);
  const outlineCol = new Int32Array(nlon);
  for (let j = 0; j < nlon; j++) {
    const c = c0 + j;
    const tx = Math.floor(c / tileCells);
    colTile[j] = tx - tx0;
    colInTile[j] = c - tx * tileCells;
    outlineCol[j] = j0 + Math.floor(j / lonRatio);
  }
  // Whether any cell of an 8 x 8 block is land: worked out the first time the land check asks
  // (0 not yet, 1 sea only, 2 some land), so a window over a long passage is never scanned whole.
  const BLOCK = 8;
  const bcols = Math.ceil(nlon / BLOCK);
  const blockState = new Uint8Array(Math.ceil(nlat / BLOCK) * bcols);
  const mask: LandCellMask = {
    kind: 'land_cells',
    lat0: (k0 + 0.5) / per,
    lon0: (c0 + 0.5) / per,
    dlat: 1 / per,
    dlon: 1 / per,
    nlat,
    nlon,
    fine_index_id: manifest.index_id,
    fineAt(i: number, j: number): boolean {
      return grid[rowTile[i]! + colTile[j]!] !== null;
    },
    blocks: {
      size: BLOCK,
      anyLandAt(bi: number, bj: number): boolean {
        const k = bi * bcols + bj;
        if (blockState[k] === 0) {
          let land = false;
          for (let i = bi * BLOCK; i < Math.min(nlat, (bi + 1) * BLOCK) && !land; i++) {
            for (let j = bj * BLOCK; j < Math.min(nlon, (bj + 1) * BLOCK) && !land; j++) land = mask.landAt(i, j);
          }
          blockState[k] = land ? 2 : 1;
        }
        return blockState[k] === 2;
      },
    },
    landAt(i: number, j: number): boolean {
      const tile = grid[rowTile[i]! + colTile[j]!];
      if (tile) {
        const col = colInTile[j]!;
        return ((tile.bits[rowInTile[i]! * tile.rowBytes + (col >> 3)]! >> (col & 7)) & 1) === 1;
      }
      const bit = outlineRowBit[i]! + outlineCol[j]!;
      return ((bytes[Math.floor(bit / 8)]! >> (bit % 8)) & 1) === 1;
    },
  };
  return mask;
}
