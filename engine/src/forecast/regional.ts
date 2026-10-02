/** Regional comparison is explicit, bounded and requires complete coverage. */
import { edgeNeighbourProbes, tileIdFor } from './tileMath.js';
import { runSpan } from './modelRuns.js';
import type { RunManifest } from './store.js';

export const REGIONAL_LAYERS: readonly string[] = ['weather-arome', 'weather-icon-eu', 'weather-ukv'];
export class RegionalUnavailableError extends Error {}
export const REGIONAL_TRANSFER_BYTES = 20 * 1024 * 1024;
export const REGIONAL_WORKING_BYTES = 128 * 1024 * 1024;

export function regionalTileBudget(tile: RunManifest['tiles'][string]): number {
  const decoded = tile.decoded_bytes, inflated = tile.uncompressed_bytes;
  if (!Number.isSafeInteger(decoded) || !Number.isSafeInteger(inflated) || decoded! <= 0 || inflated! <= 0 ||
      tile.bytes > 8 * 1024 * 1024 || decoded! > 32 * 1024 * 1024 || inflated! > 24 * 1024 * 1024) {
    throw new RegionalUnavailableError('Regional tile exceeds browser budget or lacks size metadata');
  }
  // Retained output, compressed/inflate copies, decoded arrays and request output reserve.
  const transient = 2 * tile.bytes + 2 * inflated! + 2 * decoded! + 16 * 1024 * 1024;
  if (transient > REGIONAL_WORKING_BYTES) throw new RegionalUnavailableError('Regional working set exceeds browser budget');
  return transient;
}

export function regionalResources(manifest: RunManifest, points: Array<{lat: number; lon: number}>, start: number, end: number): {transferBytes: number; decodedBytes: number; peakBytes: number} {
  const c = manifest.coverage, span = runSpan(manifest, 'wind_u_kt');
  if (!c || !manifest.capabilities?.includes('wind') || !Number.isFinite(start) || !Number.isFinite(end) ||
      end < start || !span || start < span.startMs || end > span.endMs) {
    throw new RegionalUnavailableError('Regional model does not cover this period');
  }
  const outputBytes = points.length * (Math.ceil((end - start) / 3_600_000) + 1) * 64;
  if (!Number.isSafeInteger(outputBytes) || outputBytes > 16 * 1024 * 1024) {
    throw new RegionalUnavailableError('Regional output exceeds browser budget; choose fewer points');
  }
  const wanted = new Set<string>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat < c.minLat || p.lat > c.maxLat || p.lon < c.minLon || p.lon > c.maxLon) {
      throw new RegionalUnavailableError('Regional model does not cover this route');
    }
    const id = tileIdFor(p.lat, p.lon, manifest.tiling.tile_deg);
    if (manifest.tiles[id]) wanted.add(id);
    for (const probe of edgeNeighbourProbes(null, p.lat, p.lon, manifest.resolution_deg, manifest.tiling.tile_deg)) {
      if (manifest.tiles[probe.tileId]) wanted.add(probe.tileId);
    }
  }
  let bytes = 0, decodedBytes = 0;
  for (const id of wanted) {
    const tile = manifest.tiles[id]!;
    regionalTileBudget(tile); bytes += tile.bytes; decodedBytes += tile.decoded_bytes!;
  }
  if (bytes > REGIONAL_TRANSFER_BYTES) throw new RegionalUnavailableError('Regional request exceeds 20 MiB; choose a smaller region');
  const peakBytes = Math.max(0, ...[...wanted].map(id => {
    const tile = manifest.tiles[id]!;
    return decodedBytes - tile.decoded_bytes! + regionalTileBudget(tile);
  }));
  return {transferBytes: bytes, decodedBytes, peakBytes};
}

export function regionalAdmission(manifest: RunManifest, points: Array<{lat: number; lon: number}>, start: number, end: number): number {
  return regionalResources(manifest, points, start, end).transferBytes;
}
