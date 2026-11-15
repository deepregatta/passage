import {
  CHECK_FILE_NAMES, CHECK_FILE_REQUIRED, ENGINE_VERSION, buildCheckFile, checkFileName, checkFileText, checkHex, contentHash,
} from '@deepweather/engine';
import { polarContentFindings } from '../../../scripts/polar-content-rules.mjs';
import { localSnapshots } from './localSnapshots.js';
import { gunzipText, gzipText } from './snapshotCodec.js';
import { saveFile } from './download.js';

// Save a copy of one browser-saved check to a file (2026-11-15, stage 1 of
// export and import). The file is the engine's check file, version 1
// (engine/src/checkFile.ts), gzipped: every file of the check as the browser
// saved it, decoded from gzip storage where stored compressed, so the decision
// hash can be verified from the file alone. Nothing is sent anywhere, no
// analytics event is sent, and the saved check is only read.

/** Why a copy was not made: the page says it in plain words. */
export class CheckFileError extends Error {
  /** @param {'unreadable' | 'damaged' | 'polar' | 'failed'} code */
  constructor(code, message) {
    super(message);
    this.name = 'CheckFileError';
    this.code = code;
  }
}

/** The version that made the file, as the saved checks record it (engine_version). */
export const CHECK_FILE_EXPORTED_BY = `Passage engine ${ENGINE_VERSION}`;

/** This browser can write the gzip file; without CompressionStream it is not offered. */
export const canSaveCheckFile = () => typeof CompressionStream === 'function';

/** A check this browser saved, with a v2 identity: the only kind a copy is made of. */
export function savableCheck({ snapshotId, snapshotSource, findings }) {
  return snapshotSource === 'local' && findings?.identity_version === 2 && checkHex(snapshotId) !== null
    && findings.snapshot_id === snapshotId;
}

const damaged = (message) => new CheckFileError('damaged', message);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A stored file of the check, parsed; anything but a JSON object is a damaged check. */
function parsed(text, name) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw damaged(`${name} is not valid JSON.`);
  }
  if (!isRecord(value)) throw damaged(`${name} is not a JSON object.`);
  return value;
}

/**
 * The files the manifest names, the manifest first, in CHECK_FILE_NAMES order.
 * A name outside that list is refused ('failed': a file this build does not
 * know must not be left out silently); no artifacts, a name that is not text
 * or a missing required file is a damaged check.
 */
function fileNames(manifest) {
  if (!isRecord(manifest.artifacts)) throw damaged('The check manifest names no files.');
  const named = Object.values(manifest.artifacts);
  if (named.some((name) => typeof name !== 'string')) throw damaged('The check manifest names a file that is not text.');
  const unknown = named.filter((name) => !CHECK_FILE_NAMES.includes(name));
  if (unknown.length) throw new CheckFileError('failed', `The check manifest names files a check file cannot hold: ${unknown.join(', ')}.`);
  const missing = CHECK_FILE_REQUIRED.filter((name) => name !== 'snapshot.json' && !named.includes(name));
  if (missing.length) throw damaged(`The check manifest does not name ${missing.join(', ')}.`);
  return CHECK_FILE_NAMES.filter((name) => name === 'snapshot.json' || named.includes(name));
}

/** A stored file's text: null when this browser cannot read it, damaged when it is not text. */
async function storedText(snapshotId, name) {
  const text = await localSnapshots.read(snapshotId, name);
  if (text === null) throw new CheckFileError('unreadable', `${name} cannot be read in this browser.`);
  if (typeof text !== 'string') throw damaged(`${name} is not stored as text.`);
  return text;
}

/**
 * The gzip bytes and file name of one browser-saved check's file. Before any
 * file is made it proves the check is the one its id names, as a strict import
 * will: the manifest is identity 2 with this snapshot_id and decision_hash, the
 * decision inputs hash to that decision_hash, and findings.json agrees.
 * Throws a CheckFileError: 'unreadable' when a file of the check cannot be read
 * here, 'damaged' when the stored check is not that check (any mismatch, a
 * file that is not JSON or not text, no or missing artifacts), 'polar' when
 * any text matches a no-polar-data rule, 'failed' for anything else (a file
 * name a check file cannot hold, compression).
 */
export async function prepareCheckFile(snapshotId, { nowMs = Date.now() } = {}) {
  const hex = checkHex(snapshotId);
  if (hex === null) throw new CheckFileError('failed', 'Only a v2 check is saved to a file.');
  const manifestText = await storedText(snapshotId, 'snapshot.json');
  const manifest = parsed(manifestText, 'snapshot.json');
  if (manifest.identity_version !== 2 || manifest.snapshot_id !== snapshotId || manifest.decision_hash !== hex) {
    throw damaged('The check manifest does not name this check.');
  }
  const files = { 'snapshot.json': manifestText };
  for (const name of fileNames(manifest)) {
    if (name !== 'snapshot.json') files[name] = await storedText(snapshotId, name);
  }
  // parsed once: its hash proves the check, its departure names the file
  const inputs = parsed(files['decision-inputs.json'], 'decision-inputs.json');
  if (contentHash(inputs) !== hex) throw damaged('The decision inputs do not hash to this check.');
  const findings = parsed(files['findings.json'], 'findings.json');
  if (findings.snapshot_id !== snapshotId || (findings.decision_hash !== undefined && findings.decision_hash !== hex)) {
    throw damaged('findings.json does not name this check.');
  }
  let name;
  try {
    name = checkFileName(snapshotId, inputs.departureUtc);
  } catch (error) {
    throw damaged(error.message);
  }
  let document;
  try {
    document = buildCheckFile({ snapshotId, files, exportedAt: new Date(nowMs).toISOString(), exportedBy: CHECK_FILE_EXPORTED_BY });
  } catch (error) {
    throw new CheckFileError('failed', error.message);
  }
  const text = checkFileText(document);
  // The rules look at each file's own text: inside the document a file's
  // quotes are escaped, which a rule written for JSON files would not see.
  if ([...Object.values(files), text].some((part) => polarContentFindings(part).length)) {
    throw new CheckFileError('polar', 'The check holds data a no-polar-data rule matches.');
  }
  const bytes = await gzipText(text).catch(() => null);
  if (!bytes || await gunzipText(bytes).catch(() => null) !== text) {
    throw new CheckFileError('failed', 'This browser could not compress the file exactly.');
  }
  return { name, bytes };
}

/** Where a copy stands, as the page shows it (components/SaveCheckCopy.jsx). */
export const COPY = Object.freeze({
  idle: 'idle', saving: 'saving', made: 'made', unreadable: 'unreadable', damaged: 'damaged', polar: 'polar', failed: 'failed',
});

/** Prepare the file and hand it to the browser's download: COPY.made (the browser
 * accepted the download, which the sailor may still cancel), or why not. */
export async function saveCheckFile(snapshotId) {
  let prepared;
  try {
    prepared = await prepareCheckFile(snapshotId);
  } catch (error) {
    console.error('Passage could not save a copy of this check:', error);
    return error instanceof CheckFileError && Object.hasOwn(COPY, error.code) ? COPY[error.code] : COPY.failed;
  }
  const url = URL.createObjectURL(new Blob([prepared.bytes], { type: 'application/gzip' }));
  try {
    saveFile({ url, name: prepared.name });
  } catch (error) {
    console.error('Passage could not hand the copy to the browser:', error);
    return COPY.failed;
  } finally {
    // the browser has the file once the click is handled
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return COPY.made;
}
