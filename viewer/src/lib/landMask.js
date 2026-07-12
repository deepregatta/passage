import { windowLandMask } from '@deepweather/engine';

let packedMaskPromise;

async function fetchPackedMask() {
  const [metadataResponse, bytesResponse] = await Promise.all([
    fetch('/data/land/global-005.json'),
    fetch('/data/land/global-005.bin.gz'),
  ]);
  if (!metadataResponse.ok || !bytesResponse.ok) {
    throw new Error("Couldn't load the coastline data needed for safe routing");
  }
  const metadata = await metadataResponse.json();
  let bytes = new Uint8Array(await bytesResponse.arrayBuffer());
  if (metadata.encoding === 'gzip') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress the coastline data');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { metadata, bytes };
}

export async function landMaskForBbox(bbox) {
  packedMaskPromise ??= fetchPackedMask().catch((error) => {
    packedMaskPromise = undefined;
    throw error;
  });
  const { metadata, bytes } = await packedMaskPromise;
  return windowLandMask(bytes, metadata, bbox);
}

export function clearLandMaskCacheForTests() {
  packedMaskPromise = undefined;
}
