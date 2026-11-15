/**
 * The check file, version 1 (2026-11-15): one browser-saved check as one JSON
 * document, which the viewer gzips into `passage-check-<date>-<hex>.json.gz`.
 *
 * `files` holds each file of the check exactly as it was saved (the original
 * text, the manifest included), so whoever reads the file can parse
 * `decision-inputs.json` and verify that it hashes to the check's
 * `decision_hash` and `snapshot_id`. Nothing in it is derived or
 * re-serialised. Only the files a v2 check is made of are allowed: a marker
 * a later import may add, or any other record, is never written.
 *
 * Pure and DOM-free: the export (viewer/src/lib/checkFile.js) builds the
 * document here, and the import will read the same constants.
 */
import { parseUtc, toIso } from './eta.js';

export const CHECK_FILE_FORMAT = 'passage-checks';
export const CHECK_FILE_VERSION = 1;

/** The files a v2 check is made of, in the order the document lists them. */
export const CHECK_FILE_NAMES = Object.freeze([
  'snapshot.json',
  'decision-inputs.json',
  'findings.json',
  'briefing.json',
  'route.json',
  'plume.json',
  'warnings.json',
  'synoptic.json',
  'tides.json',
] as const);
export type CheckFileName = (typeof CHECK_FILE_NAMES)[number];

/** Every v2 check has these (writeSnapshot); the others are optional. */
export const CHECK_FILE_REQUIRED: readonly CheckFileName[] = Object.freeze([
  'snapshot.json', 'decision-inputs.json', 'findings.json', 'briefing.json', 'route.json',
]);

/** A v2 check id: `snapshot_v2_` and the 16 hex of its decision hash. */
export const SNAPSHOT_V2_ID = /^snapshot_v2_([0-9a-f]{16})$/;

export interface CheckFileEntry {
  snapshot_id: string;
  files: Partial<Record<CheckFileName, string>>;
}

export interface CheckFileDocument {
  format: typeof CHECK_FILE_FORMAT;
  format_version: typeof CHECK_FILE_VERSION;
  exported_at: string;
  exported_by: string;
  checks: CheckFileEntry[];
}

export interface CheckFileInput {
  snapshotId: string;
  /** filename → the file's original text, as the store read it */
  files: Record<string, string>;
  /** when the file is made (any instant `Date.parse` reads); written as ISO UTC */
  exportedAt: string;
  /** the app and engine version that made it */
  exportedBy: string;
}

/** The 16 hex of a v2 check id, or null when the id is not one. */
export function checkHex(snapshotId: unknown): string | null {
  return typeof snapshotId === 'string' ? SNAPSHOT_V2_ID.exec(snapshotId)?.[1] ?? null : null;
}

/**
 * The document for one check. Its key order is fixed (format, format_version,
 * exported_at, exported_by, checks; snapshot_id, files; files in
 * CHECK_FILE_NAMES order), so the same check and clock give the same text.
 * Throws on an id that is not a v2 check id, a missing required file, a file
 * name outside CHECK_FILE_NAMES, a file that is not text, or a bad clock.
 */
export function buildCheckFile({ snapshotId, files, exportedAt, exportedBy }: CheckFileInput): CheckFileDocument {
  if (checkHex(snapshotId) === null) throw new Error('Only a v2 check can be written to a check file.');
  if (typeof exportedBy !== 'string' || !exportedBy.trim()) throw new Error('A check file names the version that made it.');
  const at = Date.parse(exportedAt);
  if (typeof exportedAt !== 'string' || !Number.isFinite(at)) throw new Error('A check file needs the time it was made.');
  if (!files || typeof files !== 'object') throw new Error('A check file needs the check\'s files.');
  for (const name of Object.keys(files)) {
    if (!(CHECK_FILE_NAMES as readonly string[]).includes(name)) throw new Error(`${name} is not a file of a check.`);
    if (typeof files[name] !== 'string') throw new Error(`${name} is not text.`);
  }
  for (const name of CHECK_FILE_REQUIRED) {
    if (!Object.hasOwn(files, name)) throw new Error(`The check has no ${name}.`);
  }
  const ordered: Partial<Record<CheckFileName, string>> = {};
  for (const name of CHECK_FILE_NAMES) if (Object.hasOwn(files, name)) ordered[name] = files[name];
  return {
    format: CHECK_FILE_FORMAT,
    format_version: CHECK_FILE_VERSION,
    exported_at: new Date(at).toISOString(),
    exported_by: exportedBy,
    checks: [{ snapshot_id: snapshotId, files: ordered }],
  };
}

/** The document's text: compact JSON in the document's own key order. */
export function checkFileText(document: CheckFileDocument): string {
  return JSON.stringify(document);
}

/**
 * `passage-check-<departure date, UTC>-<the 16 hex of the id>.json.gz`. The
 * departure is the check's own (its decision inputs' `departureUtc`); no
 * passage or route name goes into the name.
 */
export function checkFileName(snapshotId: string, departureUtc: string): string {
  const hex = checkHex(snapshotId);
  if (hex === null) throw new Error('Only a v2 check can be written to a check file.');
  const date = toIso(parseUtc(departureUtc)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('The check has no departure date.');
  return `passage-check-${date}-${hex}.json.gz`;
}
