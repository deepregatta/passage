import {
  decodeLandIndexTile, fnv1a64Hex, parseLandIndexManifest, routingLandMask, windowLandMask,
} from '@deepweather/engine';

/**
 * The fine routing index (TLI1, 1/480°: land, drying areas and a 200 m buffer) for the
 * English Channel, Brittany, Biscay and the southern North Sea: forecast-tiles'
 * published nweu-20260825T07Z, served from this site as a pinned copy
 * (contracts/shared-contracts.lock.json, docs/shared-contracts.md).
 */
export const FINE_LAND_INDEX = '/data/land/nweu-20260825T07Z';
/**
 * Whether computed routes read the fine index where it has tiles. Off: every route
 * reads the 0.05° outline alone, as before. Turning it on changes computed routes on
 * the public site, and the credits and wording that go with it, so it needs the
 * owner's approval.
 */
export const FINE_LAND_ENABLED = false;

let packedMaskPromise;
let fineManifestPromise;
/** Decoded fine tiles by id (a promise each); a failed one is forgotten so the next route tries again. */
const fineTilePromises = new Map();

async function fetchPackedMask() {
  const [metadataResponse, bytesResponse] = await Promise.all([
    fetch('/data/land/global-005.json'),
    fetch('/data/land/global-005.bin.gz'),
  ]);
  if (!metadataResponse.ok || !bytesResponse.ok) {
    throw new Error("Couldn't load the coastline data needed to compute a route");
  }
  const metadata = await metadataResponse.json();
  let bytes = new Uint8Array(await bytesResponse.arrayBuffer());
  if (metadata.encoding === 'gzip') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress the coastline data');
    }
    bytes = await gunzip(bytes);
  }
  return { metadata, bytes };
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One promise per key, forgotten when it fails. */
function remembered(map, key, load) {
  if (!map.has(key)) {
    map.set(key, load().catch((error) => {
      map.delete(key);
      throw error;
    }));
  }
  return map.get(key);
}

async function fetchFineManifest() {
  const response = await fetch(`${FINE_LAND_INDEX}/manifest.json`);
  if (!response.ok) throw new Error(`routing-index manifest: HTTP ${response.status}`);
  return parseLandIndexManifest(await response.json());
}

/** A fine tile, checked against the manifest's size and checksum (of the gzipped object) before decoding. */
async function fetchFineTile(manifest, id) {
  const response = await fetch(`${FINE_LAND_INDEX}/${id}.bin.gz`);
  if (!response.ok) throw new Error(`routing-index tile ${id}: HTTP ${response.status}`);
  const stored = new Uint8Array(await response.arrayBuffer());
  const expected = manifest.tiles[id];
  if (stored.length !== expected.bytes || fnv1a64Hex(stored) !== expected.fnv64) {
    throw new Error(`routing-index tile ${id} differs from its manifest`);
  }
  const tile = decodeLandIndexTile(await gunzip(stored));
  if (tile.header.tile_id !== id || tile.header.index_id !== manifest.index_id) {
    throw new Error(`routing-index tile ${id} is not that tile of ${manifest.index_id}`);
  }
  return tile;
}

/** The manifest and the decoded tiles whose 10° squares meet `bbox` (with a 0.05° outline cell of margin). */
async function fineIndexFor(bbox) {
  fineManifestPromise ??= fetchFineManifest().catch((error) => {
    fineManifestPromise = undefined;
    throw error;
  });
  const manifest = await fineManifestPromise;
  const deg = manifest.grid.tile_deg;
  const margin = 0.05;
  const needed = manifest.coverage.tiles.filter((id) => {
    const lat = (id[0] === 'S' ? -1 : 1) * Number(id.slice(1, 3));
    const lon = (id[3] === 'W' ? -1 : 1) * Number(id.slice(4, 7));
    return bbox.minLat - margin < lat + deg && bbox.maxLat + margin > lat &&
      bbox.minLon - margin < lon + deg && bbox.maxLon + margin > lon;
  });
  const tiles = Object.fromEntries(await Promise.all(needed.map(async (id) =>
    [id, await remembered(fineTilePromises, id, () => fetchFineTile(manifest, id))])));
  return { manifest, tiles };
}

/**
 * The land mask a computed route reads for `bbox`: the 0.05° outline window, or with
 * `fine` (FINE_LAND_ENABLED by default) the fine routing index wherever it has a tile.
 * Fine data that cannot be fetched or does not match its manifest leaves the route on
 * the outline: a window is never built with a hole in it.
 */
export async function landMaskForBbox(bbox, { fine = FINE_LAND_ENABLED } = {}) {
  packedMaskPromise ??= fetchPackedMask().catch((error) => {
    packedMaskPromise = undefined;
    throw error;
  });
  const coarse = await packedMaskPromise;
  if (!fine) return windowLandMask(coarse.bytes, coarse.metadata, bbox);
  let index = null;
  try {
    index = await fineIndexFor(bbox);
  } catch {
    // The outline alone, as before the fine index: never sea where the fine data is missing.
  }
  return index
    ? routingLandMask(coarse, index, bbox)
    : windowLandMask(coarse.bytes, coarse.metadata, bbox);
}

export function clearLandMaskCacheForTests() {
  packedMaskPromise = undefined;
  fineManifestPromise = undefined;
  fineTilePromises.clear();
}
