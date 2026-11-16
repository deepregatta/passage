import { translateText } from '../i18n.js';
import { countText, passageText } from './passages.js';
import { formatStorageSize } from './storageUsage.js';
import { IMPORT } from './checkImportOutcomes.js';

// The sentences of the two controls for files of many checks on My passages
// (components/SaveAllChecks.jsx and components/ImportCheck.jsx), composed in
// the page language. Every template is in T below and has its French in the
// catalogue; each count has a singular template too (countText). Nothing here
// quotes a file's content.

/**
 * Every template of the two controls, by name (CHECKS_FILE_TEMPLATES lists them for the
 * translation tests). A `…One` template is the singular, chosen by countText.
 */
const T = Object.freeze({
  making: 'Making the file: check {i} of {n}…',
  stoppedNoFile: 'Stopped. No file was made.',
  readyAbout: 'File ready: {n} checks, about {size}.',
  readyAboutOne: 'File ready: {n} check, about {size}.',
  readySmall: 'File ready: {n} checks, {size}.',
  readySmallOne: 'File ready: {n} check, {size}.',
  savedLine: 'Your browser saves it with its downloads. Nothing is sent anywhere.',
  leftDamaged: '{n} checks were left out because they are damaged in this browser.',
  leftDamagedOne: '{n} check was left out because it is damaged in this browser.',
  leftUnreadable: '{n} checks were left out because this browser could not read them.',
  leftUnreadableOne: '{n} check was left out because this browser could not read it.',
  leftPolar: '{n} checks were left out because they hold boat polar data, which Passage never puts in a file.',
  leftPolarOne: '{n} check was left out because it holds boat polar data, which Passage never puts in a file.',
  leftTooLarge: '{n} checks were left out because they are too large for a file.',
  leftTooLargeOne: '{n} check was left out because it is too large for a file.',
  leftFull: '{n} older checks were left out because the file is full.',
  leftFullOne: '{n} older check was left out because the file is full.',
  leftLegacy: '{n} older checks cannot be put in a file: they were saved by an earlier version of Passage.',
  leftLegacyOne: '{n} older check cannot be put in a file: it was saved by an earlier version of Passage.',
  leftFuture: '{n} checks in the file have a time in the future. They can be imported only once that time has come: check this device’s date and time.',
  leftFutureOne: '{n} check in the file has a time in the future. It can be imported only once that time has come: check this device’s date and time.',
  lastFile: 'Last file of all checks: made {date}, {n} checks.',
  lastFileOne: 'Last file of all checks: made {date}, {n} check.',
  notInFile: '{n} checks are not in that file.',
  notInFileOne: '{n} check is not in that file.',
  importingStart: 'Importing checks from a file.',
  importingCheck: 'Importing: check {i}…',
  imported: '{n} checks imported from the file.',
  importedOne: '{n} check imported from the file.',
  already: '{n} checks were already in My passages.',
  alreadyOne: '{n} check was already in My passages.',
  joined: '{n} of the imported checks sit in a passage alongside checks made in this browser.',
  joinedOne: '{n} of the imported checks sits in a passage alongside checks made in this browser.',
  repeated: '{n} checks appear more than once in the file; each was read once.',
  repeatedOne: '{n} check appears more than once in the file; it was read once.',
  namesTaken: '{n} passage names were taken from the file.',
  namesTakenOne: '{n} passage name was taken from the file.',
  namesNotUsed: '{n} passage names in the file were not used: those passages were already here.',
  namesNotUsedOne: '{n} passage name in the file was not used: that passage was already here.',
  namesUnreadable: 'The passage names in this file could not be read. Its checks were read as usual.',
  namesNotPersisted: 'This browser could not save the passage names; they may be gone when you leave this page.',
  notDamaged: '{n} checks were not imported: the file is damaged or has been altered there.',
  notDamagedOne: '{n} check was not imported: the file is damaged or has been altered there.',
  notFuture: '{n} checks were not imported: their time is in the future. Check this device’s date and time.',
  notFutureOne: '{n} check was not imported: its time is in the future. Check this device’s date and time.',
  notPolar: '{n} checks were not imported: they hold boat polar data, which Passage never stores from a file.',
  notPolarOne: '{n} check was not imported: it holds boat polar data, which Passage never stores from a file.',
  notServed: '{n} checks were not imported: they are checks Passage publishes, such as the example.',
  notServedOne: '{n} check was not imported: it is a check Passage publishes, such as the example.',
  notConflict: '{n} checks were not imported: a different check with the same identity is already in this browser.',
  notConflictOne: '{n} check was not imported: a different check with the same identity is already in this browser.',
  notTooLarge: '{n} checks were not imported: they are too large.',
  notTooLargeOne: '{n} check was not imported: it is too large.',
  stoppedTooLarge: 'The import stopped at a check that is too large. The checks after it were not read.',
  endsEarly: 'The file ends early or is damaged, so it may be incomplete. Only the checks before that point were read.',
  storageFull: 'This browser’s storage is full. The checks after that point were not imported.',
  storageFailed: 'This browser could not store a check. The checks after that point were not imported.',
  stopped: 'Stopped. {n} checks were imported before you stopped.',
  stoppedOne: 'Stopped. {n} check was imported before you stopped.',
  tooMany: 'This file holds more checks than Passage imports at once. The first {n} were read.',
  removeLabel: 'Remove the checks this import added',
  removeLabelOne: 'Remove the check this import added',
  removeQuestion: 'Remove the {n} checks this import added?',
  removeQuestionOne: 'Remove the check this import added?',
  removed: '{n} checks removed.',
  removedOne: '{n} check removed.',
});
export const CHECKS_FILE_TEMPLATES = Object.freeze(Object.values(T));

/** Where saving all checks stands. */
export const SAVE_ALL = Object.freeze({ idle: 'idle', making: 'making', stopped: 'stopped', ready: 'ready', saved: 'saved', empty: 'empty', failed: 'failed' });

/** This browser can write the gzip file of all checks; without CompressionStream it is not offered. */
export const canSaveAllChecks = () => typeof CompressionStream === 'function';

/** What a control could not do, for the console (FAILURE.make, FAILURE.hand). */
export const FAILURE = Object.freeze({ make: 'make the file of all checks', hand: 'hand the file to the browser' });

/** A failure of either control, logged by its kind only: never a file's content. */
export function logFailure(what, error) {
  console.error(`Passage could not ${what}: ${error?.name ?? 'error'}`);
}

/** Where saving stands once lib/allChecksFile.js has answered (its ALL_CHECKS outcome; anything else failed). */
export const savePhaseOf = (outcome) => ({ made: SAVE_ALL.ready, empty: SAVE_ALL.empty, stopped: SAVE_ALL.stopped })[outcome] ?? SAVE_ALL.failed;

// the reasons a check was left out of the file, in the order they are listed: [count key, plural, singular]
const SKIPPED = [
  ['damaged', T.leftDamaged, T.leftDamagedOne],
  ['unreadable', T.leftUnreadable, T.leftUnreadableOne],
  ['polar', T.leftPolar, T.leftPolarOne],
  ['tooLarge', T.leftTooLarge, T.leftTooLargeOne],
  ['overCap', T.leftFull, T.leftFullOne],
  ['legacy', T.leftLegacy, T.leftLegacyOne],
  ['futureDated', T.leftFuture, T.leftFutureOne],
];

/** One line per non-zero reason a check was left out of the file (or is in it with a time ahead). */
export function skippedLines(counts, language) {
  return SKIPPED.filter(([key]) => counts?.[key] > 0).map(([key, plural, singular]) => countText(counts[key], plural, singular, {}, language));
}

/** "File ready" with the number of checks and the file's size. */
export function readyLine(count, bytes, language) {
  const size = translateText(formatStorageSize(bytes), language);
  // "about less than 1 MB" would not parse: under 1 MB has its own sentences
  if (bytes < 1e6) return countText(count, T.readySmall, T.readySmallOne, { size }, language);
  return countText(count, T.readyAbout, T.readyAboutOne, { size }, language);
}

export const makingLine = (index, total, language) => {
  const n = Math.max(1, total);
  return passageText(T.making, { i: Math.min(index + 1, n), n }, language);
};

export const stoppedLine = (language) => passageText(T.stoppedNoFile, {}, language);
export const savedLine = (language) => passageText(T.savedLine, {}, language);
export const importStartLine = (language) => passageText(T.importingStart, {}, language);

export const lastFileLine = (count, date, language) => countText(count, T.lastFile, T.lastFileOne, { date }, language);
export const notInLastFileLine = (count, language) => countText(count, T.notInFile, T.notInFileOne, {}, language);

// ---------------------------------------------------------------------------
// Importing a file of many checks: one summary, its information lines and its problem lines apart.

export const importingLine = (index, language) => passageText(T.importingCheck, { i: Math.max(1, index) }, language);

// a check line's outcome (lib/checkImportMany.js) as stage 1 names it for a file of one check
const SINGLE = { imported: IMPORT.imported, already: IMPORT.alreadyHere, damaged: IMPORT.damaged, futureTime: IMPORT.future, polar: IMPORT.polar, served: IMPORT.served, conflict: IMPORT.conflict };

/**
 * A result told as stage 1 tells one check ({ status, snapshotId,
 * departureUtc }), or null for a summary: a version-1 file; a version-2 file
 * refused before its lines; a complete version-2 file of exactly one check.
 */
export function singleStatusOf(result) {
  if (result.kind === 'v1') return { status: result.outcome, snapshotId: result.snapshotId ?? null, departureUtc: result.departureUtc ?? null };
  if (result.kind !== 'v2') return null;
  if (result.end === 'refused') return { status: result.refusal === IMPORT.offline ? IMPORT.manyOffline : result.refusal, snapshotId: null, departureUtc: null };
  if (result.end === 'complete' && result.linesRead === 1 && SINGLE[result.first?.outcome]) return { status: SINGLE[result.first.outcome], snapshotId: result.first.snapshotId, departureUtc: null };
  return null;
}

/** What the import resolves when the importer itself could not load (offline, or a newer site): nothing was read or written. */
export const importerUnavailable = () => ({ kind: 'v1', outcome: IMPORT.offline });

/** Whether My passages lists its checks again after a result told as one check: a check stored, or one of a version-2 file whose departure the listing gives. */
export const listsAfter = (result, single) => result.kind === 'v2' || single.status === IMPORT.imported;

const NONE = { imported: 0, already: 0, repeated: 0, damaged: 0, futureTime: 0, polar: 0, served: 0, conflict: 0, tooLarge: 0 };

/**
 * What became of a version-3 file's passage names, as information: how many it took (a line only
 * when it took some), then how many went unused because their passage was already here (a line
 * only when some did).
 */
export function namesInfoLines(result, language) {
  const taken = result.appliedNames?.length ?? 0;
  const notUsed = result.namesNotUsed ?? 0;
  const lines = taken ? [countText(taken, T.namesTaken, T.namesTakenOne, {}, language)] : [];
  if (notUsed) lines.push(countText(notUsed, T.namesNotUsed, T.namesNotUsedOne, {}, language));
  return lines;
}

/** What went wrong with a version-3 file's passage names: the names line could not be read, or this browser would not keep them. */
export function namesProblems(result, language) {
  const problems = [];
  if (result.namesUnreadable) problems.push(passageText(T.namesUnreadable, {}, language));
  if (result.namesNotPersisted) problems.push(passageText(T.namesNotPersisted, {}, language));
  return problems;
}

/** An import that ended at a check line over the line cap (the reader stops there). */
const stoppedAtLarge = (result) => result.end === 'incomplete' && result.hint === 'too-large' && result.outcomes?.tooLarge > 0;

/**
 * The summary of an import of many checks (lib/checkImportMany.js result):
 * { info, problems } (lines). A repeated line is information (it was read
 * once), not damage.
 */
export function importSummary(result, language) {
  // an import stopped before its file said what it is has no counts yet
  const outcomes = result.outcomes ?? NONE;
  // a stopped import says its count in its own closing line
  const info = result.end === 'stopped' ? [] : [countText(outcomes.imported, T.imported, T.importedOne, {}, language)];
  if (outcomes.already) info.push(countText(outcomes.already, T.already, T.alreadyOne, {}, language));
  if (result.joinedOwn) info.push(countText(result.joinedOwn, T.joined, T.joinedOne, {}, language));
  // a check line given twice was read once: not a damage of the file
  if (outcomes.repeated) info.push(countText(outcomes.repeated, T.repeated, T.repeatedOne, {}, language));
  info.push(...namesInfoLines(result, language));
  // "0 imported" opens the summary only when no other information line does
  if (result.end !== 'stopped' && !outcomes.imported && info.length > 1) info.shift();
  const problems = [];
  const refused = [
    [outcomes.damaged, T.notDamaged, T.notDamagedOne],
    [outcomes.futureTime, T.notFuture, T.notFutureOne],
    [outcomes.polar, T.notPolar, T.notPolarOne],
    [outcomes.served, T.notServed, T.notServedOne],
    [outcomes.conflict, T.notConflict, T.notConflictOne],
    // a check line over the cap ends the read: its own end line says it, not a count
    [stoppedAtLarge(result) ? 0 : outcomes.tooLarge, T.notTooLarge, T.notTooLargeOne],
  ];
  for (const [n, plural, singular] of refused) if (n) problems.push(countText(n, plural, singular, {}, language));
  problems.push(...namesProblems(result, language));
  if (stoppedAtLarge(result)) {
    problems.push(passageText(T.stoppedTooLarge, {}, language));
  } else if (result.end === 'incomplete') {
    problems.push(result.hint === 'check-count'
      ? passageText(T.tooMany, { n: result.linesRead }, language)
      : passageText(T.endsEarly, {}, language));
  }
  if (result.end === 'storage') {
    problems.push(result.storageFull
      ? passageText(T.storageFull, {}, language)
      : passageText(T.storageFailed, {}, language));
  }
  if (result.end === 'stopped') {
    info.push(countText(outcomes.imported, T.stopped, T.stoppedOne, {}, language));
  }
  return { info, problems };
}

export const removeLabel = (count, language) => countText(count, T.removeLabel, T.removeLabelOne, {}, language);
export const removeQuestion = (count, language) => countText(count, T.removeQuestion, T.removeQuestionOne, {}, language);
export const removedLine = (count, language) => countText(count, T.removed, T.removedOne, {}, language);
