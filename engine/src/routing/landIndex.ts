/**
 * TLI1, the conservative routing index forecast-tiles publishes (land, drying areas and a
 * 200 m outward buffer, at 1/480°): a fresh decoder written against the pinned contract
 * (contracts/land-index-*.schema.json, the format in forecast-tiles
 * docs/land-index-format.md) and checked on its Raz de Sein golden. No implementation
 * is copied from forecast-tiles or Tactician.
 *
 * A tile names its cells by their south-west edge: cell (row, col) covers
 * lat ∈ [lat0 + row·dlat, lat0 + (row+1)·dlat), lon ∈ [lon0 + col·dlon, lon0 + (col+1)·dlon),
 * row 0 southernmost, bit 0 of each row byte westernmost, a set bit blocked. Outside a
 * tile the index says nothing: `blocked` answers null there, never "clear".
 */

export const TLI1_SPEC = 'TLI1';
export const TLI1_SCHEMA_VERSION = 1;
export const TLI1_CELL_ORDER = 'south_to_north_row_major_lsb_first';
/** The only grid this decoder reads: 1/480° square cells (about 232 m of latitude). */
export const TLI1_CELLS_PER_DEG = 480;

export interface LandIndexTileHeader {
  spec: string;
  schema_version: number;
  index_id: string;
  domain?: string;
  tile_id: string;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  nlon: number;
  nlat: number;
  row_bytes: number;
  cell_order: string;
  cells: number;
  blocked_cells: number;
  composition: Record<string, number>;
  conservatism: {
    buffer_m: number;
    dilation_cells: { lon: number; lat: number };
    safety_contour_m: number;
    vertical_datum: string;
  };
  generated_at: string;
}

export interface LandIndexTile {
  header: LandIndexTileHeader;
  /** The packed payload: nlat rows of row_bytes, as published. */
  bits: Uint8Array;
  /** Whether cell (row, col) is blocked; null outside the tile or for a non-integer index. */
  blocked(row: number, col: number): boolean | null;
}

export interface LandIndexManifest {
  schema_version: number;
  spec: string;
  index_id: string;
  domain: string;
  not_for_navigation: string;
  coverage: { tiles: string[]; min_lon: number; max_lon: number; min_lat: number; max_lat: number };
  grid: { tile_deg: number; cells_per_deg: number; dlon: number; dlat: number; cell_order: string };
  tiling: { tile_deg: number; path_template: string };
  tiles: Record<string, { bytes: number; fnv64: string }>;
  sources: Array<{ name: string; licence: string; attribution: string; use_constraint?: string }>;
  [key: string]: unknown;
}

const TILE_ID = /^([NS])(\d{2})([EW])(\d{3})$/;
const INDEX_ID = /^[a-z0-9]+-[0-9]{8}T[0-9]{2}Z$/;

/** The south-west corner a tile id names, in degrees. */
export function landIndexTileCorner(tileId: string): { lat: number; lon: number } {
  const m = TILE_ID.exec(tileId);
  if (!m) throw new Error(`routing-index tile id ${JSON.stringify(tileId)} is not of the form N48W005`);
  return { lat: (m[1] === 'S' ? -1 : 1) * Number(m[2]), lon: (m[3] === 'W' ? -1 : 1) * Number(m[4]) };
}

const isCount = (value: unknown, min: number) => Number.isInteger(value) && (value as number) >= min;

const POPCOUNT = new Uint8Array(256).map((_, byte) => {
  let n = 0;
  for (let b = byte; b; b >>= 1) n += b & 1;
  return n;
});

/** Decode one uncompressed TLI1 tile, refusing any version, grid or payload it does not know. */
export function decodeLandIndexTile(bytes: Uint8Array): LandIndexTile {
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== TLI1_SPEC) {
    const found = String.fromCharCode(...bytes.subarray(0, 4));
    throw new Error(`routing-index tile starts with ${JSON.stringify(found)}, this version of Passage reads TLI1`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, true);
  const headerEnd = 8 + headerLength;
  if (headerEnd > bytes.length) throw new Error('routing-index tile header runs past the end of the tile');
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, headerEnd))) as LandIndexTileHeader;
  const id = typeof header.tile_id === 'string' ? header.tile_id : '(no id)';
  if (header.spec !== TLI1_SPEC || header.schema_version !== TLI1_SCHEMA_VERSION) {
    throw new Error(`routing-index tile ${id} is ${header.spec} schema ${header.schema_version}, ` +
      `this version of Passage reads ${TLI1_SPEC} schema ${TLI1_SCHEMA_VERSION}`);
  }
  if (header.cell_order !== TLI1_CELL_ORDER) {
    throw new Error(`routing-index tile ${id} cell order is ${header.cell_order}, this version of Passage reads ${TLI1_CELL_ORDER}`);
  }
  const { nlat, nlon } = header;
  if (!isCount(nlat, 1) || !isCount(nlon, 1)) throw new Error(`routing-index tile ${id} has no rows or columns`);
  if (header.row_bytes !== Math.ceil(nlon / 8)) {
    throw new Error(`routing-index tile ${id} says ${header.row_bytes} row bytes for ${nlon} columns`);
  }
  if (header.cells !== nlat * nlon) throw new Error(`routing-index tile ${id} says ${header.cells} cells for a ${nlat}x${nlon} grid`);
  if (header.dlon !== header.dlat) throw new Error(`routing-index tile ${id} has cells of ${header.dlon}° x ${header.dlat}°, not square`);
  if (!(Math.abs(header.dlon * TLI1_CELLS_PER_DEG - 1) < 1e-12)) {
    throw new Error(`routing-index tile ${id} has cell size ${header.dlon}°, this version of Passage reads 1/${TLI1_CELLS_PER_DEG}°`);
  }
  const corner = landIndexTileCorner(id);
  if (header.lat0 !== corner.lat || header.lon0 !== corner.lon) {
    throw new Error(`routing-index tile ${id} has its corner at ${header.lat0}, ${header.lon0}, not where its id says`);
  }
  if (!INDEX_ID.test(String(header.index_id))) throw new Error(`routing-index tile ${id} has index id ${header.index_id}`);

  const payloadStart = headerEnd + ((4 - (headerEnd % 4)) % 4);
  const rowBytes = header.row_bytes;
  const expected = nlat * rowBytes;
  const available = Math.max(0, bytes.length - payloadStart);
  if (available !== expected) throw new Error(`routing-index tile ${id} payload is ${available} bytes, expected ${expected}`);
  const bits = bytes.subarray(payloadStart);
  const spare = rowBytes * 8 - nlon;
  const spareMask = spare ? (0xff << (8 - spare)) & 0xff : 0;
  let counted = 0;
  for (let row = 0; row < nlat; row++) {
    const base = row * rowBytes;
    for (let k = 0; k < rowBytes; k++) counted += POPCOUNT[bits[base + k]!]!;
    if (spareMask && bits[base + rowBytes - 1]! & spareMask) {
      throw new Error(`routing-index tile ${id} sets padding bits beyond column ${nlon} in row ${row}`);
    }
  }
  if (counted !== header.blocked_cells) {
    throw new Error(`routing-index tile ${id} payload has ${counted} blocked cells, header says ${header.blocked_cells}`);
  }
  return {
    header,
    bits,
    blocked(row: number, col: number) {
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= nlat || col < 0 || col >= nlon) return null;
      return ((bits[row * rowBytes + (col >> 3)]! >> (col & 7)) & 1) === 1;
    },
  };
}

/** Read a routing-index manifest, refusing another version, another grid or a tile list it cannot fetch. */
export function parseLandIndexManifest(doc: unknown): LandIndexManifest {
  const m = doc as LandIndexManifest;
  if (!m || typeof m !== 'object') throw new Error('routing-index manifest is not an object');
  if (m.spec !== TLI1_SPEC || m.schema_version !== TLI1_SCHEMA_VERSION) {
    throw new Error(`routing-index manifest is ${m.spec} schema ${m.schema_version}, ` +
      `this version of Passage reads ${TLI1_SPEC} schema ${TLI1_SCHEMA_VERSION}`);
  }
  if (!INDEX_ID.test(String(m.index_id))) throw new Error(`routing-index manifest has index id ${m.index_id}`);
  const grid = m.grid;
  if (!grid || grid.cells_per_deg !== TLI1_CELLS_PER_DEG || grid.cell_order !== TLI1_CELL_ORDER) {
    throw new Error(`routing-index manifest ${m.index_id} has a grid this version of Passage does not read`);
  }
  const tiles = m.coverage?.tiles;
  if (!Array.isArray(tiles) || tiles.length === 0) throw new Error(`routing-index manifest ${m.index_id} lists no tiles`);
  for (const id of tiles) {
    landIndexTileCorner(id);
    const entry = m.tiles?.[id];
    if (!entry || !isCount(entry.bytes, 1) || !/^[0-9a-f]{16}$/.test(String(entry.fnv64))) {
      throw new Error(`routing-index manifest ${m.index_id} gives no size or checksum for tile ${id}`);
    }
  }
  return m;
}
