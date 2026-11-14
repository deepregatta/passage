// @ts-check
// gzip for the bytes a saved check keeps in IndexedDB (localSnapshots.js).
// Only the stored form changes: the text the engine wrote is what reads back,
// and nothing may compare these bytes (gzip output differs between browsers).
// The browser's own CompressionStream does the work; no library.

/** @param {ReadableStream<Uint8Array>} readable */
async function collect(readable) {
  const reader = readable.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** @param {CompressionStream | DecompressionStream} stream @param {Uint8Array<ArrayBuffer>} bytes */
function pipe(stream, bytes) {
  const writer = stream.writable.getWriter();
  // A failing stream rejects these as well; its readable side reports the error.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return collect(stream.readable);
}

/**
 * The gzip of `text`'s UTF-8 bytes, or null when this browser cannot compress.
 * Callers store it only after `gunzipText` gives back the same text
 * (localSnapshots.js toRecord); that check also rejects a lone surrogate,
 * which UTF-8 cannot carry.
 * @param {string} text @returns {Promise<Uint8Array<ArrayBuffer> | null>}
 */
export async function gzipText(text) {
  if (typeof CompressionStream !== 'function') return null;
  return pipe(new CompressionStream('gzip'), new TextEncoder().encode(text));
}

/**
 * The text `gzipText` was given. Throws when this browser cannot decompress,
 * the bytes are not complete gzip, or they do not decode as UTF-8: never a
 * partial or empty string in place of the saved text.
 * @param {Uint8Array<ArrayBuffer>} bytes @returns {Promise<string>}
 */
export async function gunzipText(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read compressed briefings (no DecompressionStream)');
  if (!ArrayBuffer.isView(bytes)) throw new TypeError('A compressed briefing record holds no bytes');
  const raw = await pipe(new DecompressionStream('gzip'), bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
