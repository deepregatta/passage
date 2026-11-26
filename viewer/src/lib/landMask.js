import {
  decodeLandIndexTile, fnv1a64Hex, parseLandIndexManifest, routingLandMask, windowLandMask,
} from '@deepweather/engine';
import { FINE_LAND_ENABLED, FINE_LAND_INDEX } from './fineLandSwitch.js';

export { FINE_LAND_ENABLED, FINE_LAND_INDEX };

/**
 * How long one routing-index file (the manifest or a tile, each under 60 kB) may take before
 * the route goes on without it, on the outline: a fetch that stalls must not hold Compute at
 * "Loading the coastline" or stay cached as a promise that never settles.
 */
export const FINE_FETCH_TIMEOUT_MS = 10_000;

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

/** The bytes of one routing-index file, or a rejection once `timeoutMs` has passed (the fetch is then aborted). */
async function fetchFineBytes(url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${url}: no answer within ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const read = (async () => {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  })();
  read.catch(() => {});
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFineManifest(timeoutMs) {
  const bytes = await fetchFineBytes(`${FINE_LAND_INDEX}/manifest.json`, timeoutMs);
  return parseLandIndexManifest(JSON.parse(new TextDecoder().decode(bytes)));
}

/** A fine tile, checked against the manifest's size and checksum (of the gzipped object) before decoding. */
async function fetchFineTile(manifest, id, timeoutMs) {
  const stored = await fetchFineBytes(`${FINE_LAND_INDEX}/${id}.bin.gz`, timeoutMs);
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
async function fineIndexFor(bbox, timeoutMs) {
  fineManifestPromise ??= fetchFineManifest(timeoutMs).catch((error) => {
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
    [id, await remembered(fineTilePromises, id, () => fetchFineTile(manifest, id, timeoutMs))])));
  return { manifest, tiles };
}

/**
 * The land mask a computed route reads for `bbox`: the 0.05° outline window, or with
 * `fine` (FINE_LAND_ENABLED by default) the fine routing index wherever it has a tile.
 * Fine data that cannot be fetched within `timeoutMs` a file, does not match its manifest
 * or cannot be made into a window leaves the route on the outline: a window is never built
 * with a hole in it.
 */
export async function landMaskForBbox(bbox, { fine = FINE_LAND_ENABLED, timeoutMs = FINE_FETCH_TIMEOUT_MS } = {}) {
  packedMaskPromise ??= fetchPackedMask().catch((error) => {
    packedMaskPromise = undefined;
    throw error;
  });
  const coarse = await packedMaskPromise;
  if (!fine) return windowLandMask(coarse.bytes, coarse.metadata, bbox);
  try {
    return routingLandMask(coarse, await fineIndexFor(bbox, timeoutMs), bbox);
  } catch {
    // The outline alone, as before the fine index: never sea where the fine data is missing.
    return windowLandMask(coarse.bytes, coarse.metadata, bbox);
  }
}

export function clearLandMaskCacheForTests() {
  packedMaskPromise = undefined;
  fineManifestPromise = undefined;
  fineTilePromises.clear();
}
