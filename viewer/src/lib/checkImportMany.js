import { parseCheckFileEntryLine } from '@deepweather/engine';
import { checkFileValidators } from './generated/checkFileValidators.js';
import { holdsPolarData } from './polarSafetyNet.js';
import { IMPORT_MARKER, localSnapshots } from './localSnapshots.js';
import { requestPersistence } from './storagePersistence.js';
import { IMPORT } from './checkImportOutcomes.js';
import { existing, importCheckFile, importRecords, storageFull } from './checkImport.js';
import { LINES, CheckFileLinesError, readCheckFileLines } from './checkFileLines.js';

// Import many checks from one file (2026-11-15, stage 2; a library only: no
// control calls it yet). A version-2 file (engine/src/checkFile.ts) is read as
// a stream of lines (lib/checkFileLines.js) and its checks are settled one at a
// time, each exactly as stage 1 settles its one check: proven alone
// (parseCheckFileEntryLine: the digest, then parseCheckEntry with the contracts
// and the time bound), the polar safety net, not a check Passage serves, the
// canonical already-here or conflict rule, then one all-or-nothing writeAll of
// its files, the imported.json marker (carrying the file's exported_at and
// exported_by) and the manifest. A refused check never stops the others. Lines
// are provisional (the reader yields each before the file proves whole), so a
// file that breaks part-way keeps the checks stored before the break and says
// it is incomplete. A version-1 file goes to the stage 1 import unchanged.
// Nothing is uploaded, no request is made and no analytics event is sent;
// logs never quote the file's content.

/** How a version-2 import ended. */
export const IMPORT_END = Object.freeze({
  complete: 'complete', // the trailer was read and every line settled
  incomplete: 'incomplete', // the file broke after some lines (hint: the reader's code)
  storage: 'storage', // storage failed: the import stopped there, every stored check is whole
  stopped: 'stopped', // the caller aborted between two checks
  refused: 'refused', // nothing was read past the header (refusal: an IMPORT outcome)
});

const OUTCOMES = ['imported', 'already', 'repeated', 'damaged', 'futureTime', 'polar', 'served', 'conflict', 'tooLarge'];
/** The outcomes that settle an id for the rest of the file; a refusal of one copy does not. */
const SETTLED = new Set(['imported', 'already', 'conflict', 'served']);
const validateFile = (name, value) => checkFileValidators[name]?.(value) === true;
// a check line as checkFileEntryLine writes it starts with its id: read before any parse, to tell a repeat
const LINE_ID = /^\{"snapshot_id":"(snapshot_v2_[0-9a-f]{16})"/;

/** What a reader refusal before the header means, as stage 1 would put it (a file that is not gzip is "not a check file" whatever its size). */
const BEFORE_HEADER = {
  [LINES.notCheckFile]: IMPORT.notCheckFile,
  [LINES.notGzip]: IMPORT.notCheckFile,
  [LINES.tooLarge]: IMPORT.tooLarge,
  [LINES.unreadable]: IMPORT.damaged,
  [LINES.newerVersion]: IMPORT.newer,
};

const turn = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * A string of its own with the same text. A short string cut from a line (a
 * regular expression's capture, slice, or a value JSON.parse read) can be a
 * view into the whole line in V8, so keeping it keeps the line: an id kept
 * for the rest of the import would hold every line's megabytes.
 */
const ownCopy = (text) => text.split('').join('');

/**
 * Whether the stored check under this line's id holds exactly the line's
 * decision inputs text: then it is the same check (the id is their hash), and
 * nothing need be proven since nothing is written.
 */
async function storedTextMatches(snapshotId, line) {
  if (!await localSnapshots.exists(snapshotId)) return false;
  const stored = await localSnapshots.read(snapshotId, 'decision-inputs.json');
  if (typeof stored !== 'string') return false;
  let given;
  try {
    given = JSON.parse(line)?.files?.['decision-inputs.json'];
  } catch {
    return false;
  }
  return given === stored;
}

/**
 * Settle one check line: an outcome key, with the stored id when imported, or
 * { stop: 'storage' }. Its parse (the 10 MB canonical text included) is
 * dropped when this returns: nothing of it outlives the line.
 */
async function settleLine(line, { header, servedIds, nowMs, importedAt }) {
  const result = parseCheckFileEntryLine(line, { nowMs, boundTime: true, validateFile });
  if (!result.ok) return { outcome: result.reason === 'future-time' ? 'futureTime' : 'damaged' };
  const check = { ...result.check, exportedAt: header.exportedAt, exportedBy: header.exportedBy };
  const canonicalTexts = new Map([[check.decisionInputs, check.decisionInputsCanonical]]);
  if (holdsPolarData({ texts: [...Object.values(check.files), line], values: Object.values(check.parsed), canonicalTexts })) return { outcome: 'polar' };
  if (servedIds.has(check.snapshotId)) return { outcome: 'served' };
  const here = await existing(check);
  if (here === 'same') return { outcome: 'already' };
  if (here === 'different') return { outcome: 'conflict' };
  try {
    // one transaction: the files, the marker and the manifest are all stored, or none is
    await localSnapshots.writeAll(check.snapshotId, importRecords(check, importedAt));
  } catch (error) {
    // the same id stored meanwhile (another tab): decided as above
    const meanwhile = await existing(check).catch(() => null);
    if (meanwhile === 'same') return { outcome: 'already' };
    if (meanwhile === 'different') return { outcome: 'conflict' };
    const full = storageFull(error);
    console.error(`Passage could not store an imported check: ${full ? 'storage full' : error?.name ?? 'error'}`);
    return { stop: IMPORT_END.storage, full };
  }
  return { outcome: 'imported', snapshotId: check.snapshotId, passageId: typeof check.decisionInputs.route?.passage_id === 'string' ? check.decisionInputs.route.passage_id : null };
}

/**
 * Import the checks of one file. Options: `servedIds` (the ids of the checks
 * Passage serves, as this page read them; without them a version-2 file is
 * refused before any check line is read), `signal` (an abort stops between two
 * checks, never inside one's storing), `onProgress({ index })` after each line,
 * `nowMs`, `caps` (the reader's, smaller in tests).
 *
 * A version-1 file resolves { kind: 'v1', ...stage 1's own result }, exactly
 * as importCheckFile gives it, except that a file that is not gzip is "not a
 * check file" whatever its size (stage 1 says "too large" past 16 MB). A
 * version-2 file resolves { kind: 'v2', outcomes: { imported, already,
 * repeated, damaged, futureTime, polar, served, conflict, tooLarge } (counts),
 * importedIds, linesRead (the check lines the reader handed over), joinedOwn (how many of the stored checks joined a passage
 * that already held a check made in this browser, not imported, before the
 * import began), end (IMPORT_END), hint (the reader's code when incomplete,
 * else null), notReached (the check lines not settled: 0 when every line
 * was; after a storage failure the failed one and every later one, from the
 * trailer; null whenever that number is unknown, as when the file broke or
 * the import stopped before its trailer), refusal (an IMPORT outcome when end
 * is refused), first (the first check line's { outcome, snapshotId }, or
 * null), storageFull (true when a storage failure was the browser's quota) }.
 * onProgress is also called with { index: 0 } once a version-2 header is
 * read. An abort before the header resolves { kind: 'unknown', end:
 * stopped }. Never rejects.
 */
export async function importChecksFile(file, { servedIds = null, signal, onProgress, nowMs = Date.now(), caps } = {}) {
  const outcomes = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
  const importedIds = [];
  // ids settled in this file (imported, already here, conflict, served): a later copy is a repeat.
  // A refused copy is not settled, so a later copy of its id is proven on its own.
  const seen = new Set();
  // passages that held a check made in this browser before the import began (one list, before the first line)
  let ownPassages = null;
  let joinedOwn = 0;
  let index = 0;
  // the first check line's outcome and id (an own copy), so a file of one check can be told as stage 1 tells it
  let first = null;
  const result = (end, extra = {}) => {
    if (importedIds.length) requestPersistence();
    return { kind: 'v2', outcomes, importedIds, joinedOwn, linesRead: index, first, end, hint: null, notReached: null, refusal: null, storageFull: false, ...extra };
  };
  const importedAt = new Date(nowMs).toISOString();
  const lines = readCheckFileLines(file, { signal, caps });
  let header = null;
  try {
    for (;;) {
      const step = await lines.next();
      if (step.done) return header ? result(IMPORT_END.incomplete, { hint: LINES.truncated }) : { kind: 'v1', outcome: IMPORT.notCheckFile };
      const item = step.value;
      if (item?.kind === 'v1') {
        await lines.return();
        return { kind: 'v1', ...await importCheckFile(file, { servedIds, nowMs }) };
      }
      if (item?.kind === 'v2') {
        header = item.header;
        // no request is made: a page that never read the served ids refuses for now
        if (!(servedIds instanceof Set)) {
          await lines.return();
          return result(IMPORT_END.refused, { refusal: IMPORT.offline });
        }
        // the import of a version-2 file has begun; no check line is read yet
        onProgress?.({ index: 0 });
        continue;
      }
      if (item?.trailer) return item.trailer.checks === index ? result(IMPORT_END.complete, { notReached: 0 }) : result(IMPORT_END.incomplete, { hint: LINES.trailer });
      // a check line
      index += 1;
      ownPassages ??= new Set((await localSnapshots.list())
        .filter((entry) => !entry.imported && typeof entry.passage_id === 'string')
        .map((entry) => entry.passage_id));
      // The id as the writer writes it, read before any parse. A line that names its id
      // with escapes does not match: it is then settled in full, and a second copy of it
      // is counted as already here rather than repeated, which stores nothing either way.
      const cut = LINE_ID.exec(item.slice(0, 64))?.[1];
      const id = cut === undefined ? null : ownCopy(cut);
      if (id !== null && seen.has(id)) {
        outcomes.repeated += 1;
      } else if (id !== null && await storedTextMatches(id, item)) {
        outcomes.already += 1;
        seen.add(id);
        if (index === 1) first = { outcome: 'already', snapshotId: id };
      } else {
        const settled = await settleLine(item, { header, servedIds, nowMs, importedAt });
        if (settled.stop) {
          await lines.return();
          return result(IMPORT_END.storage, { notReached: await linesLeft(file, caps, index), storageFull: settled.full });
        }
        outcomes[settled.outcome] += 1;
        if (index === 1) first = { outcome: settled.outcome, snapshotId: settled.snapshotId ? ownCopy(settled.snapshotId) : id };
        if (id !== null && SETTLED.has(settled.outcome)) seen.add(id);
        if (settled.snapshotId) {
          importedIds.push(ownCopy(settled.snapshotId));
          if (settled.passageId !== null && ownPassages.has(settled.passageId)) joinedOwn += 1;
        }
      }
      onProgress?.({ index });
      // between two checks: the page stays responsive, and an abort lands here
      await turn();
      if (signal?.aborted) {
        await lines.return();
        return result(IMPORT_END.stopped);
      }
    }
  } catch (error) {
    if (!(error instanceof CheckFileLinesError)) {
      console.error(`Passage could not read this file: ${error?.name ?? 'error'}`);
      return header ? result(IMPORT_END.incomplete, { hint: null }) : { kind: 'v1', outcome: IMPORT.damaged };
    }
    // before the header the kind of file is not known yet
    if (error.code === LINES.aborted) return header ? result(IMPORT_END.stopped) : { kind: 'unknown', end: IMPORT_END.stopped };
    if (!header) {
      if (error.code === LINES.newerVersion) return result(IMPORT_END.refused, { refusal: IMPORT.newer });
      return { kind: 'v1', outcome: BEFORE_HEADER[error.code] ?? IMPORT.damaged };
    }
    console.error(`Passage stopped reading this file (${error.code})`);
    // a check line over the cap is that check refused (the read stops there); the other caps are the file's
    if (error.code === LINES.tooLarge && error.message === 'a line over its cap') outcomes.tooLarge += 1;
    return result(IMPORT_END.incomplete, { hint: error.code });
  }
}

/**
 * After the storing of check line `failedAt` failed: how many check lines were
 * not settled (that one and every later one), from the file's trailer, read on
 * without parsing the lines, or null when the trailer cannot be reached.
 */
async function linesLeft(file, caps, failedAt) {
  try {
    for await (const item of readCheckFileLines(file, { caps })) {
      if (item?.trailer) return item.trailer.checks - failedAt + 1;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Remove checks this browser imported (a later "remove what this import
 * added"): each id is removed, files and marker, only when it has an import
 * marker; any other id is refused and left as it is. `remove(id)` is the
 * delete to use: the page passes its own (appStore deleteSnapshot, which also
 * forgets the remembered open check and closes it if open); the store's
 * delete by default. An id counts as removed once the store no longer holds
 * it. Resolves { removed, refused } (ids).
 */
export async function removeImportedChecks(ids, { remove = (id) => localSnapshots.remove(id) } = {}) {
  const removed = [];
  const refused = [];
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || !await localSnapshots.has(id, IMPORT_MARKER)) {
      refused.push(id);
      continue;
    }
    try {
      await remove(id);
    } catch {
      // judged below by what the store still holds
    }
    if (await localSnapshots.exists(id)) refused.push(id);
    else removed.push(id);
  }
  return { removed, refused };
}
