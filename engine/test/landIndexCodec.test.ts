import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fnv1a64Hex } from '../src/hash.js';
import {
  decodeLandIndexTile, parseLandIndexManifest, TLI1_CELLS_PER_DEG,
  type LandIndexTile,
} from '../src/routing/landIndex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RAZ = join(HERE, 'fixtures', 'land-index-raz');
const NWEU = join(REPO, 'viewer', 'public', 'data', 'land', 'nweu-20260825T07Z');
const schema = (name: string) => JSON.parse(readFileSync(join(REPO, 'contracts', `land-index-${name}.schema.json`), 'utf8'));
const ajv = new Ajv2020({ strict: false });
const validTile = ajv.compile(schema('tile'));
const validManifest = ajv.compile(schema('manifest'));

const raw = (dir: string, tile: string) => new Uint8Array(gunzipSync(readFileSync(join(dir, `${tile}.bin.gz`))));
const blockedAt = (tile: LandIndexTile, lat: number, lon: number) => {
  const { lat0, lon0, dlat, dlon } = tile.header;
  return tile.blocked(Math.floor((lat - lat0) / dlat), Math.floor((lon - lon0) / dlon));
};

/** A one-row TLI1 tile with the given header overrides and payload. */
function tileBytes(overrides: Record<string, unknown> = {}, payload = new Uint8Array([0b0000_0101])): Uint8Array {
  const header = {
    spec: 'TLI1', schema_version: 1, index_id: 'test-20260101T00Z', tile_id: 'N48W005',
    lon0: -5, lat0: 48, dlon: 1 / 480, dlat: 1 / 480, nlon: 8, nlat: 1, row_bytes: 1,
    cell_order: 'south_to_north_row_major_lsb_first', cells: 8, blocked_cells: 2,
    composition: { land_cells: 2, shoal_cells: 0, nodata_cells: 0, blocked_before_buffer: 2 },
    conservatism: { buffer_m: 0, dilation_cells: { lon: 0, lat: 0 }, safety_contour_m: 0, vertical_datum: 'LAT' },
    generated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((8 + json.length) % 4)) % 4;
  const out = new Uint8Array(8 + json.length + pad + payload.length);
  out.set(new TextEncoder().encode('TLI1'), 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(payload, 8 + json.length + pad);
  return out;
}

describe('TLI1 tile decoder: the Raz de Sein golden', () => {
  const expected = JSON.parse(readFileSync(join(RAZ, 'expected.json'), 'utf8'));
  const bytes = raw(RAZ, 'N48W005');
  const tile = decodeLandIndexTile(bytes);

  it('reproduces the header, the blocked count and the checksum', () => {
    expect(fnv1a64Hex(bytes)).toBe(expected.fnv64_uncompressed);
    expect(tile.header).toEqual(expected.header);
    expect(validTile(tile.header)).toBe(true);
    let count = 0;
    for (let row = 0; row < tile.header.nlat; row++) {
      for (let col = 0; col < tile.header.nlon; col++) if (tile.blocked(row, col)) count++;
    }
    expect(count).toBe(expected.blocked_cells);
  });

  it('reads every probe with the south-west edge convention', () => {
    for (const probe of expected.probes) {
      expect(blockedAt(tile, probe.lat, probe.lon), probe.label).toBe(probe.blocked);
    }
  });

  it('finds the widest clear run across the Raz passage row', () => {
    const passage = expected.raz_passage_row;
    expect(Math.floor((passage.lat - tile.header.lat0) / tile.header.dlat)).toBe(passage.row);
    let best = { length: 0, start: 0 };
    let start = -1;
    for (let col = 0; col <= tile.header.nlon; col++) {
      const clear = col < tile.header.nlon && !tile.blocked(passage.row, col);
      if (clear && start < 0) start = col;
      if (!clear && start >= 0) {
        if (col - start > best.length) best = { length: col - start, start };
        start = -1;
      }
    }
    expect(best.length).toBe(passage.widest_clear_run_cells);
    expect(tile.header.lon0 + best.start * tile.header.dlon).toBeCloseTo(passage.from_lon, 9);
    expect(tile.header.lon0 + (best.start + best.length) * tile.header.dlon).toBeCloseTo(passage.to_lon, 9);
  });

  it('answers outside the tile as unknown, never as clear', () => {
    expect(tile.blocked(-1, 0)).toBeNull();
    expect(tile.blocked(0, tile.header.nlon)).toBeNull();
    expect(tile.blocked(tile.header.nlat, 0)).toBeNull();
    expect(tile.blocked(0.5, 0)).toBeNull();
    expect(tile.blocked(Number.NaN, 0)).toBeNull();
  });

  it('reads the golden manifest', () => {
    const manifest = parseLandIndexManifest(JSON.parse(readFileSync(join(RAZ, 'manifest.json'), 'utf8')));
    expect(manifest.index_id).toBe(expected.index_id);
    expect(manifest.coverage.tiles).toEqual([expected.tile_id]);
  });
});

describe('TLI1 tile decoder: the pinned nweu index', () => {
  const manifestDoc = JSON.parse(readFileSync(join(NWEU, 'manifest.json'), 'utf8'));
  const manifest = parseLandIndexManifest(manifestDoc);

  it('is the published nweu-20260825T07Z manifest, valid against the pinned schema', () => {
    expect(validManifest(manifestDoc)).toBe(true);
    expect(manifest.index_id).toBe('nweu-20260825T07Z');
    expect(manifest.grid.cells_per_deg).toBe(TLI1_CELLS_PER_DEG);
    expect([...manifest.coverage.tiles].sort()).toEqual(['N40E000', 'N40W010', 'N50E000', 'N50W010']);
  });

  it('holds every tile the manifest lists, matching its size and checksum, and they decode', () => {
    for (const id of manifest.coverage.tiles) {
      const gz = new Uint8Array(readFileSync(join(NWEU, `${id}.bin.gz`)));
      expect(gz.length, id).toBe(manifest.tiles[id]!.bytes);
      expect(fnv1a64Hex(gz), id).toBe(manifest.tiles[id]!.fnv64);
      const tile = decodeLandIndexTile(new Uint8Array(gunzipSync(gz)));
      expect(tile.header.tile_id).toBe(id);
      expect(tile.header.index_id).toBe(manifest.index_id);
      expect(validTile(tile.header)).toBe(true);
    }
  });

  it('reads land and water where the published validation says it does', () => {
    const tile = decodeLandIndexTile(raw(NWEU, 'N50W010'));
    expect(blockedAt(tile, 51.06, -1.31), 'Winchester').toBe(true);
    expect(blockedAt(tile, 50.76, -1.10), 'Spithead').toBe(false);
    const brittany = decodeLandIndexTile(raw(NWEU, 'N40W010'));
    expect(blockedAt(brittany, 48.27, -3.57), 'Carhaix').toBe(true);
    expect(blockedAt(brittany, 48.36, -4.48), 'Brest roads').toBe(false);
  });
});

describe('TLI1 tile decoder: refuses what it does not know', () => {
  it('decodes a minimal tile, bit 0 westernmost', () => {
    const tile = decodeLandIndexTile(tileBytes());
    expect([0, 1, 2, 3].map((col) => tile.blocked(0, col))).toEqual([true, false, true, false]);
  });

  it.each([
    ['another magic', () => { const b = tileBytes(); b[3] = 0x32; return b; }, /TLI1/],
    ['a newer schema version', () => tileBytes({ schema_version: 2 }), /schema 2.*schema 1/],
    ['another spec', () => tileBytes({ spec: 'TLI2' }), /TLI2/],
    ['another cell order', () => tileBytes({ cell_order: 'north_to_south' }), /cell order/],
    ['wrong row bytes', () => tileBytes({ row_bytes: 2 }), /row bytes/],
    ['wrong cell count', () => tileBytes({ cells: 9 }), /cells/],
    ['a blocked count the payload does not hold', () => tileBytes({ blocked_cells: 3 }), /blocked cells/],
    ['a short payload', () => tileBytes({ nlat: 2, cells: 16 }), /payload/],
    ['trailing bytes', () => tileBytes({}, new Uint8Array([0b101, 0])), /payload/],
    ['set padding bits', () => tileBytes({ nlon: 6, cells: 6, blocked_cells: 3 }, new Uint8Array([0b1000_0101])), /padding/],
    ['non-square cells', () => tileBytes({ dlat: 1 / 240 }), /square|cell size/],
    ['a cell size other than 1/480°', () => tileBytes({ dlon: 1 / 240, dlat: 1 / 240 }), /cell size/],
    ['a corner off the tile id', () => tileBytes({ lat0: 48.5 }), /corner/],
    ['a header running past the end', () => tileBytes().slice(0, 20), /header/],
  ])('refuses %s', (_label, make, message) => {
    expect(() => decodeLandIndexTile(make())).toThrow(message);
  });

  it('refuses a manifest of another version or grid', () => {
    const doc = JSON.parse(readFileSync(join(RAZ, 'manifest.json'), 'utf8'));
    expect(() => parseLandIndexManifest({ ...doc, schema_version: 2 })).toThrow(/schema/);
    expect(() => parseLandIndexManifest({ ...doc, spec: 'PFT1' })).toThrow(/PFT1/);
    expect(() => parseLandIndexManifest({ ...doc, grid: { ...doc.grid, cells_per_deg: 240 } })).toThrow(/grid/);
    expect(() => parseLandIndexManifest({ ...doc, tiles: {} })).toThrow(/tile/);
  });
});
