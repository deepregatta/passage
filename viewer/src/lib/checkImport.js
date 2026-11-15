import {
  CHECK_FILE_MAX_COMPRESSED_BYTES, CHECK_FILE_MAX_TEXT_BYTES, CHECK_FILE_NAMES, canonicalJson, parseCheckFile,
} from '@deepweather/engine';
import { holdsPolarData } from './polarSafetyNet.js';
import { checkFileValidators } from './generated/checkFileValidators.js';
import { IMPORT_MARKER, localSnapshots } from './localSnapshots.js';
import { requestPersistence } from './storagePersistence.js';
import { IMPORT } from './checkImportOutcomes.js';

// Import one check from a file (2026-11-15, stage 1 of export and import).
// The file is content this app did not write, so it is treated as hostile and
// refused at the first failure, with nothing written:
//   size (16 MB compressed) → gzip, inflated as a stream and stopped at 64 MB →
//   strict UTF-8 → the engine's parseCheckFile (JSON, format and version, one
//   check, file names, key policy and bounds, manifest fields and artifacts,
//   times, each file's contract through precompiled validators, the identity)
//   → the polar safety net (lib/polarSafetyNet.js) → not the id of a check
//   Passage serves (the served ids this page already read; no request) → not
//   already here.
// Then the file texts are stored exactly as given, with an imported.json
// marker, in one all-or-nothing writeAll. Nothing is uploaded and no
// analytics event is sent. Messages and logs never quote the file's content.

// the same caps the export holds itself to (engine/src/checkFile.ts)
export const MAX_FILE_BYTES = CHECK_FILE_MAX_COMPRESSED_BYTES;
export const MAX_TEXT_BYTES = CHECK_FILE_MAX_TEXT_BYTES;

export { IMPORT, canImportCheckFile } from './checkImportOutcomes.js';

class Refused extends Error {
  constructor(outcome, detail) {
    super(detail);
    this.outcome = outcome;
  }
}

/** The file's bytes inflated as a stream, stopping (never inflating further) at MAX_TEXT_BYTES.
 * The compressed bytes, at most MAX_FILE_BYTES, are read whole first. */
async function inflate(file) {
  const compressed = new Uint8Array(await file.arrayBuffer());
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Refused(IMPORT.notCheckFile, 'not gzip');
  const source = new ReadableStream({ start(controller) { controller.enqueue(compressed); controller.close(); } });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_TEXT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Refused(IMPORT.tooLarge, 'over the inflated cap');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(IMPORT.damaged, 'corrupt or truncated gzip');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function storageFull(error) {
  for (let e = error; e; e = e.cause) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  }
  return false;
}

/** Whether the check stored here under this id is this check: 'same', 'different' or null when none is. */
async function existing(check) {
  if (!await localSnapshots.exists(check.snapshotId)) return null;
  const text = await localSnapshots.read(check.snapshotId, 'decision-inputs.json');
  if (typeof text !== 'string') return 'different';
  try {
    return canonicalJson(JSON.parse(text)) === canonicalJson(check.decisionInputs) ? 'same' : 'different';
  } catch {
    return 'different';
  }
}

/** The check in the file, proven, or the reason it is refused (a Refused). */
export async function readCheckFile(file, { nowMs = Date.now(), servedIds = null } = {}) {
  if (!file || typeof file.size !== 'number') throw new Refused(IMPORT.notCheckFile, 'no file');
  if (file.size > MAX_FILE_BYTES) throw new Refused(IMPORT.tooLarge, 'over the file cap');
  const bytes = await inflate(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Refused(IMPORT.damaged, 'not UTF-8');
  }
  const result = parseCheckFile(text, { nowMs, boundTime: true, validateFile: (name, value) => checkFileValidators[name]?.(value) === true });
  if (!result.ok) {
    const outcome = { 'not-check-file': IMPORT.notCheckFile, 'newer-version': IMPORT.newer, 'check-count': IMPORT.count, 'future-time': IMPORT.future }[result.problem] ?? IMPORT.damaged;
    throw new Refused(outcome, result.detail);
  }
  const { check } = result;
  // the safety net over every file's own text, the document's and each file's decoded values
  if (holdsPolarData({ texts: [...Object.values(check.files), text], values: Object.values(check.parsed) })) throw new Refused(IMPORT.polar, 'a no-polar-data rule matches');
  // the ids this page read from the served catalogue (the example and hidden ones included);
  // no request is made here, so a page that loaded online can import offline
  if (!(servedIds instanceof Set)) throw new Refused(IMPORT.offline, 'the list of served checks was never read in this page');
  if (servedIds.has(check.snapshotId)) throw new Refused(IMPORT.served, 'the id of a served check');
  return { check, importedAt: new Date(nowMs).toISOString() };
}

/** The records of one imported check: its files as given, the marker, the manifest last. */
function importRecords(check, importedAt) {
  const marker = JSON.stringify({ imported_at: importedAt, exported_at: check.exportedAt, exported_by: check.exportedBy }, null, 2);
  const files = CHECK_FILE_NAMES.filter((name) => name !== 'snapshot.json' && Object.hasOwn(check.files, name))
    .map((filename) => ({ filename, content: check.files[filename] }));
  return [...files, { filename: IMPORT_MARKER, content: marker }, { filename: 'snapshot.json', content: check.files['snapshot.json'] }];
}

/**
 * Import one check from a .json.gz file. Options: `servedIds`, the ids of the
 * checks Passage serves as this page read them (useApp's servedIds; without
 * them the import is refused for now), and `nowMs`. Resolves { outcome } (IMPORT), with
 * the check's id and departure on IMPORT.imported and IMPORT.alreadyHere.
 * Never rejects: every failure is an outcome.
 */
export async function importCheckFile(file, options = {}) {
  let check, importedAt;
  try {
    ({ check, importedAt } = await readCheckFile(file, options));
  } catch (error) {
    const outcome = error instanceof Refused ? error.outcome : IMPORT.damaged;
    // the reason only: never the file's content, names or positions
    console.error(`Passage did not import this file (${outcome}): ${error instanceof Refused ? error.message : error?.name ?? 'error'}`);
    return { outcome };
  }
  const done = (outcome) => ({ outcome, snapshotId: check.snapshotId, departureUtc: check.departureUtc });
  const here = await existing(check);
  if (here === 'same') return done(IMPORT.alreadyHere);
  if (here === 'different') return { outcome: IMPORT.conflict };
  try {
    // one transaction: the files, the marker and the manifest are all stored, or none is
    await localSnapshots.writeAll(check.snapshotId, importRecords(check, importedAt));
  } catch (error) {
    // the same id stored meanwhile (another tab): decided as above
    const meanwhile = await existing(check).catch(() => null);
    if (meanwhile === 'same') return done(IMPORT.alreadyHere);
    if (meanwhile === 'different') return { outcome: IMPORT.conflict };
    console.error(`Passage could not store an imported check: ${storageFull(error) ? 'storage full' : error?.name ?? 'error'}`);
    return { outcome: IMPORT.storage };
  }
  requestPersistence();
  return done(IMPORT.imported);
}
