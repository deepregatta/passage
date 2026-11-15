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
import { canonicalJson, contentHash, fnv1a64Hex, fnv1a64HexParts } from './hash.js';
import { routeRevision } from './identity.js';
import { SNAPSHOT_ARTIFACT_FILES, SNAPSHOT_MANIFEST_KEYS } from './snapshot.js';
import type { Route } from './types.js';

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
  const ordered = orderedCheckFiles(files);
  return {
    format: CHECK_FILE_FORMAT,
    format_version: CHECK_FILE_VERSION,
    exported_at: new Date(at).toISOString(),
    exported_by: exportedBy,
    checks: [{ snapshot_id: snapshotId, files: ordered }],
  };
}

/** A check's files in CHECK_FILE_NAMES order; throws on a name outside it, a file that is not text or a missing required file. */
function orderedCheckFiles(files: Record<string, string>): Partial<Record<CheckFileName, string>> {
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
  return ordered;
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

// ---------------------------------------------------------------------------
// Reading a check file back (import, 2026-11-15). The file is hostile until
// proven otherwise: everything here is checked before the viewer stores a
// byte, and the first failure refuses the whole file. Decompression, size
// caps, the polar safety net, served ids and storage stay in the viewer.

/** Why a check file was refused; the viewer says each in plain words. */
export type CheckFileProblem =
  | 'not-check-file' // not JSON, or not the passage-checks format
  | 'newer-version' // the format, made by a newer Passage
  | 'check-count' // not exactly one check
  | 'future-time' // the check was saved more than a day after the import time
  | 'damaged'; // the check is not what its identity says, or a file is not valid

/** One check of a check file, proven (parseCheckEntry): everything but the document's own fields. */
export interface ParsedCheckEntry {
  snapshotId: string;
  /** the file texts exactly as the file holds them, in CHECK_FILE_NAMES order */
  files: Partial<Record<CheckFileName, string>>;
  departureUtc: string;
  createdAt: string;
  /** the parsed decision inputs, already proven to hash to the id */
  decisionInputs: Record<string, unknown>;
  /**
   * canonicalJson(decisionInputs), the text the id's hash was proven over:
   * computed once per check, so the polar safety net need not build it again
   */
  decisionInputsCanonical: string;
  /** every file parsed (for the polar safety net over decoded values) */
  parsed: Partial<Record<CheckFileName, Record<string, unknown>>>;
}

export interface ParsedCheck extends ParsedCheckEntry {
  exportedAt: string;
  exportedBy: string;
}

/** How far ahead of the import time a check's own time may be: clock skew between devices, generously. */
export const CHECK_FILE_FUTURE_MS = 24 * 3600_000;
/** The check sequences a check file may carry, for the import and the export alike. */
export const CHECK_FILE_MAX_SEQUENCE = 999_999;
/** A check file's size caps, for the import and the export alike: compressed, and its text in UTF-8. */
export const CHECK_FILE_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const CHECK_FILE_MAX_TEXT_BYTES = 64 * 1024 * 1024;

export type CheckFileParse =
  | { ok: true; check: ParsedCheck }
  | { ok: false; problem: CheckFileProblem; detail: string };

/** Why one check of a check file was refused: the two problems a check itself can have. */
export type CheckEntryProblem = Extract<CheckFileProblem, 'damaged' | 'future-time'>;

export type CheckEntryParse =
  | { ok: true; check: ParsedCheckEntry }
  | { ok: false; problem: CheckEntryProblem; detail: string };

export interface ParseCheckFileOptions {
  /** now, for the bound on the check's time (Date.now() by default) */
  nowMs?: number;
  /**
   * Refuse a check saved more than CHECK_FILE_FUTURE_MS after now ('future-time').
   * The import sets it; the export does not, so a genuine check is always exportable.
   */
  boundTime?: boolean;
  /**
   * Schema validation of one parsed file against its contract (precompiled
   * validators in the viewer; decision-inputs.json has no contract). Return
   * false to refuse the file.
   */
  validateFile?: (name: CheckFileName, value: unknown) => boolean;
}

/** Object keys a check file may never contain: they mean something else to JavaScript. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** How deep a check file's JSON may nest: real checks nest at most 8 levels. */
export const CHECK_FILE_MAX_DEPTH = 64;
/**
 * The longest string a check file may hold in any file but the decision
 * inputs: the longest in the committed fixtures, goldens and scenarios is 558
 * characters (a briefing sentence), in real warnings 956 (a bulletin).
 */
export const CHECK_FILE_MAX_STRING = 64 * 1024;

export interface JsonKeyLimits {
  /** containers may nest this deep at most (CHECK_FILE_MAX_DEPTH by default) */
  maxDepth?: number;
  /** a string token may be this long at most, quotes and escapes counted (no limit by default) */
  maxString?: number;
}

/**
 * Why JSON text is not acceptable as a check file part, or null: an object
 * key repeated inside one object (two parsers can read it differently), a key
 * in FORBIDDEN_KEYS, nesting deeper than maxDepth, or a string longer than
 * maxString. Linear in the text; string contents are skipped, escapes in keys
 * decoded. The reason never quotes the text: it can be logged. Assumes
 * nothing about validity: JSON.parse decides that afterwards.
 */
export function jsonKeyProblem(text: string, { maxDepth = CHECK_FILE_MAX_DEPTH, maxString = Infinity }: JsonKeyLimits = {}): string | null {
  // one entry per open container: a Set of keys for an object, null for an array
  const stack: Array<Set<string> | null> = [];
  // true when the next string in the current object is a key
  let expectKey = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) { // "
      const start = i;
      let escaped = false;
      for (i++; i < n; i++) {
        const d = text.charCodeAt(i);
        if (d === 0x5c) { escaped = true; i++; continue; }
        if (d === 0x22) break;
      }
      if (i + 1 - start > maxString) return 'a string longer than allowed';
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        const raw = text.slice(start, i + 1);
        let key: string;
        try {
          key = escaped ? JSON.parse(raw) as string : raw.slice(1, -1);
        } catch {
          return 'an unreadable key';
        }
        if (FORBIDDEN_KEYS.has(key)) return 'a forbidden key';
        if (top.has(key)) return 'a repeated key';
        top.add(key);
        expectKey = false;
      }
    } else if (c === 0x7b || c === 0x5b) { // { [
      if (stack.length >= maxDepth) return 'nesting deeper than allowed';
      stack.push(c === 0x7b ? new Set() : null);
      expectKey = c === 0x7b;
    } else if (c === 0x7d || c === 0x5d) { // } ]
      stack.pop();
      expectKey = false;
    } else if (c === 0x2c) { // ,
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = <P extends CheckFileProblem | CheckFileV2Problem>(problem: P, detail: string) => ({ ok: false as const, problem, detail });
const DOCUMENT_KEYS = ['format', 'format_version', 'exported_at', 'exported_by', 'checks'];
const sameInstant = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b) && Number.isFinite(Date.parse(a));

/** The verdict state the briefing's decision section names, or null when it names none (a check with tidal gates). */
function briefingVerdict(briefing: Record<string, unknown>): string | null | undefined {
  const sections = Array.isArray(briefing.sections) ? briefing.sections : [];
  const decision = sections.find((section) => isRecord(section) && section.id === 'decision') as Record<string, unknown> | undefined;
  const plain = isRecord(decision?.messages) && Array.isArray(decision.messages.plain) ? decision.messages.plain : null;
  if (!plain?.length) return null;
  const id = isRecord(plain[0]) ? plain[0].message_id : undefined;
  return typeof id === 'string' ? /^briefing\.decision\.([a-z_]+)\.plain\.v1$/.exec(id)?.[1] : undefined;
}

/**
 * Read a check file's text (already decompressed and decoded) as one check,
 * or say why not. Checked, in order: the key policy of the document; JSON;
 * the format and version; exactly one check; a v2 id; only check file names,
 * all required ones, each text; the key policy and JSON of each file; the
 * manifest's artifacts naming exactly the files present; each file's schema;
 * then the identity (see checkIdentity). Everything from the v2 id on is
 * parseCheckEntry's, which proves the document's one check.
 */
export function parseCheckFile(text: string, options: ParseCheckFileOptions = {}): CheckFileParse {
  if (typeof text !== 'string') return fail('not-check-file', 'not text');
  const outerKeys = jsonKeyProblem(text);
  if (outerKeys) return fail('not-check-file', `the document has ${outerKeys}`);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail('not-check-file', 'not JSON');
  }
  if (!isRecord(document) || document.format !== CHECK_FILE_FORMAT) return fail('not-check-file', 'not the passage-checks format');
  const version = document.format_version;
  if (typeof version === 'number' && Number.isInteger(version) && version > CHECK_FILE_VERSION) {
    return fail('newer-version', `format version ${version}`);
  }
  if (version !== CHECK_FILE_VERSION) return fail('not-check-file', 'an unknown format version');
  if (Object.keys(document).some((key) => !DOCUMENT_KEYS.includes(key))) return fail('not-check-file', 'an unknown document field');
  const { exported_at: exportedAt, exported_by: exportedBy, checks } = document;
  if (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt))) return fail('not-check-file', 'no export time');
  if (typeof exportedBy !== 'string' || !exportedBy.trim() || exportedBy.length > 200) return fail('not-check-file', 'no exporting version');
  if (!Array.isArray(checks)) return fail('not-check-file', 'no checks');
  if (checks.length !== 1) return fail('check-count', `${checks.length} checks`);

  const entry = parseCheckEntry(checks[0], options);
  if (!entry.ok) return entry;
  const { snapshotId, files, departureUtc, createdAt, decisionInputs, decisionInputsCanonical, parsed } = entry.check;
  return {
    ok: true,
    check: { snapshotId, files, exportedAt, exportedBy, departureUtc, createdAt, decisionInputs, decisionInputsCanonical, parsed },
  };
}

/**
 * Prove one check of a check file, a parsed `{ snapshot_id, files }` entry
 * (version 1's one check, or one line of version 2), or say why not.
 * Checked, in order: only those two fields; a v2 id; only check file names,
 * all required ones, each text; the key policy and JSON of each file; the
 * manifest's fields and artifacts naming exactly the files present; the check
 * sequence and save time (with `boundTime`, not more than CHECK_FILE_FUTURE_MS
 * after `nowMs`: 'future-time'); each file's schema through `validateFile`;
 * then the identity (see checkIdentity). Every other failure is 'damaged'.
 * The reasons never quote the check's content or key names.
 */
export function parseCheckEntry(entry: unknown, { validateFile, nowMs = Date.now(), boundTime = false }: ParseCheckFileOptions = {}): CheckEntryParse {
  if (!isRecord(entry) || Object.keys(entry).some((key) => key !== 'snapshot_id' && key !== 'files')) return fail('damaged', 'an unknown check field');
  const snapshotId = entry.snapshot_id;
  const hex = checkHex(snapshotId);
  if (hex === null) return fail('damaged', 'not a v2 check id');
  const id = snapshotId as string;
  if (!isRecord(entry.files)) return fail('damaged', 'no files');
  const given = entry.files;
  const names = Object.keys(given);
  const unknown = names.filter((name) => !(CHECK_FILE_NAMES as readonly string[]).includes(name));
  if (unknown.length) return fail('damaged', 'a file a check file cannot hold');
  const missing = CHECK_FILE_REQUIRED.filter((name) => !names.includes(name));
  if (missing.length) return fail('damaged', `no ${missing.join(', ')}`);

  const files: Partial<Record<CheckFileName, string>> = {};
  const parsed: Partial<Record<CheckFileName, Record<string, unknown>>> = {};
  for (const name of CHECK_FILE_NAMES) {
    if (!Object.hasOwn(given, name)) continue;
    const fileText = given[name];
    if (typeof fileText !== 'string') return fail('damaged', `${name} is not text`);
    const keys = jsonKeyProblem(fileText, { maxString: name === 'decision-inputs.json' ? Infinity : CHECK_FILE_MAX_STRING });
    if (keys) return fail('damaged', `${name} has ${keys}`);
    let value: unknown;
    try {
      value = JSON.parse(fileText);
    } catch {
      return fail('damaged', `${name} is not JSON`);
    }
    if (!isRecord(value)) return fail('damaged', `${name} is not a JSON object`);
    files[name] = fileText;
    parsed[name] = value;
  }

  const manifest = parsed['snapshot.json']!;
  // only what writeSnapshot writes: anything else (a served check's `demo`, say) is not a saved check
  if (Object.keys(manifest).some((key) => !(SNAPSHOT_MANIFEST_KEYS as readonly string[]).includes(key))) return fail('damaged', 'a manifest field writeSnapshot never writes');
  if (!isRecord(manifest.artifacts)) return fail('damaged', 'the manifest names no files');
  const artifacts = Object.entries(manifest.artifacts);
  const present = names.filter((name) => name !== 'snapshot.json');
  if (artifacts.some(([key, file]) => !Object.hasOwn(SNAPSHOT_ARTIFACT_FILES, key) || SNAPSHOT_ARTIFACT_FILES[key as keyof typeof SNAPSHOT_ARTIFACT_FILES] !== file)
    || artifacts.length !== present.length || !present.every((name) => artifacts.some(([, file]) => file === name))) {
    return fail('damaged', 'the manifest does not name exactly the files present');
  }
  if (!isRecord(manifest.input_hashes) || Object.keys(manifest.input_hashes).some((key) => key !== 'route' && key !== 'profile')) return fail('damaged', 'a manifest field writeSnapshot never writes');
  const sequence = manifest.check_sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || (sequence as number) > CHECK_FILE_MAX_SEQUENCE) return fail('damaged', 'a check sequence out of range');
  // The check's own time orders it in its passage. It is not tied to the hash, so
  // only one bound is kept, and only on import: not more than a day ahead of now.
  // (Orders between times would refuse honest files after a clock correction and
  // prove nothing against a forger.)
  const savedAt = Date.parse(String(manifest.created_at));
  if (!Number.isFinite(savedAt)) return fail('damaged', 'a manifest without a save time');
  if (boundTime && savedAt > nowMs + CHECK_FILE_FUTURE_MS) return fail('future-time', 'a check saved more than a day after the import time');

  if (validateFile) {
    for (const name of CHECK_FILE_NAMES) {
      if (name === 'decision-inputs.json' || !parsed[name]) continue;
      if (!validateFile(name, parsed[name])) return fail('damaged', `${name} does not match its contract`);
    }
  }

  const identity = checkIdentity(id, hex, parsed);
  if ('problem' in identity) return fail('damaged', identity.problem);
  const inputs = parsed['decision-inputs.json']!;
  return {
    ok: true,
    check: {
      snapshotId: id,
      files,
      departureUtc: inputs.departureUtc as string,
      createdAt: manifest.created_at as string,
      decisionInputs: inputs,
      decisionInputsCanonical: identity.canonicalInputs,
      parsed,
    },
  };
}

/**
 * The identity of a check file's check, or why it does not hold.
 *
 * Tied to the decision hash (the id's 16 hex is contentHash of the decision
 * inputs, so these follow from the inputs and cannot be changed alone):
 * decision-inputs.json entirely; route.json (canonically the inputs' route);
 * synoptic.json when present (canonically the inputs' synoptic); and, in the
 * manifest and findings, snapshot_id, decision_hash, identity_version 2,
 * route_revision (routeRevision of the inputs' route and departure),
 * passage_id, the route and limits hashes, departure_utc, profile_id,
 * route_id and engine version, and the findings' number and ids of legs.
 *
 * Only checked for agreement (not covered by the hash, so an altered file can
 * still agree with itself): the verdict in the manifest, findings and the
 * briefing's decision message; the snapshot_id of the briefing and plume;
 * and everything else in findings.json, briefing.json, plume.json,
 * warnings.json, tides.json, the manifest's created_at and check_sequence.
 *
 * Gives the decision inputs' canonical JSON when the identity holds: it is
 * built once per check, here, for the hash (it costs most of a large check's
 * proof).
 */
function checkIdentity(id: string, hex: string, parsed: Partial<Record<CheckFileName, Record<string, unknown>>>): { problem: string } | { canonicalInputs: string } {
  const problem = (reason: string) => ({ problem: reason });
  const manifest = parsed['snapshot.json']!;
  const inputs = parsed['decision-inputs.json']!;
  const findings = parsed['findings.json']!;
  const briefing = parsed['briefing.json']!;
  const route = parsed['route.json']!;
  if (manifest.identity_version !== 2 || findings.identity_version !== 2 || inputs.identity_version !== 2) return problem('not identity version 2');
  if (manifest.snapshot_id !== id || findings.snapshot_id !== id) return problem('a manifest or findings for another check');
  if (manifest.decision_hash !== hex || findings.decision_hash !== hex) return problem('another decision hash');
  // contentHash(inputs), keeping the canonical text it hashes
  const canonicalInputs = canonicalJson(inputs);
  if (fnv1a64Hex(canonicalInputs) !== hex) return problem('decision inputs that do not hash to the id');
  const failed = identityProblem(id, inputs, findings, manifest, briefing, route, parsed);
  return failed === null ? { canonicalInputs } : problem(failed);
}

/** The rest of checkIdentity, after the hash: why the identity does not hold, or null. */
function identityProblem(
  id: string,
  inputs: Record<string, unknown>,
  findings: Record<string, unknown>,
  manifest: Record<string, unknown>,
  briefing: Record<string, unknown>,
  route: Record<string, unknown>,
  parsed: Partial<Record<CheckFileName, Record<string, unknown>>>,
): string | null {
  if (!isRecord(inputs.route) || !isRecord(inputs.profile) || typeof inputs.departureUtc !== 'string') return 'decision inputs without a route, limits or departure';
  if (canonicalJson(route) !== canonicalJson(inputs.route)) return 'a route that is not the decision inputs\' route';
  if (parsed['synoptic.json'] && canonicalJson(parsed['synoptic.json']) !== canonicalJson(inputs.synoptic)) return 'a synoptic file that is not the decision inputs\' synoptic';
  let revision: string;
  try {
    revision = routeRevision(inputs.route as unknown as Route, inputs.departureUtc);
  } catch {
    return 'decision inputs with an unreadable departure';
  }
  const passageId = inputs.route.passage_id ?? null;
  const routeHash = contentHash(inputs.route);
  const profileHash = contentHash(inputs.profile);
  const findingsInputs = isRecord(findings.inputs) ? findings.inputs : {};
  const manifestHashes = isRecord(manifest.input_hashes) ? manifest.input_hashes : {};
  const tied: Array<[string, unknown, unknown]> = [
    ['manifest route_revision', manifest.route_revision, revision],
    ['findings route_revision', findings.route_revision, revision],
    ['manifest passage_id', manifest.passage_id ?? null, passageId],
    ['findings passage_id', findings.passage_id ?? null, passageId],
    ['manifest route hash', manifestHashes.route, routeHash],
    ['findings route hash', findingsInputs.route_hash, routeHash],
    ['manifest limits hash', manifestHashes.profile, profileHash],
    ['findings limits hash', findingsInputs.profile_hash, profileHash],
    ['manifest profile_id', manifest.profile_id, inputs.profile.profile_id],
    ['findings profile_id', findings.profile_id, inputs.profile.profile_id],
    ['manifest route_id', manifest.route_id, inputs.route.route_id],
    ['findings route_id', findings.route_id, inputs.route.route_id],
    ['manifest engine version', manifest.engine_version, inputs.engineVersion],
    ['findings engine version', findings.engine_version, inputs.engineVersion],
  ];
  for (const [what, value, expected] of tied) if (value !== expected) return `a ${what} that the decision inputs do not give`;
  if (!sameInstant(manifest.departure_utc, inputs.departureUtc) || !sameInstant(findings.departure_utc, inputs.departureUtc)) return 'a departure the decision inputs do not give';
  const waypoints = Array.isArray(inputs.route.waypoints) ? inputs.route.waypoints.length : 0;
  const legs = Array.isArray(findings.legs) ? findings.legs : [];
  if (legs.length !== Math.max(0, waypoints - 1) || legs.some((leg, i) => !isRecord(leg) || leg.leg_id !== `L${i + 1}`)) return 'findings legs the route does not give';
  // agreement only
  const verdict = isRecord(findings.verdict) ? findings.verdict.state : undefined;
  if (typeof verdict !== 'string' || manifest.verdict_state !== verdict) return 'a verdict the manifest and findings do not share';
  const told = briefingVerdict(briefing);
  if (told !== null && told !== verdict) return 'a briefing with another verdict';
  if (briefing.snapshot_id !== id) return 'a briefing for another check';
  const plume = parsed['plume.json'];
  if (plume && plume.snapshot_id !== id) return 'a plume for another check';
  return null;
}

// ---------------------------------------------------------------------------
// The check file, version 2 (2026-11-15; a format only: nothing in the app
// writes or reads it yet). One file holding all of a sailor's checks, read and
// stored one check at a time: JSON lines inside one gzip member, each line
// compact JSON (JSON.stringify never writes a raw newline) ended by "\n":
//   1. the header  {"format":"passage-checks","format_version":2,"exported_at":…,"exported_by":…}
//   2. one line per check  {"snapshot_id":…,"files":{…},"files_digest":<16 hex>}
//      (`snapshot_id` and `files` exactly as a version-1 entry)
//   3. the trailer  {"end":"passage-checks","checks":<N>}, then nothing but
//      that line's own newline.
// Each line is parsed alone, so a reader never holds more than one line. The
// viewer reads the gzip stream and enforces the byte caps below while bytes
// buffer (viewer/src/lib/checkFileLines.js); these functions are pure.
//
// The format is fixed. ANY change to the shape of any line (a key added,
// removed, renamed or reordered, another value type, another digest encoding,
// another framing) is a new format_version, never a change to version 2:
// engine/test/checkFile.test.ts pins the exact texts and a digest vector.

export const CHECK_FILE_V2_VERSION = 2;
/** A version-2 file's caps: compressed, each line in UTF-8 (its newline not counted), the header and trailer each (likewise), checks, and all lines inflated. */
export const CHECK_FILE_V2_MAX_COMPRESSED_BYTES = 1024 ** 3;
export const CHECK_FILE_V2_MAX_LINE_BYTES = 64 * 1024 ** 2;
export const CHECK_FILE_V2_MAX_EDGE_BYTES = 4 * 1024;
export const CHECK_FILE_V2_MAX_CHECKS = 1000;
export const CHECK_FILE_V2_MAX_INFLATED_BYTES = 8 * 1024 ** 3;
/** How every trailer line starts (the writer's key order), so a reader knows the trailer before it is whole. */
export const CHECK_FILE_V2_TRAILER_PREFIX = '{"end":';

/**
 * A version-2 `exported_by`: 1 to 200 printable ASCII characters (0x20 to
 * 0x7e), not all spaces, since a page may show it one day. The app writes
 * "Passage engine <version>". (Version 1 keeps its own bound: any text of 1
 * to 200 characters.)
 */
const EXPORTED_BY = /^[\x20-\x7e]{1,200}$/;
const exportedByHolds = (value: unknown): value is string => typeof value === 'string' && EXPORTED_BY.test(value) && value.trim() !== '';
const HEADER_KEYS = ['format', 'format_version', 'exported_at', 'exported_by'];
const ENTRY_KEYS = ['snapshot_id', 'files', 'files_digest'];
const TRAILER_KEYS = ['end', 'checks'];
const DIGEST = /^[0-9a-f]{16}$/;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
};

/**
 * The digest of a check's files, for a version-2 line, defined precisely so a
 * reader in another language can compute it. The input is a sequence of UTF-16
 * code units (a JavaScript string's own units: a character outside the Basic
 * Multilingual Plane is two units, its surrogate pair): for each file present,
 * in CHECK_FILE_NAMES order, its name, U+000A, its length in UTF-16 code units
 * written in decimal ASCII digits without leading zeros, U+000A, then its text.
 * The hash is FNV-1a 64 over those units, one unit per step (offset basis
 * 0xcbf29ce484222325, prime 0x100000001b3, h = (h XOR unit) * prime modulo
 * 2^64), written as 16 lowercase hex digits: the engine's hash primitive, as
 * contentHash uses it. Names come from a fixed list without newlines and
 * each text is length-prefixed, so two different file sets never give the same
 * input. It catches accidental damage to one check before anything is stored;
 * it is NOT a security measure (anyone can recompute it: the check's own proof
 * is parseCheckEntry's). Null when `files` is not an object of check file
 * names to texts, which no digest can cover.
 */
export function checkFilesDigest(files: unknown): string | null {
  if (!isRecord(files)) return null;
  const parts: string[] = [];
  for (const name of Object.keys(files)) if (!(CHECK_FILE_NAMES as readonly string[]).includes(name)) return null;
  for (const name of CHECK_FILE_NAMES) {
    if (!Object.hasOwn(files, name)) continue;
    const text = files[name];
    if (typeof text !== 'string') return null;
    parts.push(`${name}\n${text.length}\n`, text);
  }
  return fnv1a64HexParts(parts);
}

/** The header line of a version-2 file, its newline included. Throws on a bad clock or no exporting version. */
export function checkFileHeaderLine({ exportedAt, exportedBy }: { exportedAt: string; exportedBy: string }): string {
  const at = Date.parse(exportedAt);
  if (typeof exportedAt !== 'string' || !Number.isFinite(at)) throw new Error('A check file needs the time it was made.');
  if (!exportedByHolds(exportedBy)) throw new Error('A check file names the version that made it, in printable ASCII.');
  return `${JSON.stringify({ format: CHECK_FILE_FORMAT, format_version: CHECK_FILE_V2_VERSION, exported_at: new Date(at).toISOString(), exported_by: exportedBy })}\n`;
}

/**
 * The line of one check in a version-2 file, its newline included: the
 * version-1 entry (files in CHECK_FILE_NAMES order, texts exactly as given)
 * and its files_digest. Throws as buildCheckFile does. The caller holds the
 * line to CHECK_FILE_V2_MAX_LINE_BYTES.
 */
export function checkFileEntryLine({ snapshotId, files }: { snapshotId: string; files: Record<string, string> }): string {
  if (checkHex(snapshotId) === null) throw new Error('Only a v2 check can be written to a check file.');
  const ordered = orderedCheckFiles(files);
  return `${JSON.stringify({ snapshot_id: snapshotId, files: ordered, files_digest: checkFilesDigest(ordered) })}\n`;
}

/** The trailer line of a version-2 file holding `checks` checks, its newline included. */
export function checkFileTrailerLine(checks: number): string {
  if (!Number.isSafeInteger(checks) || checks < 0 || checks > CHECK_FILE_V2_MAX_CHECKS) throw new Error('A check file holds 0 to 1,000 checks.');
  return `${JSON.stringify({ end: CHECK_FILE_FORMAT, checks })}\n`;
}

/** `passage-all-checks-<UTC date YYYY-MM-DD>-<HHMM>Z.json.gz`, from when the file is made. */
export function allChecksFileName(exportedAt: string): string {
  const at = Date.parse(exportedAt);
  if (typeof exportedAt !== 'string' || !Number.isFinite(at)) throw new Error('A check file needs the time it was made.');
  const iso = new Date(at).toISOString();
  return `passage-all-checks-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}Z.json.gz`;
}

/** Why a version-2 file, or one of its lines, was refused; the viewer says each in plain words. */
export type CheckFileV2Problem =
  | 'not-check-file' // the header is not a version-2 header (the caller may read the file as version 1)
  | 'newer-version' // a header of a format version above 2
  | 'damaged-line' // one check's line (see DamagedLineReason)
  | 'trailer' // a trailer that is not one, or counts other than the checks read
  | 'check-count'; // more than CHECK_FILE_V2_MAX_CHECKS checks

/**
 * Why one check's line was refused: 'line', not a check line (not one compact
 * JSON object, other keys, the key policy, a bad digest field); 'digest', its
 * files do not give its files_digest; or the version-1 proof's own reason for
 * the check ('damaged', 'future-time').
 */
export type DamagedLineReason = 'line' | 'digest' | CheckEntryProblem;

export interface CheckFileHeader {
  exportedAt: string;
  exportedBy: string;
}

export type CheckFileHeaderParse =
  | { ok: true; header: CheckFileHeader }
  | { ok: false; problem: Extract<CheckFileV2Problem, 'not-check-file' | 'newer-version'>; detail: string };

export type CheckFileLineParse =
  | { ok: true; check: ParsedCheckEntry }
  | { ok: false; problem: 'damaged-line'; reason: DamagedLineReason; detail: string };

export type CheckFileTrailerParse =
  | { ok: true; checks: number }
  | { ok: false; problem: Extract<CheckFileV2Problem, 'trailer' | 'check-count'>; detail: string };

/** A line's JSON object, or why not: the key policy, JSON, an object. The reason never quotes the line. */
function lineObject(line: unknown, maxLength: number): Record<string, unknown> | string {
  if (typeof line !== 'string') return 'not text';
  if (line.length > maxLength) return 'longer than allowed';
  // no space, carriage return or other text around the object: the writer never writes any
  if (line.charCodeAt(0) !== 0x7b || line.charCodeAt(line.length - 1) !== 0x7d) return 'not one compact JSON object';
  const keys = jsonKeyProblem(line);
  if (keys) return `a line with ${keys}`;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return 'not JSON';
  }
  return isRecord(value) ? value : 'not one compact JSON object';
}

/**
 * Read a version-2 file's first line (without its newline) as its header, or
 * say why not. 'newer-version' for a passage-checks header of a format version
 * above 2; 'not-check-file' for anything else that is not exactly the header
 * checkFileHeaderLine writes (keys, their order, compact JSON, exported_at as
 * ISO UTC, exported_by of 1 to 200 printable ASCII characters). A first line of version 1 is
 * 'not-check-file' here: a version-1 document is one line, read whole by
 * parseCheckFile.
 */
export function parseCheckFileHeader(line: string): CheckFileHeaderParse {
  const header = lineObject(line, CHECK_FILE_V2_MAX_EDGE_BYTES);
  if (typeof header === 'string') return fail('not-check-file', header);
  if (header.format !== CHECK_FILE_FORMAT) return fail('not-check-file', 'not the passage-checks format');
  const version = header.format_version;
  if (typeof version === 'number' && Number.isInteger(version) && version > CHECK_FILE_V2_VERSION) return fail('newer-version', `format version ${version}`);
  if (version !== CHECK_FILE_V2_VERSION) return fail('not-check-file', 'not format version 2');
  if (!sameKeys(header, HEADER_KEYS)) return fail('not-check-file', 'not the fields of a header');
  const { exported_at: exportedAt, exported_by: exportedBy } = header;
  const at = typeof exportedAt === 'string' ? Date.parse(exportedAt) : NaN;
  if (!Number.isFinite(at) || new Date(at).toISOString() !== exportedAt) return fail('not-check-file', 'no export time');
  if (!exportedByHolds(exportedBy)) return fail('not-check-file', 'no exporting version');
  if (`${line}\n` !== checkFileHeaderLine({ exportedAt, exportedBy })) return fail('not-check-file', 'not one compact JSON object');
  return { ok: true, header: { exportedAt, exportedBy } };
}

/**
 * Read one check's line of a version-2 file (without its newline), or say why
 * not: a check line with exactly snapshot_id, files and files_digest in that
 * order; then its files_digest; then the version-1 proof of the check
 * (parseCheckEntry, with the same options: validateFile, nowMs, boundTime).
 * The caller holds the line to CHECK_FILE_V2_MAX_LINE_BYTES before it gets here.
 */
export function parseCheckFileEntryLine(line: string, options: ParseCheckFileOptions = {}): CheckFileLineParse {
  const damagedLine = (reason: DamagedLineReason, detail: string) => ({ ok: false as const, problem: 'damaged-line' as const, reason, detail });
  const value = lineObject(line, Infinity);
  if (typeof value === 'string') return damagedLine('line', value);
  if (!sameKeys(value, ENTRY_KEYS)) return damagedLine('line', 'not the fields of a check line');
  if (typeof value.files_digest !== 'string' || !DIGEST.test(value.files_digest)) return damagedLine('line', 'no files digest');
  const entry = { snapshot_id: value.snapshot_id, files: value.files };
  const digest = checkFilesDigest(value.files);
  // files no digest can cover are refused by the proof, with its own reason
  if (digest !== null && digest !== value.files_digest) return damagedLine('digest', 'files that do not give their digest');
  const proven = parseCheckEntry(entry, options);
  if (!proven.ok) return damagedLine(proven.problem, proven.detail);
  if (digest === null) return damagedLine('digest', 'files that do not give their digest');
  return proven;
}

/**
 * Read a version-2 file's last line (without its final newline) as its
 * trailer, after `checksRead` check lines: exactly {"end":"passage-checks",
 * "checks":N} as checkFileTrailerLine writes it, with N no more than
 * CHECK_FILE_V2_MAX_CHECKS ('check-count') and equal to `checksRead`
 * ('trailer' otherwise, as for anything that is not that trailer).
 */
export function parseCheckFileTrailer(line: string, checksRead: number): CheckFileTrailerParse {
  const trailer = lineObject(line, CHECK_FILE_V2_MAX_EDGE_BYTES);
  if (typeof trailer === 'string') return fail('trailer', trailer);
  if (!sameKeys(trailer, TRAILER_KEYS) || trailer.end !== CHECK_FILE_FORMAT) return fail('trailer', 'not the fields of a trailer');
  const { checks } = trailer;
  if (!Number.isSafeInteger(checks) || (checks as number) < 0) return fail('trailer', 'no number of checks');
  if ((checks as number) > CHECK_FILE_V2_MAX_CHECKS) return fail('check-count', 'more checks than a check file may hold');
  if (`${line}\n` !== checkFileTrailerLine(checks as number)) return fail('trailer', 'not one compact JSON object');
  if (checks !== checksRead) return fail('trailer', 'a number of checks other than the checks read');
  return { ok: true, checks: checks as number };
}
