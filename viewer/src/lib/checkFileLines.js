import {
  CHECK_FILE_V2_MAX_CHECKS, CHECK_FILE_V2_MAX_COMPRESSED_BYTES, CHECK_FILE_V2_MAX_EDGE_BYTES, CHECK_FILE_V2_MAX_INFLATED_BYTES,
  CHECK_FILE_V2_MAX_LINE_BYTES, CHECK_FILE_V2_TRAILER_PREFIX, parseCheckFileHeader, parseCheckFileTrailer,
} from '@deepweather/engine';

// The stream reader of the check file, version 2 (engine/src/checkFile.ts):
// JSON lines inside one gzip member, read through the browser's own
// DecompressionStream without ever holding more than one line (2026-11-15,
// stage 2; nothing in the app calls it yet). The file is hostile: every cap is
// enforced while bytes are still buffering, and the reader stops at the first
// problem. It only frames lines: proving each check stays with the caller
// (the engine's parseCheckFileEntryLine). It reads the header and trailer
// itself, since it needs them to know where the file starts and ends.
//
// Yields, in order: { kind: 'v2', header } (the header parsed); each check
// line's text (a string, without its newline); then { trailer }, the engine's
// parseCheckFileTrailer result, once the file has ended cleanly after it. Or
// yields only { kind: 'v1' } and stops when the first line is not a version-2
// header: the file may be a version-1 document (one line, with or without one
// final newline), and the caller hands the same File to the stage 1 path
// (lib/checkImport.js readCheckFile), which reads it afresh with its own caps
// (16 MB compressed, 64 MB inflated) and gives exactly its own outcomes. Every
// other problem throws a CheckFileLinesError whose code is one of LINES.
//
// Framing decisions: a line is split on byte 0x0A before it is decoded (0x0A
// never occurs inside a UTF-8 sequence), then decoded alone with a fatal
// decoder that keeps a byte order mark (which no JSON line may start with). A
// carriage return before the newline is part of the line: the engine refuses
// it, since Passage never writes one and gzip keeps text tools from adding
// one, so a carriage return means the text was rewritten by something else.
// The trailer may end with or without its newline; nothing else may follow.

/** Why a version-2 file was not read to its end; the caller says each in plain words. */
export const LINES = Object.freeze({
  notCheckFile: 'not-check-file', // no file
  notGzip: 'not-gzip', // the first bytes are not gzip's
  tooLarge: 'too-large', // the file, a line, the trailer or all lines inflated over a cap
  truncated: 'truncated', // the gzip stream failed or ended before the trailer
  corrupt: 'corrupt', // the gzip stream failed its own check after the trailer
  trailingData: 'trailing-data', // bytes after the trailer, or after the gzip member that are not a member
  secondMember: 'second-member', // a second gzip member
  invalidUtf8: 'invalid-utf8', // a line that is not strict UTF-8
  newerVersion: 'newer-version', // a header of a format version above 2
  checkCount: 'check-count', // more check lines than a file may hold
  aborted: 'aborted', // the caller's AbortSignal
});

/** The caps a version-2 file is read under (engine constants); a test may pass smaller ones. */
export const LINE_CAPS = Object.freeze({
  compressedBytes: CHECK_FILE_V2_MAX_COMPRESSED_BYTES,
  /** one check line's bytes, its newline not counted */
  lineBytes: CHECK_FILE_V2_MAX_LINE_BYTES,
  /** the header's and the trailer's bytes each, newline not counted */
  edgeBytes: CHECK_FILE_V2_MAX_EDGE_BYTES,
  checks: CHECK_FILE_V2_MAX_CHECKS,
  inflatedBytes: CHECK_FILE_V2_MAX_INFLATED_BYTES,
});

export class CheckFileLinesError extends Error {
  /** @param {string} code one of LINES @param {string} detail never the file's content */
  constructor(code, detail) {
    super(detail);
    this.name = 'CheckFileLinesError';
    this.code = code;
  }
}

const refuse = (code, detail) => new CheckFileLinesError(code, detail);
const NEWLINE = 0x0a;
const TRAILER_PREFIX = new TextEncoder().encode(CHECK_FILE_V2_TRAILER_PREFIX);
const GZIP_MEMBER = [0x1f, 0x8b, 0x08];

/**
 * Read a version-2 check file. Options: `signal`, an AbortSignal (an abort
 * stops the read with LINES.aborted and releases the stream), and `caps`,
 * overriding LINE_CAPS (tests). The stream is released when the read ends,
 * fails, is aborted or the caller stops iterating.
 * @param {Blob} file
 */
export async function* readCheckFileLines(file, { signal, caps } = {}) {
  const limits = { ...LINE_CAPS, ...caps };
  throwIfAborted(signal);
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function' || typeof file.stream !== 'function') throw refuse(LINES.notCheckFile, 'no file');
  if (file.size > limits.compressedBytes) throw refuse(LINES.tooLarge, 'over the file cap');
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  throwIfAborted(signal);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) throw refuse(LINES.notGzip, 'not gzip');
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const release = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', release, { once: true });
  try {
    const chunks = (async function* inflated() {
      for (;;) {
        const step = await reader.read();
        // a cancelled read ends as done: an abort is not the end of the file
        throwIfAborted(signal);
        if (step.done) return;
        yield step.value;
      }
    })();
    yield* checkFileLinesOf(chunks, {
      caps: limits,
      signal,
      failed: (inflatedBytes, afterTrailer) => streamProblem(file, inflatedBytes, afterTrailer, signal),
      ended: (inflatedBytes) => endProblem(file, inflatedBytes),
    });
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw refuse(LINES.aborted, 'aborted');
}

/**
 * The lines of a version-2 file's inflated bytes, as readCheckFileLines yields
 * them, from any async iterable of byte chunks (exported so a test can split
 * the inflated bytes exactly where it wants). `failed(inflatedBytes,
 * afterTrailer)` names the problem when the chunks fail (anything they throw
 * but a CheckFileLinesError; LINES.truncated by default); `ended(inflatedBytes)`
 * may name one when they end cleanly after the trailer (none by default).
 * @param {AsyncIterable<Uint8Array>} chunks
 */
export async function* checkFileLinesOf(chunks, {
  caps, signal, failed = async () => LINES.truncated, ended = async () => null,
} = {}) {
  const limits = { ...LINE_CAPS, ...caps };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // the line being buffered: its pieces, their length, and (after the header) what it is
  let parts = [];
  let length = 0;
  let kind = null; // null until known, then 'trailer' or 'check'
  let phase = 'header'; // then 'body', then 'ended' once the trailer is whole
  let checks = 0;
  let inflated = 0;
  let trailer = null;

  const take = () => {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    parts = [];
    length = 0;
    return bytes;
  };
  const decoded = (bytes) => {
    try {
      return decoder.decode(bytes);
    } catch {
      return null;
    }
  };
  const startsAsTrailer = () => {
    let i = 0;
    for (const part of parts) {
      for (let j = 0; j < part.byteLength && i < TRAILER_PREFIX.length; j++, i++) if (part[j] !== TRAILER_PREFIX[i]) return false;
      if (i === TRAILER_PREFIX.length) return true;
    }
    return i === TRAILER_PREFIX.length;
  };
  // what a body line is, as soon as its first bytes (or its end) say so
  const settle = (whole) => {
    if (kind !== null || (!whole && length < TRAILER_PREFIX.length)) return;
    kind = length >= TRAILER_PREFIX.length && startsAsTrailer() ? 'trailer' : 'check';
    if (kind === 'check' && checks + 1 > limits.checks) throw refuse(LINES.checkCount, 'more checks than a check file may hold');
  };
  // false when the first line can no longer be a version-2 header
  const add = (piece) => {
    if (!piece.byteLength) return true;
    length += piece.byteLength;
    parts.push(piece);
    if (phase === 'header') return length <= limits.edgeBytes;
    settle(false);
    if (kind === 'trailer' && length > limits.edgeBytes) throw refuse(LINES.tooLarge, 'a trailer over its cap');
    if (length > limits.lineBytes) throw refuse(LINES.tooLarge, 'a line over its cap');
    return true;
  };
  // the header line, whole: its parse, or null when the file is to be read as version 1
  const headerOf = (bytes) => {
    const text = decoded(bytes);
    if (text === null) return null;
    const result = parseCheckFileHeader(text);
    if (result.ok) return result.header;
    if (result.problem === 'newer-version') throw refuse(LINES.newerVersion, result.detail);
    return null;
  };

  try {
    for await (const chunk of chunks) {
      inflated += chunk.byteLength;
      if (inflated > limits.inflatedBytes) throw refuse(LINES.tooLarge, 'over the inflated cap');
      let start = 0;
      while (start < chunk.byteLength) {
        if (phase === 'ended') throw refuse(LINES.trailingData, 'data after the trailer');
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 ? chunk.byteLength : newline;
        if (!add(chunk.subarray(start, end))) {
          yield { kind: 'v1' };
          return;
        }
        if (newline === -1) break;
        start = newline + 1;
        if (phase === 'header') {
          const header = headerOf(take());
          if (header === null) {
            yield { kind: 'v1' };
            return;
          }
          phase = 'body';
          yield { kind: 'v2', header };
          throwIfAborted(signal);
          continue;
        }
        settle(true);
        const text = decoded(take());
        if (text === null) throw refuse(LINES.invalidUtf8, 'a line that is not UTF-8');
        if (kind === 'trailer') {
          trailer = parseCheckFileTrailer(text, checks);
          phase = 'ended';
        } else {
          checks += 1;
          kind = null;
          yield text;
          throwIfAborted(signal);
        }
      }
    }
  } catch (error) {
    // the reader's own refusals, an abort included; anything else is the stream failing
    if (error instanceof CheckFileLinesError) throw error;
    throwIfAborted(signal);
    // a first line cut short may still be a version-1 document's: stage 1 says what is wrong with it
    if (phase === 'header') {
      yield { kind: 'v1' };
      return;
    }
    throw refuse(await failed(inflated, phase === 'ended'), 'the gzip stream failed');
  }
  // the end of the inflated bytes: a last line without its newline
  if (phase === 'header') {
    const header = length ? headerOf(take()) : null;
    if (header === null) {
      yield { kind: 'v1' };
      return;
    }
    throw refuse(LINES.truncated, 'no trailer');
  }
  if (phase === 'body') {
    // a trailer without its newline ends the file; one cut short (its closing brace is its last byte) is a truncation
    const isTrailer = kind === 'trailer' || (kind === null && length >= TRAILER_PREFIX.length && startsAsTrailer());
    const last = parts.at(-1);
    if (!isTrailer || last?.[last.byteLength - 1] !== 0x7d) throw refuse(LINES.truncated, 'no trailer');
    const text = decoded(take());
    if (text === null) throw refuse(LINES.invalidUtf8, 'a line that is not UTF-8');
    trailer = parseCheckFileTrailer(text, checks);
  }
  const problem = await ended(inflated);
  if (problem) throw refuse(problem, 'the file goes on after its gzip member');
  yield { trailer };
}

/** The last bytes of the file: a gzip member ends with its inflated size modulo 2^32, little-endian. */
async function endsWithSize(file, inflatedBytes) {
  if (file.size < 4) return false;
  const tail = new DataView(await file.slice(file.size - 4).arrayBuffer());
  return tail.getUint32(0, true) === inflatedBytes % 2 ** 32;
}

/**
 * Whether the compressed file holds a second gzip member right after the
 * first: the first member's last four bytes (its inflated size) followed by
 * gzip's magic and deflate method. Read only when the stream failed, which
 * the decompressor does at the end of a first member followed by anything.
 */
async function holdsSecondMember(file, inflatedBytes, signal) {
  const size = inflatedBytes % 2 ** 32;
  const pattern = [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff, ...GZIP_MEMBER];
  const reader = file.stream().getReader();
  // the last bytes of the previous chunk, so a match across two chunks is found
  let carry = new Uint8Array(0);
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) return false;
      const bytes = new Uint8Array(carry.byteLength + value.byteLength);
      bytes.set(carry);
      bytes.set(value, carry.byteLength);
      // each 0x1f with four bytes before it and the rest of the pattern after it
      for (let at = bytes.indexOf(GZIP_MEMBER[0], 4); at !== -1 && at + 2 < bytes.byteLength; at = bytes.indexOf(GZIP_MEMBER[0], at + 1)) {
        if (pattern.every((byte, j) => bytes[at - 4 + j] === byte)) return true;
      }
      carry = bytes.slice(Math.max(0, bytes.byteLength - (pattern.length - 1)));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function streamProblem(file, inflatedBytes, afterTrailer, signal) {
  if (await holdsSecondMember(file, inflatedBytes, signal).catch(() => false)) return LINES.secondMember;
  if (!afterTrailer) return LINES.truncated;
  // the member ends at the end of the file: its own check failed; otherwise something follows it
  return await endsWithSize(file, inflatedBytes).catch(() => false) ? LINES.corrupt : LINES.trailingData;
}

/**
 * A clean end that is not the end of one member: a decompressor that reads on
 * into a second member would give its bytes as more lines, so a file whose
 * last four bytes are not the size of everything inflated holds another one.
 */
async function endProblem(file, inflatedBytes) {
  return await endsWithSize(file, inflatedBytes) ? null : LINES.secondMember;
}
