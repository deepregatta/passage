import {
  CHECK_FILE_V2_MAX_CHECKS, CHECK_FILE_V2_MAX_COMPRESSED_BYTES, CHECK_FILE_V2_MAX_EDGE_BYTES, CHECK_FILE_V2_MAX_INFLATED_BYTES,
  CHECK_FILE_V2_MAX_LINE_BYTES, CHECK_FILE_V2_TRAILER_PREFIX, CHECK_FILE_V3_MAX_NAMES_LINE_BYTES, CHECK_FILE_V3_NAMES_PREFIX,
  parseCheckFileHeader, parseCheckFileNames, parseCheckFileTrailer,
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
// Yields, in order: { kind: 'v2', header } or { kind: 'v3', header } (the
// header parsed); for version 3, { names } (the names line's entries) or
// { namesUnreadable: true } (a names line refused or missing; the checks are
// still read); each check line's text (a string, without its newline); then
// { trailer: { ok: true, checks } } once the trailer holds and the file has
// ended cleanly after it.
// Or yields only { kind: 'v1' } and stops when the first line is not a
// version-2 header: the file may be a version-1 document (one line, with or
// without one final newline), and the caller hands the same File to the stage
// 1 path (lib/checkImport.js readCheckFile), which reads it afresh with its own
// caps (16 MB compressed, 64 MB inflated) and gives exactly its own outcomes.
// Every other problem, a trailer that does not hold included, throws a
// CheckFileLinesError whose code is one of LINES.
//
// Lines are provisional. Each check line is yielded as soon as it is whole,
// before the rest of the file, its gzip footer included, has been read: a
// damaged or cut-short file yields the lines before the damage and then
// throws. That is the design (a backup cut short must still restore the
// checks before the break), so each line must be proven alone by the caller,
// and the file is whole only when { trailer } arrives.
//
// The codes for a broken file (truncated, corrupt, trailing-data,
// second-member) are hints about how it is broken, read from what the
// decompressor handed over before it failed and from the file's bytes; the
// refusal itself is certain, the hint is not. A file missing only its gzip
// footer reads as trailing-data, a hostile file can make a corrupt member read
// as second-member, and a decompressor that read on into a second member whose
// first member inflates to a multiple of 4 GiB would pass the end check (each
// line is still proven alone).
//
// Framing decisions: a line is split on byte 0x0A before it is decoded (0x0A
// never occurs inside a UTF-8 sequence), and decoded piece by piece, each
// piece dropped once decoded, with a fatal decoder that keeps a byte order mark
// (which no JSON line may start with); a sequence the newline cuts is invalid.
// The reader thus holds a line's text and the chunk in hand, never the line's
// bytes as well. A carriage return before the newline is part of the line: the
// engine refuses it, since Passage never writes one and gzip keeps text tools
// from adding one, so a carriage return means the text was rewritten by
// something else. The trailer may end with or without its newline; nothing
// else may follow.

/** Why a version-2 file was not read to its end; the caller says each in plain words. */
export const LINES = Object.freeze({
  notCheckFile: 'not-check-file', // no file
  unreadable: 'unreadable', // this browser could not read the file's bytes
  notGzip: 'not-gzip', // the first bytes are not gzip's
  tooLarge: 'too-large', // the file, a line, the trailer or all lines inflated over a cap
  truncated: 'truncated', // hint: the gzip stream failed or ended before the trailer
  corrupt: 'corrupt', // hint: the gzip stream failed its own check after the trailer
  trailingData: 'trailing-data', // hint: bytes after the trailer, or after the gzip member that are not a member
  secondMember: 'second-member', // hint: a second gzip member
  invalidUtf8: 'invalid-utf8', // a line that is not strict UTF-8
  newerVersion: 'newer-version', // a header of a format version above 2
  trailer: 'trailer', // a trailer that is not one, or counts other than the check lines read
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
  /** a version-3 file's names line, its newline not counted */
  namesBytes: CHECK_FILE_V3_MAX_NAMES_LINE_BYTES,
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
const NAMES_PREFIX = new TextEncoder().encode(CHECK_FILE_V3_NAMES_PREFIX);
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
  let magic;
  try {
    magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  } catch {
    throw refuse(LINES.unreadable, 'the file could not be read');
  }
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
 * `probe`, for tests, is told after each piece what the reader holds: the
 * bytes it keeps (at most the first seven of a line, to know a trailer) and
 * the characters of the line decoded so far.
 * @param {AsyncIterable<Uint8Array>} chunks
 */
export async function* checkFileLinesOf(chunks, {
  caps, signal, failed = async () => LINES.truncated, ended = async () => null, probe = null,
} = {}) {
  const limits = { ...LINE_CAPS, ...caps };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // the line being read: its byte count, its first bytes, its text so far, and (after the header) what it is
  let length = 0;
  // the first bytes of a line: seven tell a trailer, nine a names line (only those are kept)
  const prefix = new Uint8Array(NAMES_PREFIX.length);
  let prefixLength = 0;
  let text = '';
  let kind = null; // null until known, then 'trailer' or 'check'
  let phase = 'header'; // then 'names' (version 3 only), then 'body', then 'ended' once the trailer is whole
  let namesLine = null; // in the names phase: null until its first bytes say, then true (the names line) or false (none: another line)
  let namesBroken = false; // the names line is not UTF-8 or is over its cap: it is unreadable, and its bytes are no longer decoded
  let notice = null; // something to say before the line in hand: the names line is missing
  let checks = 0;
  let inflated = 0;
  let trailer = null;

  const startsAsTrailer = () => prefixLength >= TRAILER_PREFIX.length && TRAILER_PREFIX.every((byte, i) => prefix[i] === byte);
  const startsAsNames = () => prefixLength >= NAMES_PREFIX.length && NAMES_PREFIX.every((byte, i) => prefix[i] === byte);
  // the bytes so far could still begin a names line
  const couldBeNames = () => NAMES_PREFIX.subarray(0, Math.min(prefixLength, NAMES_PREFIX.length)).every((byte, i) => prefix[i] === byte);
  // in the names phase: the line in hand is the names line, or the names line is missing and this line is read as what it is
  const decideNames = (whole) => {
    if (namesLine !== null || (!whole && prefixLength < NAMES_PREFIX.length)) return;
    namesLine = startsAsNames();
    if (namesLine) return;
    notice = { namesUnreadable: true };
    phase = 'body';
    if (namesBroken) throw refuse(LINES.invalidUtf8, 'a line that is not UTF-8');
  };
  // what a body line is, as soon as its first bytes (or its end) say so
  const settle = (whole) => {
    if (kind !== null || (!whole && prefixLength < TRAILER_PREFIX.length)) return;
    kind = startsAsTrailer() ? 'trailer' : 'check';
    if (kind === 'check' && checks + 1 > limits.checks) throw refuse(LINES.checkCount, 'more checks than a check file may hold');
  };
  // false when the first line can no longer be a version-2 header
  const add = (piece) => {
    if (!piece.byteLength) return true;
    length += piece.byteLength;
    const wanted = phase === 'names' ? NAMES_PREFIX.length : TRAILER_PREFIX.length;
    if (prefixLength < wanted) {
      const n = Math.min(wanted - prefixLength, piece.byteLength);
      prefix.set(piece.subarray(0, n), prefixLength);
      prefixLength += n;
    }
    if (phase === 'names') decideNames(false);
    if (phase === 'header') {
      if (length > limits.edgeBytes) return false;
    } else if (phase === 'names') {
      // a names line over its own cap is dropped unread: its bytes are only counted (the inflated cap
      // still bounds them), the names are unreadable, and the checks after it are read as usual
      if (length > limits.namesBytes && !namesBroken) {
        namesBroken = true;
        text = '';
      }
    } else {
      settle(false);
      if (kind === 'trailer' && length > limits.edgeBytes) throw refuse(LINES.tooLarge, 'a trailer over its cap');
      if (length > limits.lineBytes) throw refuse(LINES.tooLarge, 'a line over its cap');
    }
    // decoded now and not kept: the line is held once, as text
    if (!namesBroken) {
      try {
        text += decoder.decode(piece, { stream: true });
      } catch {
        if (phase === 'header') return false;
        if (phase !== 'names') throw refuse(LINES.invalidUtf8, 'a line that is not UTF-8');
        // a names line that is not UTF-8 is unreadable; the checks after it are still read
        namesBroken = true;
        text = '';
      }
    }
    probe?.({ heldBytes: prefixLength, heldChars: text.length });
    return true;
  };
  // the whole line's text (a sequence its end cuts is invalid), or null; the reader then holds nothing of it
  const take = () => {
    let line = null;
    try {
      line = text + decoder.decode();
    } catch {
      // a fatal decoder starts afresh after an error
    }
    text = '';
    length = 0;
    prefixLength = 0;
    return line;
  };
  const textOf = () => {
    const line = take();
    if (line === null) throw refuse(LINES.invalidUtf8, 'a line that is not UTF-8');
    return line;
  };
  // the header line, whole: { header, version }, or null when the file is to be read as version 1
  const headerOf = () => {
    const line = take();
    if (line === null) return null;
    const result = parseCheckFileHeader(line);
    if (result.ok) return { header: result.header, version: result.version };
    if (result.problem === 'newer-version') throw refuse(LINES.newerVersion, result.detail);
    return null;
  };
  // the names line, whole: what the reader says of it
  const namesOf = () => {
    const line = take();
    const broken = namesBroken || line === null;
    namesBroken = false;
    namesLine = null;
    phase = 'body';
    const result = broken ? null : parseCheckFileNames(line);
    return result?.ok ? { names: result.names } : { namesUnreadable: true };
  };
  const endOf = (line) => {
    const result = parseCheckFileTrailer(line, checks);
    if (!result.ok) throw refuse(result.problem === 'check-count' ? LINES.checkCount : LINES.trailer, result.detail);
    return result;
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
        if (notice) {
          yield notice;
          notice = null;
          throwIfAborted(signal);
        }
        if (newline === -1) break;
        start = newline + 1;
        if (phase === 'header') {
          const read = headerOf();
          if (read === null) {
            yield { kind: 'v1' };
            return;
          }
          // version 3: exactly one names line comes first
          phase = read.version === 3 ? 'names' : 'body';
          yield { kind: read.version === 3 ? 'v3' : 'v2', header: read.header };
          throwIfAborted(signal);
          continue;
        }
        if (phase === 'names') {
          decideNames(true);
          if (notice) {
            yield notice;
            notice = null;
            throwIfAborted(signal);
          }
        }
        if (phase === 'names') {
          yield namesOf();
          throwIfAborted(signal);
          continue;
        }
        settle(true);
        if (kind === 'trailer') {
          trailer = endOf(textOf());
          phase = 'ended';
        } else {
          checks += 1;
          kind = null;
          yield textOf();
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
    const header = length ? headerOf() : null;
    if (header === null) {
      yield { kind: 'v1' };
      return;
    }
    throw refuse(LINES.truncated, 'no trailer');
  }
  if (phase === 'names') {
    // nothing after the header, or a names line cut short
    if (!length || namesLine === true || couldBeNames()) throw refuse(LINES.truncated, 'no trailer');
    // a last line that is not a names line (a trailer without its newline): the names line is missing
    namesLine = false;
    phase = 'body';
    yield { namesUnreadable: true };
  }
  if (phase === 'body') {
    // a trailer without its newline ends the file; one cut short (its closing brace is not its last character) is a truncation
    const isTrailer = kind === 'trailer' || (kind === null && startsAsTrailer());
    if (!isTrailer) throw refuse(LINES.truncated, 'no trailer');
    const line = textOf();
    if (!line.endsWith('}')) throw refuse(LINES.truncated, 'no trailer');
    trailer = endOf(line);
  }
  const problem = await ended(inflated);
  if (problem) throw refuse(problem, 'the file goes on after its gzip member');
  yield { trailer };
}

/** The four bytes a gzip member ends with for `inflatedBytes` of content: the size modulo 2^32, little-endian. */
export function memberSizeBytes(inflatedBytes) {
  const size = inflatedBytes % 2 ** 32;
  return [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff];
}

/** Whether the file's last four bytes are the member size of `inflatedBytes` (exported for tests). */
export async function endsWithSize(file, inflatedBytes) {
  if (file.size < 4) return false;
  const tail = new Uint8Array(await file.slice(file.size - 4).arrayBuffer());
  return memberSizeBytes(inflatedBytes).every((byte, i) => tail[i] === byte);
}

/**
 * Whether the compressed file holds a second gzip member right after the
 * first: the first member's last four bytes (its inflated size) followed by
 * gzip's magic and deflate method. Read only when the stream failed, which
 * the decompressor does at the end of a first member followed by anything
 * (exported for tests).
 */
export async function holdsSecondMember(file, inflatedBytes, signal) {
  const pattern = [...memberSizeBytes(inflatedBytes), ...GZIP_MEMBER];
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
  const second = await holdsSecondMember(file, inflatedBytes, signal).catch(() => false);
  // an abort during the scan is the caller's, not a property of the file
  throwIfAborted(signal);
  if (second) return LINES.secondMember;
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
  let whole;
  try {
    whole = await endsWithSize(file, inflatedBytes);
  } catch {
    throw refuse(LINES.unreadable, 'the end of the file could not be read');
  }
  return whole ? null : LINES.secondMember;
}
