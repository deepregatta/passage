import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { haversineNm } from '../src/geo.js';
import { decodeLandIndexTile, parseLandIndexManifest, type LandIndexTile } from '../src/routing/landIndex.js';
import {
  isLand, seaJoinsPoints, segmentCrossesLand, type LandCellMask, type LandMask,
} from '../src/routing/landmask.js';
import { snapToSea, windowLandMask, type GeoBbox, type PackedLandMaskMetadata } from '../src/routing/landmaskPack.js';
import { routingLandMask, type FineLandIndex } from '../src/routing/fineLandMask.js';

type P = { lat: number; lon: number };
const HERE = dirname(fileURLToPath(import.meta.url));
const LAND = join(HERE, '..', '..', 'viewer', 'public', 'data', 'land');
const coarseMeta: PackedLandMaskMetadata = JSON.parse(readFileSync(join(LAND, 'global-005.json'), 'utf8'));
const coarseBytes = new Uint8Array(gunzipSync(readFileSync(join(LAND, 'global-005.bin.gz'))));
const NWEU = join(LAND, 'nweu-20260825T07Z');
const manifest = parseLandIndexManifest(JSON.parse(readFileSync(join(NWEU, 'manifest.json'), 'utf8')));
const tiles: Record<string, LandIndexTile> = Object.fromEntries(manifest.coverage.tiles.map((id) =>
  [id, decodeLandIndexTile(new Uint8Array(gunzipSync(readFileSync(join(NWEU, `${id}.bin.gz`)))))]));
const fine: FineLandIndex = { manifest, tiles };
const coarse = { bytes: coarseBytes, metadata: coarseMeta };

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

/** The same cells read through an accessor, as the fine window is. */
function asCells(mask: LandMask): LandCellMask {
  const { lat0, lon0, dlat, dlon, nlat, nlon, land } = mask;
  return { kind: 'land_cells', lat0, lon0, dlat, dlon, nlat, nlon, landAt: (i, j) => land[i * nlon + j] === 1, fine_index_id: null };
}

/** The mask with a land summary over size x size blocks, worked out from its own cells. */
function withBlocks(mask: LandCellMask, size: number): LandCellMask {
  return {
    ...mask,
    blocks: {
      size,
      anyLandAt: (bi, bj) => {
        for (let i = bi * size; i < Math.min(mask.nlat, (bi + 1) * size); i++) {
          for (let j = bj * size; j < Math.min(mask.nlon, (bj + 1) * size); j++) if (mask.landAt(i, j)) return true;
        }
        return false;
      },
    },
  };
}

/** The fine cell (row, col on the global 1/480° lattice) a composite cell is. */
const fineCell = (mask: LandCellMask, i: number, j: number) => ({
  k: Math.round((mask.lat0 + i * mask.dlat) * 480 - 0.5),
  c: Math.round((mask.lon0 + j * mask.dlon) * 480 - 0.5),
});
const tileBlocked = (k: number, c: number): boolean | null => {
  const ty = Math.floor(k / 4800);
  const tx = Math.floor(c / 4800);
  const id = `${ty >= 0 ? 'N' : 'S'}${String(Math.abs(ty * 10)).padStart(2, '0')}${tx >= 0 ? 'E' : 'W'}${String(Math.abs(tx * 10)).padStart(3, '0')}`;
  const tile = tiles[id];
  return tile ? tile.blocked(k - ty * 4800, c - tx * 4800) : null;
};
const coarseLandAt = (lat: number, lon: number) => {
  const i = Math.round((lat - coarseMeta.lat0) / coarseMeta.dlat);
  const j = Math.round((lon - coarseMeta.lon0) / coarseMeta.dlon);
  const bit = i * coarseMeta.nlon + j;
  return ((coarseBytes[bit >> 3]! >> (bit & 7)) & 1) === 1;
};

describe('land functions read an accessor mask exactly as an array mask', () => {
  it('isLand, segmentCrossesLand, seaJoinsPoints and snapToSea agree on random masks', () => {
    const rand = mulberry32(20261126);
    for (let m = 0; m < 40; m++) {
      const d = [0.01, 1 / 480, 0.05, 0.1][m % 4]!;
      const nlat = 6 + Math.floor(rand() * 18);
      const nlon = 6 + Math.floor(rand() * 18);
      const lat0 = -60 + rand() * 120;
      const lon0 = -170 + rand() * 340;
      const density = 0.05 + rand() * 0.5;
      const land = Array.from({ length: nlat * nlon }, () => (rand() < density ? 1 : 0));
      const array: LandMask = { schema_version: 1, kind: 'land_mask', lat0, lon0, dlat: d, dlon: d, nlat, nlon, land };
      const cells = asCells(array);
      const blocked = withBlocks(cells, 2 + (m % 4));
      const point = (): P => ({ lat: lat0 + (rand() * (nlat + 2) - 1.5) * d, lon: lon0 + (rand() * (nlon + 2) - 1.5) * d });
      for (let k = 0; k < 120; k++) {
        const a = point();
        const b = rand() < 0.7 ? { lat: a.lat + (rand() - 0.5) * 4 * d, lon: a.lon + (rand() - 0.5) * 4 * d } : point();
        const context = JSON.stringify({ m, k, a, b });
        expect(isLand(cells, a.lat, a.lon), context).toBe(isLand(array, a.lat, a.lon));
        expect(segmentCrossesLand(cells, a, b), context).toBe(segmentCrossesLand(array, a, b));
        expect(segmentCrossesLand(blocked, a, b), context).toBe(segmentCrossesLand(array, a, b));
        const outside = rand() < 0.5;
        expect(seaJoinsPoints(cells, a, b, outside), context).toBe(seaJoinsPoints(array, a, b, outside));
        expect(snapToSea(cells, a), context).toEqual(snapToSea(array, a));
      }
    }
  }, 60_000);
});

describe('routingLandMask: the fine routing index where it has tiles, the 0.05° outline elsewhere', () => {
  it('is the 0.05° outline, unchanged, for a window no fine tile reaches', () => {
    const gibraltar: GeoBbox = { minLat: 35.5, maxLat: 36.5, minLon: -6.5, maxLon: -5 };
    expect(routingLandMask(coarse, fine, gibraltar)).toEqual(windowLandMask(coarseBytes, coarseMeta, gibraltar));
    const solent: GeoBbox = { minLat: 50.5, maxLat: 51, minLon: -1.6, maxLon: -0.9 };
    expect(routingLandMask(coarse, null, solent)).toEqual(windowLandMask(coarseBytes, coarseMeta, solent));
  });

  it('covers exactly the 0.05° window, on the 1/480° lattice, with every cell from the fine tile', () => {
    const bbox: GeoBbox = { minLat: 50.55, maxLat: 50.95, minLon: -1.6, maxLon: -0.95 };
    const old = windowLandMask(coarseBytes, coarseMeta, bbox);
    const mask = routingLandMask(coarse, fine, bbox) as LandCellMask;
    expect(mask.kind).toBe('land_cells');
    expect(mask.fine_index_id).toBe('nweu-20260825T07Z');
    expect(mask.dlat).toBe(1 / 480);
    expect(mask.dlon).toBe(1 / 480);
    expect(mask.lat0 - mask.dlat / 2).toBeCloseTo(old.lat0 - old.dlat / 2, 9);
    expect(mask.lon0 - mask.dlon / 2).toBeCloseTo(old.lon0 - old.dlon / 2, 9);
    expect(mask.nlat).toBe(old.nlat * 24);
    expect(mask.nlon).toBe(old.nlon * 24);
    let blocked = 0;
    for (let i = 0; i < mask.nlat; i++) {
      for (let j = 0; j < mask.nlon; j++) {
        const { k, c } = fineCell(mask, i, j);
        const land = mask.landAt(i, j);
        if (land !== tileBlocked(k, c)) throw new Error(`cell ${i},${j} differs from the tile`);
        if (land) blocked += 1;
      }
    }
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThan(mask.nlat * mask.nlon);
    // isLand picks the cell whose south-west edge TLI1 names.
    expect(isLand(mask, 50.76, -1.10)).toBe(false); // Spithead
    expect(isLand(mask, 50.75, -1.30)).toBe(true); // Isle of Wight, inland of Cowes
    expect(isLand(mask, 50.83, -1.20)).toBe(true); // Hampshire shore
  });

  it.each([
    ['across 40°N on the Portuguese coast', { minLat: 39.6, maxLat: 40.4, minLon: -9.3, maxLon: -8.6 }],
    ['across 10°W on the coast of Kerry', { minLat: 51.8, maxLat: 52.3, minLon: -10.6, maxLon: -9.6 }],
  ])('outside the fine tiles reads the 0.05° cell, never sea: %s', (_label, bbox) => {
    const mask = routingLandMask(coarse, fine, bbox) as LandCellMask;
    let fromTiles = 0;
    let fromOutline = 0;
    let outlineLand = 0;
    for (let i = 0; i < mask.nlat; i++) {
      for (let j = 0; j < mask.nlon; j++) {
        const { k, c } = fineCell(mask, i, j);
        const fromTile = tileBlocked(k, c);
        const expected = fromTile ?? coarseLandAt(mask.lat0 + i * mask.dlat, mask.lon0 + j * mask.dlon);
        if (mask.landAt(i, j) !== expected) throw new Error(`cell ${i},${j} reads ${mask.landAt(i, j)}`);
        if (fromTile === null) {
          fromOutline += 1;
          if (expected) outlineLand += 1;
        } else fromTiles += 1;
      }
    }
    expect(fromTiles).toBeGreaterThan(0);
    expect(fromOutline).toBeGreaterThan(0);
    expect(outlineLand).toBeGreaterThan(0);
  });

  it('the land check reads the same with and without its block summary, on real windows', () => {
    const rand = mulberry32(48);
    for (const bbox of [
      { minLat: 48.1, maxLat: 48.6, minLon: -5.4, maxLon: -4.2 },
      { minLat: 50.5, maxLat: 51, minLon: -1.7, maxLon: -0.9 },
      { minLat: 39.6, maxLat: 40.4, minLon: -9.3, maxLon: -8.6 },
    ]) {
      const mask = routingLandMask(coarse, fine, bbox) as LandCellMask;
      expect(mask.blocks?.size).toBe(8);
      const { blocks: _summary, ...plain } = mask;
      let flagged = 0;
      for (let k = 0; k < 4000; k++) {
        const a = { lat: bbox.minLat + rand() * (bbox.maxLat - bbox.minLat), lon: bbox.minLon + rand() * (bbox.maxLon - bbox.minLon) };
        const reach = [0.004, 0.02, 0.05, 0.3][k % 4]!;
        const b = { lat: a.lat + (rand() - 0.5) * reach, lon: a.lon + (rand() - 0.5) * reach };
        const crosses = segmentCrossesLand(mask, a, b);
        if (crosses !== segmentCrossesLand(plain, a, b)) throw new Error(JSON.stringify({ bbox, a, b }));
        if (crosses) flagged += 1;
      }
      expect(flagged).toBeGreaterThan(100);
      expect(flagged).toBeLessThan(3900);
    }
  }, 60_000);

  it('refuses a window whose fine tiles are not all supplied, or come from another index', () => {
    const bbox: GeoBbox = { minLat: 49.5, maxLat: 50.5, minLon: -1.5, maxLon: -0.5 };
    const { N50W010: _missing, ...rest } = tiles;
    expect(() => routingLandMask(coarse, { manifest, tiles: rest }, bbox)).toThrow(/N50W010/);
    const other = { ...tiles.N40W010!, header: { ...tiles.N40W010!.header, index_id: 'nweu-20990101T00Z' } };
    expect(() => routingLandMask(coarse, { manifest, tiles: { ...tiles, N40W010: other } }, bbox)).toThrow(/index/);
    const misplaced = { ...tiles.N40W010!, header: { ...tiles.N40W010!.header, tile_id: 'N50W010' } };
    expect(() => routingLandMask(coarse, { manifest, tiles: { ...tiles, N50W010: misplaced } }, bbox)).toThrow(/N50W010/);
  });
});

describe('snapToSea reaches a distance, not a cell count', () => {
  it('keeps twelve cells on the 0.05° outline and reaches 0.6° on finer masks', () => {
    const d = 0.01;
    const land = Array<number>(41 * 41).fill(1);
    land[20 * 41 + 40] = 0; // sea 20 cells east of the centre
    const mask: LandMask = { schema_version: 1, kind: 'land_mask', lat0: 0, lon0: 0, dlat: d, dlon: d, nlat: 41, nlon: 41, land };
    expect(snapToSea(mask, { lat: 0.2, lon: 0.2 })).toEqual({ lat: 0.2, lon: 0.4 });
    const coarseMask = { ...mask, dlat: 0.05, dlon: 0.05 };
    expect(snapToSea(coarseMask, { lat: 1, lon: 1 })).toBeNull(); // 20 cells is beyond twelve
  });

  it('snaps a start in the Medina mouth at Cowes to water a few hundred metres away, not miles out', () => {
    const mask = routingLandMask(coarse, fine, { minLat: 50.3, maxLat: 51.2, minLon: -1.8, maxLon: -0.8 });
    const cowes = { lat: 50.766, lon: -1.298 };
    expect(isLand(mask, cowes.lat, cowes.lon)).toBe(true);
    const snapped = snapToSea(mask, cowes)!;
    expect(isLand(mask, snapped.lat, snapped.lon)).toBe(false);
    expect(haversineNm(cowes.lat, cowes.lon, snapped.lat, snapped.lon)).toBeLessThan(0.6);
  });
});

describe('seaJoinsPoints on the fine index', () => {
  const sea = (mask: ReturnType<typeof routingLandMask>, p: P) => snapToSea(mask, p)!;

  it('joins Cowes to Spithead and Brest roads to Ouessant; Southampton Water above Calshot and the Golfe du Morbihan stay closed', () => {
    const solent = routingLandMask(coarse, fine, { minLat: 50.5, maxLat: 51, minLon: -1.7, maxLon: -0.9 });
    expect(seaJoinsPoints(solent, sea(solent, { lat: 50.7685, lon: -1.29 }), { lat: 50.76, lon: -1.1 }, false)).toBe(true);
    expect(seaJoinsPoints(solent, sea(solent, { lat: 50.86, lon: -1.37 }), { lat: 50.76, lon: -1.1 }, false)).toBe(false);
    const iroise = routingLandMask(coarse, fine, { minLat: 48.1, maxLat: 48.6, minLon: -5.4, maxLon: -4.2 });
    expect(seaJoinsPoints(iroise, { lat: 48.36, lon: -4.48 }, { lat: 48.42, lon: -5.2 }, false)).toBe(true);
    const morbihan = routingLandMask(coarse, fine, { minLat: 47.3, maxLat: 47.8, minLon: -3.2, maxLon: -2.5 });
    expect(seaJoinsPoints(morbihan, sea(morbihan, { lat: 47.6, lon: -2.8 }), { lat: 47.5, lon: -2.95 }, false)).toBe(false);
  });

  it('above its cell budget, proves a closed pocket and a thick wall closed, and says joined when it cannot tell', () => {
    const n = 3000; // 9 million cells
    const grid = (land: (i: number, j: number) => boolean): LandCellMask => ({
      kind: 'land_cells', lat0: 0, lon0: 0, dlat: 1 / 480, dlon: 1 / 480, nlat: n, nlon: n, fine_index_id: null, landAt: land,
    });
    const south = { lat: 100 / 480, lon: 100 / 480 };
    const north = { lat: 2900 / 480, lon: 2900 / 480 };
    // A one-cell ring of land round the south point: a harbour with no way out.
    const pocket = grid((i, j) => Math.max(Math.abs(i - 100), Math.abs(j - 100)) === 40);
    expect(seaJoinsPoints(pocket, south, north, false)).toBe(false);
    expect(seaJoinsPoints(pocket, north, south, false)).toBe(false);
    // A wall across the window, thicker than its blocks, with and without a gap.
    const thick = (gap: boolean) => grid((i, j) => i >= 1500 && i < 1508 && !(gap && j === 700));
    expect(seaJoinsPoints(thick(false), south, north, false)).toBe(false);
    expect(seaJoinsPoints(thick(true), south, north, false)).toBe(true);
    expect(seaJoinsPoints(thick(false), south, north, true)).toBe(true);
    // A one-cell wall across both halves too big to fill: not provable, so joined.
    expect(seaJoinsPoints(grid((i) => i === 1500), south, north, false)).toBe(true);
  });
});
