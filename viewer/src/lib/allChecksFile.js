import {
  CHECK_FILE_FUTURE_MS, CHECK_FILE_NAMES, allChecksFileName, checkFileEntryLine, checkFileHeaderLine, checkFileTrailerLine, checkHex, fnv1a64Hex, parseCheckEntry,
} from '@deepweather/engine';
import { CHECK_FILE_EXPORTED_BY } from './checkFile.js';
import { LINE_CAPS, readCheckFileLines } from './checkFileLines.js';
import { holdsPolarData } from './polarSafetyNet.js';
import { localSnapshots } from './localSnapshots.js';

// Save every check this browser holds to one file: the check file, version 2
// (engine/src/checkFile.ts), gzipped by the browser's own CompressionStream
// (2026-11-15, stage 2; a library only: no control calls it yet). The checks
// are read and written one at a time, newest first, so the file holds the
// checks most likely needed when a cap or a failure cuts it short, and no two
// checks' texts are ever in memory together. Each check is proven as the
// import will prove it (parseCheckEntry with the contracts, no time bound,
// exactly as the single-check export after its re-read) and passed through the
// no-polar-data safety net; one that fails is left out and counted, and never
// stops the others. The finished file is read back through the stream reader
// before it is offered. Nothing is sent anywhere and the saved checks are only
// read. The core takes its dependencies (no DOM), so it could run in a Worker
// as lib/scanWorkerHandler.js does; it runs on the main thread for now.

/** What became of the backup. */
export const ALL_CHECKS = Object.freeze({
  made: 'made', // the file: { blob, name, included, counts }
  empty: 'empty', // no check could be written ({ counts } says why)
  stopped: 'stopped', // the caller aborted; nothing is kept
  failed: 'failed', // the file could not be made or did not read back as written ({ reason })
});

/** Why a check was left out (counts), besides `included`; futureDated counts included checks the import will refuse until their time. */
const SKIPS = ['legacy', 'damaged', 'unreadable', 'polar', 'tooLarge', 'overCap'];
const COUNTS = ['included', ...SKIPS, 'futureDated'];

/**
 * How much room to keep under the compressed cap: what the compressor may
 * still hold of the lines written so far, and the gzip footer. A check is
 * written only when the bytes the compressor has handed over, this margin and
 * the check's whole line (a deflate stream never grows a line by more than
 * about 0.03 % plus a few bytes) all fit under the cap. The estimate can still
 * fall short when a compressor hands its output over late, so the finished
 * size is checked again: past the cap, the file is made again without its
 * oldest checks (counted as over the cap), and only when not even one check
 * fits is it refused. `caps.compressorMargin` replaces the margin in tests.
 */
const COMPRESSOR_MARGIN = 1024 * 1024;
const deflateBound = (bytes) => bytes + Math.ceil(bytes / 16_000) * 5 + 64;
const TRAILER_BYTES = new TextEncoder().encode(checkFileTrailerLine(1000)).byteLength;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const savedAt = (entry) => {
  const at = Date.parse(entry.created_at);
  return Number.isFinite(at) ? at : -Infinity;
};

/** Newest first (the check's own created_at, descending), then by id, so the order never depends on the store. */
export function backupOrder(entries) {
  return [...entries].sort((a, b) => savedAt(b) - savedAt(a) || (a.snapshot_id < b.snapshot_id ? -1 : a.snapshot_id > b.snapshot_id ? 1 : 0));
}

/** One check's files as stored ({ files }), or why it is left out ({ skip }): only the files its manifest names, never a marker. */
async function readCheck(store, snapshotId) {
  const manifestText = await store.read(snapshotId, 'snapshot.json');
  if (manifestText === null) return { skip: 'unreadable' };
  if (typeof manifestText !== 'string') return { skip: 'damaged' };
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { skip: 'damaged' };
  }
  if (!isRecord(manifest) || !isRecord(manifest.artifacts)) return { skip: 'damaged' };
  const named = Object.values(manifest.artifacts);
  // a file a check file cannot hold is never left out silently: the check is
  if (named.some((name) => typeof name !== 'string' || !CHECK_FILE_NAMES.includes(name))) return { skip: 'damaged' };
  const files = { 'snapshot.json': manifestText };
  for (const name of CHECK_FILE_NAMES) {
    if (name === 'snapshot.json' || !named.includes(name)) continue;
    const text = await store.read(snapshotId, name);
    if (text === null) return { skip: 'unreadable' };
    if (typeof text !== 'string') return { skip: 'damaged' };
    files[name] = text;
  }
  return { files };
}

/**
 * The line of one check, proven, as UTF-8 bytes, or why it is left out. The
 * texts, parses and canonical JSON are dropped when this returns.
 */
function lineOf(snapshotId, files, { validateFile, nowMs, lineBytes }) {
  const proven = parseCheckEntry({ snapshot_id: snapshotId, files }, { nowMs, boundTime: false, validateFile });
  if (!proven.ok) return { skip: 'damaged' };
  const { check } = proven;
  const line = checkFileEntryLine({ snapshotId, files });
  const canonicalTexts = new Map([[check.decisionInputs, check.decisionInputsCanonical]]);
  if (holdsPolarData({ texts: [...Object.values(files), line], values: Object.values(check.parsed), canonicalTexts })) return { skip: 'polar' };
  const bytes = new TextEncoder().encode(line);
  // the cap counts the line without its newline
  if (bytes.byteLength - 1 > lineBytes) return { skip: 'tooLarge' };
  return { bytes, digest: fnv1a64Hex(line.slice(0, -1)), futureDated: Date.parse(check.createdAt) > nowMs + CHECK_FILE_FUTURE_MS };
}

/**
 * Make the backup with the given dependencies (the Worker-ready core).
 * deps: { store: { list, read }, loadValidators: () => Promise<validators>,
 * compressor: () => { writable, readable } (a gzip transform), Blob, pause:
 * () => Promise (a turn of the event loop) }. Options as prepareAllChecksFile.
 */
export async function makeAllChecksFile(deps, options = {}) {
  const cap = { ...LINE_CAPS, ...options.caps }.compressedBytes;
  let maxIncluded = Infinity;
  for (;;) {
    const pass = await makePass(deps, options, maxIncluded);
    if (!pass.overshoot) return pass;
    const { lineSizes, size } = pass.overshoot;
    if (lineSizes.length <= 1) return { outcome: ALL_CHECKS.failed, reason: 'tooLarge' };
    // the newest checks that should fit, estimated from this pass's own ratio; always at least one fewer
    const ratio = size / lineSizes.reduce((sum, bytes) => sum + bytes, 1);
    let fits = 0;
    let estimate = 1024;
    while (fits < lineSizes.length - 1 && estimate + lineSizes[fits] * ratio <= cap * 0.98) estimate += lineSizes[fits++] * ratio;
    maxIncluded = Math.max(1, Math.min(fits, lineSizes.length - 1));
  }
}

/** One pass at the file, holding at most `maxIncluded` checks; { overshoot } when the finished file passes the compressed cap. */
async function makePass(deps, { signal, onProgress, caps, nowMs = Date.now() }, maxIncluded) {
  const limits = { ...LINE_CAPS, ...caps };
  const margin = limits.compressorMargin ?? COMPRESSOR_MARGIN;
  const { store, loadValidators, compressor, Blob: BlobOf, pause } = deps;
  const counts = Object.fromEntries(COUNTS.map((key) => [key, 0]));
  const lineSizes = [];
  const included = [];
  const aborted = () => signal?.aborted === true;
  if (aborted()) return { outcome: ALL_CHECKS.stopped };

  const entries = await store.list();
  const candidates = [];
  for (const entry of entries) {
    if (checkHex(entry?.snapshot_id) === null) counts.legacy += 1;
    else candidates.push(entry);
  }
  const ordered = backupOrder(candidates);
  const total = ordered.length;
  if (!total) return { outcome: ALL_CHECKS.empty, counts };
  const { checkFileValidators } = await loadValidators();
  const validateFile = (name, value) => checkFileValidators[name]?.(value) === true;

  const exportedAt = new Date(nowMs).toISOString();
  const stream = compressor();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let pending = [];
  let handed = 0;
  let folded = new BlobOf([]);
  // the compressor's output, read as it comes and folded into the Blob after each check
  const draining = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending.push(value);
      handed += value.byteLength;
    }
  })();
  draining.catch(() => {});
  const fold = () => {
    if (!pending.length) return;
    folded = new BlobOf([folded, ...pending]);
    pending = [];
  };
  const discard = async () => {
    await writer.abort().catch(() => {});
    await reader.cancel().catch(() => {});
    pending = [];
    folded = null;
  };

  const digests = [];
  let inflated = 0;
  const write = async (bytes) => {
    inflated += bytes.byteLength;
    await writer.write(bytes);
  };
  try {
    await write(new TextEncoder().encode(checkFileHeaderLine({ exportedAt, exportedBy: CHECK_FILE_EXPORTED_BY })));
    for (let index = 0; index < total; index++) {
      if (aborted()) {
        await discard();
        return { outcome: ALL_CHECKS.stopped };
      }
      const { snapshot_id: snapshotId } = ordered[index];
      const read = await readCheck(store, snapshotId);
      const made = read.skip ? read : lineOf(snapshotId, read.files, { validateFile, nowMs, lineBytes: limits.lineBytes });
      if (made.skip) {
        counts[made.skip] += 1;
      } else {
        // what the compressor has ready is read first, so the estimate counts it
        await pause();
        // stop before any cap: this check and every later one are left out
        const over = included.length + 1 > Math.min(limits.checks, maxIncluded)
          || inflated + made.bytes.byteLength + TRAILER_BYTES > limits.inflatedBytes
          || handed + margin + deflateBound(made.bytes.byteLength) + TRAILER_BYTES > limits.compressedBytes;
        if (over) {
          counts.overCap += total - index;
          onProgress?.({ index: total, total });
          break;
        }
        await write(made.bytes);
        digests.push(made.digest);
        lineSizes.push(made.bytes.byteLength);
        included.push(snapshotId);
        counts.included += 1;
        if (made.futureDated) counts.futureDated += 1;
      }
      onProgress?.({ index: index + 1, total });
      // a turn of the event loop: the page stays responsive and the compressor's output is read
      await pause();
      fold();
    }
    if (aborted()) {
      await discard();
      return { outcome: ALL_CHECKS.stopped };
    }
    if (!included.length) {
      await discard();
      return { outcome: ALL_CHECKS.empty, counts };
    }
    await write(new TextEncoder().encode(checkFileTrailerLine(included.length)));
    await writer.close();
    await draining;
    fold();
  } catch (error) {
    await discard();
    if (aborted()) return { outcome: ALL_CHECKS.stopped };
    console.error(`Passage could not make the backup file: ${error?.name ?? 'error'}`);
    return { outcome: ALL_CHECKS.failed, reason: 'compression' };
  }
  const blob = new BlobOf([folded], { type: 'application/gzip' });
  folded = null;
  if (blob.size > limits.compressedBytes) return { overshoot: { lineSizes, size: blob.size } };
  const verified = await verify(blob, { exportedAt, digests, signal, caps: limits });
  if (verified !== true) return verified === 'stopped' ? { outcome: ALL_CHECKS.stopped } : { outcome: ALL_CHECKS.failed, reason: 'verify' };
  return { outcome: ALL_CHECKS.made, blob, name: allChecksFileName(exportedAt), exportedAt, included, counts };
}

/**
 * Read the finished file back as the import will, through the stream reader:
 * the same header, the same number of lines with the same FNV-1a 64 each as
 * written, and a trailer that holds. Not a second proof of each check, which
 * was proven before it was written. True, 'stopped', or false.
 */
async function verify(blob, { exportedAt, digests, signal, caps }) {
  let lines = 0;
  try {
    for await (const item of readCheckFileLines(blob, { signal, caps })) {
      if (typeof item === 'string') {
        if (lines >= digests.length || fnv1a64Hex(item) !== digests[lines]) return false;
        lines += 1;
      } else if (item.kind === 'v1') {
        return false;
      } else if (item.kind === 'v2') {
        if (item.header.exportedAt !== exportedAt || item.header.exportedBy !== CHECK_FILE_EXPORTED_BY) return false;
      } else if (item.trailer) {
        return item.trailer.checks === digests.length && lines === digests.length;
      }
    }
  } catch (error) {
    if (signal?.aborted) return 'stopped';
    console.error(`Passage could not read back the backup file it made: ${error?.code ?? error?.name ?? 'error'}`);
    return false;
  }
  return false;
}

const browserDeps = () => ({
  store: localSnapshots,
  loadValidators: () => import('./generated/checkFileValidators.js'),
  compressor: () => new CompressionStream('gzip'),
  Blob,
  pause: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
});

/**
 * Make one file of every check saved or imported in this browser. Options:
 * `signal` (an abort gives ALL_CHECKS.stopped and keeps nothing),
 * `onProgress({ index, total })` after each check, `caps` (LINE_CAPS, smaller
 * in tests), `nowMs`. Resolves { outcome: made, blob, name, exportedAt (the
 * header's exported_at, the instant in the name), included (ids, in
 * file order), counts: { included, legacy, damaged, unreadable, polar,
 * tooLarge, overCap, futureDated } }, { outcome: empty, counts }, { outcome:
 * stopped } or { outcome: failed, reason }. futureDated counts included checks
 * saved more than a day after the export time (a device clock ahead): they
 * are written, and an import refuses them until that time. Legacy identity-1 checks cannot be written and
 * are counted; a check that is damaged, unreadable, holds polar-shaped data
 * or is too large for a line is left out and counted; when the next check
 * would pass a cap, it and every later (older) one are counted as overCap.
 */
export function prepareAllChecksFile(options = {}) {
  return makeAllChecksFile(browserDeps(), options);
}
