import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHECK_FILE_V2_MAX_CHECKS, CHECK_FILE_V2_MAX_COMPRESSED_BYTES, CHECK_FILE_V2_MAX_EDGE_BYTES, CHECK_FILE_V2_MAX_INFLATED_BYTES, CHECK_FILE_V2_MAX_LINE_BYTES,
  CHECK_FILE_V2_TRAILER_PREFIX, CHECK_FILE_V2_VERSION, CHECK_FILE_V3_EMPTY_NAMES_DIGEST, CHECK_FILE_V3_MAX_NAMES, CHECK_FILE_V3_MAX_NAMES_LINE_BYTES,
  CHECK_FILE_V3_NAMES_PREFIX, CHECK_FILE_V3_VERSION, checkFileNamesLine, checkNamesDigest, cleanPassageName, parseCheckFileNames, CHECK_FILE_MAX_COMPRESSED_BYTES, CHECK_FILE_MAX_TEXT_BYTES, ScenarioBundleStore,
  allChecksFileName, checkFileEntryLine, checkFileHeaderLine, checkFileTrailerLine, checkFilesDigest, parseCheckFileEntryLine, parseCheckFileHeader,
  parseCheckFileTrailer, persistSnapshot, runAnalysis,
  CHECK_FILE_FORMAT, CHECK_FILE_NAMES, CHECK_FILE_REQUIRED, CHECK_FILE_VERSION, buildCheckFile, checkFileName, checkFileText, checkHex, contentHash,
  canonicalJson, jsonKeyProblem, parseCheckEntry, parseCheckFile, SNAPSHOT_ARTIFACT_FILES, SNAPSHOT_MANIFEST_KEYS, CHECK_FILE_MAX_SEQUENCE,
} from '../src/index.js';

// The check file (format "passage-checks", version 1): one browser-saved check as one
// JSON document. Its files are the original texts, so the decision hash can be
// re-verified from the file alone.
const demo = resolve(import.meta.dirname, '../../viewer/test/fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73');
const id = 'snapshot_v2_406ad333228b0a73';
const demoFiles = () => Object.fromEntries(readdirSync(demo)
  .filter((name) => (CHECK_FILE_NAMES as readonly string[]).includes(name))
  .map((name) => [name, readFileSync(join(demo, name), 'utf8')]));
const exportedAt = '2026-11-15T12:00:00.000Z';
const exportedBy = 'Passage engine 0.2.0';
const NOW_MS = Date.parse('2026-11-16T09:00:00Z');

describe('buildCheckFile', () => {
  it('writes one check with the original texts, and the decision inputs hash to its id', () => {
    const files = demoFiles();
    const document = buildCheckFile({ snapshotId: id, files, exportedAt, exportedBy });
    expect(Object.keys(document)).toEqual(['format', 'format_version', 'exported_at', 'exported_by', 'checks']);
    expect(document).toMatchObject({ format: CHECK_FILE_FORMAT, format_version: CHECK_FILE_VERSION, exported_at: exportedAt, exported_by: exportedBy });
    expect(CHECK_FILE_FORMAT).toBe('passage-checks');
    expect(CHECK_FILE_VERSION).toBe(1);
    expect(document.checks).toHaveLength(1);
    expect(Object.keys(document.checks[0]!)).toEqual(['snapshot_id', 'files']);
    const back = JSON.parse(checkFileText(document));
    expect(back).toEqual(document);
    // byte-identical texts, manifest included
    for (const [name, text] of Object.entries(files)) expect(back.checks[0].files[name]).toBe(text);
    expect(Object.keys(back.checks[0].files)).toEqual(CHECK_FILE_NAMES.filter((name) => name in files));
    expect(`snapshot_v2_${contentHash(JSON.parse(back.checks[0].files['decision-inputs.json']))}`).toBe(id);
    expect(JSON.parse(back.checks[0].files['snapshot.json'])).toMatchObject({ snapshot_id: id, decision_hash: checkHex(id) });
  });

  it('gives the same text whatever order the files and clock arrive in', () => {
    const files = demoFiles();
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const a = checkFileText(buildCheckFile({ snapshotId: id, files, exportedAt, exportedBy }));
    const b = checkFileText(buildCheckFile({ snapshotId: id, files: reversed, exportedAt: '2026-11-15T13:00:00+01:00', exportedBy }));
    expect(b).toBe(a);
  });

  it('keeps texts exactly, outside Latin-1, with odd whitespace and escapes', () => {
    const odd = {
      'snapshot.json': '{\n  "snapshot_id": "snapshot_v2_0123456789abcdef"\n}\n',
      'decision-inputs.json': '{"route":{"name":"Brest → Île d’Yeu 🌊"},"x":"\\u2028\\"quoted\\""}',
      'findings.json': '  {"a": 1}\r\n',
      'briefing.json': '{"t":"tab\\there"}',
      'route.json': '{"name":"Ψ ✓   nbsp"}',
    };
    const document = buildCheckFile({ snapshotId: 'snapshot_v2_0123456789abcdef', files: odd, exportedAt, exportedBy });
    expect(JSON.parse(checkFileText(document)).checks[0].files).toEqual(odd);
  });

  it.each([
    ['an id that is not a v2 check id', { snapshotId: '20260720T060000Z_44d2cd5f_64ea971e' }, /v2 check/],
    ['a v2 id with the wrong hex', { snapshotId: 'snapshot_v2_406AD333228B0A73' }, /v2 check/],
    ['a missing decision-inputs.json', { files: { ...demoFiles(), 'decision-inputs.json': undefined } }, /decision-inputs\.json/],
    ['an unknown file, such as an import marker', { files: { ...demoFiles(), 'imported.json': '{}' } }, /imported\.json is not a file/],
    ['a file that is not text', { files: { ...demoFiles(), 'plume.json': { a: 1 } } }, /plume\.json is not text/],
    ['no clock', { exportedAt: 'soon' }, /time/],
    ['no version', { exportedBy: ' ' }, /version/],
  ])('refuses %s', (_case, change, message) => {
    const input = { snapshotId: id, files: demoFiles(), exportedAt, exportedBy, ...change } as Parameters<typeof buildCheckFile>[0];
    input.files = Object.fromEntries(Object.entries(input.files).filter(([, text]) => text !== undefined)) as Record<string, string>;
    expect(() => buildCheckFile(input)).toThrow(message);
  });

  it('lists the files a v2 check is made of, the required ones among them', () => {
    expect(CHECK_FILE_NAMES).toEqual(['snapshot.json', 'decision-inputs.json', 'findings.json', 'briefing.json', 'route.json', 'plume.json', 'warnings.json', 'synoptic.json', 'tides.json']);
    expect(CHECK_FILE_REQUIRED.every((name) => CHECK_FILE_NAMES.includes(name))).toBe(true);
    expect(Object.isFrozen(CHECK_FILE_NAMES)).toBe(true);
  });
});

describe('checkFileName', () => {
  it('names the file by the UTC departure date and the id’s hex, nothing else', () => {
    expect(checkFileName(id, '2026-07-20T06:00:00Z')).toBe('passage-check-2026-07-20-406ad333228b0a73.json.gz');
    // the date is the UTC one, whatever offset the departure was written with
    expect(checkFileName(id, '2026-07-20T23:30:00-02:00')).toBe('passage-check-2026-07-21-406ad333228b0a73.json.gz');
    expect(checkFileName(id, '2026-07-20T00:30:00+02:00')).toBe('passage-check-2026-07-19-406ad333228b0a73.json.gz');
    const departure = JSON.parse(readFileSync(join(demo, 'decision-inputs.json'), 'utf8')).departureUtc;
    expect(checkFileName(id, departure)).toBe(`passage-check-${departure.slice(0, 10)}-406ad333228b0a73.json.gz`);
  });

  it('refuses an id that is not a v2 check id and a departure that is not a time', () => {
    expect(() => checkFileName('demo', '2026-07-20T06:00:00Z')).toThrow(/v2 check/);
    expect(() => checkFileName(id, 'tomorrow')).toThrow();
  });

  it('reads the hex of a v2 id only', () => {
    expect(checkHex(id)).toBe('406ad333228b0a73');
    expect(checkHex('snapshot_v2_406ad333228b0a7')).toBeNull();
    expect(checkHex(42)).toBeNull();
  });
});

// Reading a check file back (import). The file is hostile: each refusal names its kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tests edit parsed check files field by field
type J = any;
describe('parseCheckFile', () => {
  const earlierDir = resolve(import.meta.dirname, '../../viewer/test/fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3');
  const earlierId = 'snapshot_v2_8ca29e5bd5a065f3';
  const earlierFiles = (): Record<string, string> => Object.fromEntries(readdirSync(earlierDir)
    .filter((name) => (CHECK_FILE_NAMES as readonly string[]).includes(name))
    .map((name) => [name, readFileSync(join(earlierDir, name), 'utf8')]));
  const fileText = (files = earlierFiles(), snapshotId = earlierId) => checkFileText(buildCheckFile({ snapshotId, files, exportedAt, exportedBy }));
  const document = () => JSON.parse(fileText());
  const editFile = (name: string, change: (value: Record<string, unknown>) => unknown) => {
    const files = earlierFiles();
    files[name] = JSON.stringify(change(JSON.parse(files[name]!)), null, 2);
    return fileText(files);
  };
  const refused = (text: string, problem: string) => {
    const result = parseCheckFile(text, { nowMs: NOW_MS });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) expect(result.problem).toBe(problem);
    return result;
  };

  it('reads a valid file into the check, its texts exactly as given', () => {
    const files = earlierFiles();
    const result = parseCheckFile(fileText(files), { nowMs: NOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.snapshotId).toBe(earlierId);
    expect(result.check.files).toEqual(files);
    for (const [name, text] of Object.entries(files)) expect(result.check.files[name as keyof typeof result.check.files]).toBe(text);
    expect(result.check).toMatchObject({ exportedAt, exportedBy, departureUtc: '2026-07-20T06:00:00Z', createdAt: JSON.parse(files['snapshot.json']!).created_at });
    expect(contentHash(result.check.decisionInputs)).toBe('8ca29e5bd5a065f3');
  });

  it('proves the one check alone through parseCheckEntry, with the canonical decision inputs it hashed', () => {
    const entry = parseCheckEntry(document().checks[0], { nowMs: NOW_MS });
    const whole = parseCheckFile(fileText(), { nowMs: NOW_MS });
    expect(entry.ok && whole.ok).toBe(true);
    if (!entry.ok || !whole.ok) return;
    const { exportedAt: _at, exportedBy: _by, ...check } = whole.check;
    expect(entry.check).toEqual(check);
    expect(entry.check.decisionInputsCanonical).toBe(canonicalJson(entry.check.decisionInputs));
    expect(contentHash(entry.check.decisionInputs)).toBe(checkHex(entry.check.snapshotId));
    expect(parseCheckEntry({ ...document().checks[0], note: 'x' })).toMatchObject({ ok: false, problem: 'damaged', detail: 'an unknown check field' });
    expect(parseCheckEntry(null)).toMatchObject({ ok: false, problem: 'damaged' });
    const future = JSON.parse(editFile('snapshot.json', (m: J) => ({ ...m, created_at: '2099-01-01T00:00:00.000Z' }))).checks[0];
    expect(parseCheckEntry(future, { nowMs: NOW_MS, boundTime: true })).toMatchObject({ ok: false, problem: 'future-time' });
  });

  it('runs the schema check on every file but the decision inputs', () => {
    const seen: string[] = [];
    expect(parseCheckFile(fileText(), { nowMs: NOW_MS, validateFile: (name) => { seen.push(name); return true; } }).ok).toBe(true);
    expect(seen).toEqual(['snapshot.json', 'findings.json', 'briefing.json', 'route.json', 'plume.json', 'warnings.json', 'synoptic.json']);
    const result = parseCheckFile(fileText(), { nowMs: NOW_MS, validateFile: (name) => name !== 'plume.json' });
    expect(result).toMatchObject({ ok: false, problem: 'damaged', detail: 'plume.json does not match its contract' });
  });

  it.each([
    ['not JSON', 'not json'],
    ['JSON of another kind', JSON.stringify({ type: 'FeatureCollection', features: [] })],
    ['a JSON array', '[]'],
    ['another format', JSON.stringify({ ...JSON.parse('{}'), format: 'passage-routes', format_version: 1, checks: [] })],
    ['version 0', JSON.stringify({ format: 'passage-checks', format_version: 0, exported_at: exportedAt, exported_by: exportedBy, checks: [] })],
    ['a version that is text', JSON.stringify({ format: 'passage-checks', format_version: '1', exported_at: exportedAt, exported_by: exportedBy, checks: [] })],
    ['an unknown document field', JSON.stringify({ ...JSON.parse(fileText()), extra: true })],
    ['no export time', JSON.stringify({ ...JSON.parse(fileText()), exported_at: 'later' })],
    ['a repeated document key', fileText().replace('"format":"passage-checks",', '"format":"passage-checks","format":"passage-checks",')],
  ])('refuses %s as not a check file', (_case, text) => { refused(text, 'not-check-file'); });

  it('tells a newer format version apart', () => {
    refused(JSON.stringify({ ...document(), format_version: 2 }), 'newer-version');
  });

  it.each([[0], [2]])('refuses %s checks rather than import one of them', (count) => {
    const doc = document();
    refused(JSON.stringify({ ...doc, checks: Array.from({ length: count }, () => doc.checks[0]) }), 'check-count');
  });

  it.each([
    ['an unknown check field', (doc: J) => { doc.checks[0].note = 'x'; }],
    ['an id that is not a v2 id', (doc: J) => { doc.checks[0].snapshot_id = '20260720T060000Z_44d2cd5f_64ea971e'; }],
    ['an import marker', (doc: J) => { doc.checks[0].files['imported.json'] = '{}'; }],
    ['another file name', (doc: J) => { doc.checks[0].files['changes.json'] = '{}'; }],
    ['no decision inputs', (doc: J) => { delete doc.checks[0].files['decision-inputs.json']; }],
    ['a file that is not text', (doc: J) => { doc.checks[0].files['plume.json'] = { a: 1 }; }],
    ['a file that is not JSON', (doc: J) => { doc.checks[0].files['plume.json'] = '{'; }],
    ['a file that is a JSON array', (doc: J) => { doc.checks[0].files['plume.json'] = '[]'; }],
  ])('refuses %s as damaged', (_case, change) => {
    const doc = document();
    change(doc);
    refused(JSON.stringify(doc), 'damaged');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the key "%s" in any file', (key) => {
    for (const name of Object.keys(earlierFiles())) {
      const files = earlierFiles();
      files[name] = files[name]!.replace('{', `{"${key}": {"polluted": true},`);
      refused(fileText(files), 'damaged');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a key repeated inside one object of a file, escapes included', () => {
    const files = earlierFiles();
    files['plume.json'] = files['plume.json']!.replace('{', '{"model": "x", "\\u006dodel": "y",');
    const result = refused(fileText(files), 'damaged');
    expect(result.ok || result.detail).toBe('plume.json has a repeated key');
  });

  it.each([
    ['names a file that is not there', (m: J) => ({ ...m, artifacts: { ...m.artifacts, tides: 'tides.json' } })],
    ['leaves out a file that is there', (m: J) => ({ ...m, artifacts: { ...m.artifacts, plume: undefined } })],
    ['names a file twice', (m: J) => ({ ...m, artifacts: { ...m.artifacts, again: 'plume.json' } })],
    ['names no files', ({ artifacts: _files, ...m }: J) => m],
  ])('refuses a manifest that %s', (_case, change) => { refused(editFile('snapshot.json', change), 'damaged'); });

  it.each([
    ['a manifest for another check', 'snapshot.json', (m: J) => ({ ...m, snapshot_id: 'snapshot_v2_0123456789abcdef' })],
    ['a manifest with another decision hash', 'snapshot.json', (m: J) => ({ ...m, decision_hash: '0123456789abcdef' })],
    ['a manifest of identity 1', 'snapshot.json', (m: J) => ({ ...m, identity_version: 1 })],
    ['a manifest with another route revision', 'snapshot.json', (m: J) => ({ ...m, route_revision: '0123456789abcdef' })],
    ['a manifest with another passage', 'snapshot.json', (m: J) => ({ ...m, passage_id: 'someone-else' })],
    ['a manifest with another limits hash', 'snapshot.json', (m: J) => ({ ...m, input_hashes: { ...m.input_hashes, profile: '0123456789abcdef' } })],
    ['a manifest with another departure', 'snapshot.json', (m: J) => ({ ...m, departure_utc: '2026-07-21T06:00:00Z' })],
    ['a manifest with another verdict', 'snapshot.json', (m: J) => ({ ...m, verdict_state: 'within' })],
    ['decision inputs that no longer hash to the id', 'decision-inputs.json', (d: J) => ({ ...d, departureUtc: '2026-07-21T06:00:00Z' })],
    ['a route that is not the inputs\' route', 'route.json', (r: J) => ({ ...r, name: '<img src=x onerror=alert(1)>' })],
    ['a route with 200,000 waypoints', 'route.json', (r: J) => ({ ...r, waypoints: Array.from({ length: 200_000 }, () => r.waypoints[0]) })],
    ['a synoptic file that is not the inputs\' synoptic', 'synoptic.json', (s: J) => ({ ...s, chart_captions: [{ file: 'runs/../../secret.png', step_h: 0 }] })],
    ['findings for another check', 'findings.json', (f: J) => ({ ...f, snapshot_id: 'snapshot_v2_0123456789abcdef' })],
    ['findings with another verdict', 'findings.json', (f: J) => ({ ...f, verdict: { ...f.verdict, state: 'within' } })],
    ['findings with another route hash', 'findings.json', (f: J) => ({ ...f, inputs: { ...f.inputs, route_hash: '0123456789abcdef' } })],
    ['findings with 200,000 legs', 'findings.json', (f: J) => ({ ...f, legs: Array.from({ length: 200_000 }, (_, i) => ({ leg_id: `L${i + 1}` })) })],
    ['findings with a leg left out', 'findings.json', (f: J) => ({ ...f, legs: f.legs.slice(1) })],
    ['a briefing for another check', 'briefing.json', (b: J) => ({ ...b, snapshot_id: 'snapshot_v2_0123456789abcdef' })],
    ['a briefing with another verdict', 'briefing.json', (b: J) => ({ ...b, sections: b.sections.map((s: J) => (s.id === 'decision' ? { ...s, messages: { ...s.messages, plain: [{ message_id: 'briefing.decision.within.plain.v1', params: {} }] } } : s)) })],
    ['a plume for another check', 'plume.json', (p: J) => ({ ...p, snapshot_id: 'snapshot_v2_0123456789abcdef' })],
  ])('refuses %s as damaged', (_case, name, change) => {
    const result = refused(editFile(name, change), 'damaged');
    expect(result.ok || result.detail).not.toMatch(/Plymouth|Cherbourg|\d+\.\d{3,}/);
  });

  it.each([
    ['a served check\'s demo flag', (m: J) => ({ ...m, demo: true })],
    ['any other field', (m: J) => ({ ...m, note: 'x' })],
    ['an artifact under another key', (m: J) => ({ ...m, artifacts: { ...m.artifacts, extra: m.artifacts.plume, plume: undefined } })],
    ['an artifact key naming another file', (m: J) => ({ ...m, artifacts: { ...m.artifacts, plume: 'warnings.json', warnings: 'plume.json' } })],
    ['another input hash', (m: J) => ({ ...m, input_hashes: { ...m.input_hashes, tides: 'x' } })],
    ['check sequence 0', (m: J) => ({ ...m, check_sequence: 0 })],
    ['check sequence 1,000,000', (m: J) => ({ ...m, check_sequence: 1_000_000 })],
    ['a check sequence past the safe integers', (m: J) => ({ ...m, check_sequence: 2 ** 53 })],
    ['a fractional check sequence', (m: J) => ({ ...m, check_sequence: 1.5 })],
    ['a check sequence as text', (m: J) => ({ ...m, check_sequence: '1' })],
    ['no save time', (m: J) => ({ ...m, created_at: 'soon' })],
  ])('refuses a manifest with %s', (_case, change) => { refused(editFile('snapshot.json', change), 'damaged'); });

  it('accepts check sequences 1 and 999,999 (the bound import and export share)', () => {
    for (const sequence of [1, 999_999]) expect(parseCheckFile(editFile('snapshot.json', (m: J) => ({ ...m, check_sequence: sequence })), { nowMs: NOW_MS }).ok).toBe(true);
    expect(CHECK_FILE_MAX_SEQUENCE).toBe(999_999);
  });

  it('bounds only the check\'s own time, only when asked (the import), at a day ahead of now', () => {
    const saved = (createdAt: string) => editFile('snapshot.json', (m: J) => ({ ...m, created_at: createdAt }));
    const bound = { nowMs: NOW_MS, boundTime: true };
    expect(parseCheckFile(saved('2099-01-01T00:00:00.000Z'), bound)).toMatchObject({ ok: false, problem: 'future-time' });
    expect(parseCheckFile(saved('2026-11-17T09:00:01.000Z'), bound)).toMatchObject({ ok: false, problem: 'future-time' });
    expect(parseCheckFile(saved('2026-11-17T08:59:59.000Z'), bound).ok).toBe(true);
    // the export reads without the bound: a genuine check is always exportable
    expect(parseCheckFile(saved('2099-01-01T00:00:00.000Z'), { nowMs: NOW_MS }).ok).toBe(true);
    // no orders between times: a save before findings' time, a file made before the save, a file "from the future"
    expect(parseCheckFile(saved('2026-07-19T17:59:00.000Z'), bound).ok).toBe(true);
    expect(parseCheckFile(JSON.stringify({ ...document(), exported_at: '2026-07-01T00:00:00Z' }), bound).ok).toBe(true);
    expect(parseCheckFile(JSON.stringify({ ...document(), exported_at: '2030-01-01T00:00:00Z' }), bound).ok).toBe(true);
  });

  it('refuses nesting deeper than 64 levels in a field no contract closes, and a string over 64 KiB outside the decision inputs', () => {
    const deep = (levels: number) => JSON.parse(`${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`);
    expect(parseCheckFile(editFile('findings.json', (f: J) => ({ ...f, debug: deep(50) })), { nowMs: NOW_MS }).ok).toBe(true);
    expect(parseCheckFile(editFile('findings.json', (f: J) => ({ ...f, debug: deep(70) })), { nowMs: NOW_MS })).toMatchObject({ ok: false, problem: 'damaged', detail: 'findings.json has nesting deeper than allowed' });
    expect(parseCheckFile(editFile('findings.json', (f: J) => ({ ...f, debug: 'x'.repeat(64 * 1024) })), { nowMs: NOW_MS })).toMatchObject({ ok: false, problem: 'damaged', detail: 'findings.json has a string longer than allowed' });
    expect(parseCheckFile(editFile('findings.json', (f: J) => ({ ...f, debug: 'x'.repeat(60 * 1024) })), { nowMs: NOW_MS }).ok).toBe(true);
  });

  it('never quotes a key or other content in its reasons', () => {
    const files = earlierFiles();
    files['plume.json'] = files['plume.json']!.replace('{', '{"secret-key-name": 1, "secret-key-name": 2,');
    expect(JSON.stringify(parseCheckFile(fileText(files), { nowMs: NOW_MS }))).not.toContain('secret');
  });

  it('accepts a briefing whose decision names no verdict (a check with tidal gates)', () => {
    const text = editFile('briefing.json', (b: J) => ({ ...b, sections: b.sections.map((s: J) => (s.id === 'decision' ? { ...s, messages: { title: s.messages.title } } : s)) }));
    expect(parseCheckFile(text, { nowMs: NOW_MS }).ok).toBe(true);
  });
});

describe('jsonKeyProblem', () => {
  it.each([
    ['{"a":1,"b":{"a":2},"c":[{"a":1},{"a":2}]}', null],
    ['{"a":"{\\"a\\":1,\\"a\\":2}"}', null],
    ['{"a":1,"a":2}', 'a repeated key'],
    ['{"x":{"a":1,"b":[1,2],"a":3}}', 'a repeated key'],
    ['{"a":1,"\\u0061":2}', 'a repeated key'],
    ['{"__proto__":{}}', 'a forbidden key'],
    ['[{"constructor":1}]', 'a forbidden key'],
    ['"just text with \\"a\\""', null],
  ])('%s → %s', (text, problem) => {
    expect(jsonKeyProblem(text)).toBe(problem);
  });
});

describe('the manifest writeSnapshot writes', () => {
  it('uses only SNAPSHOT_MANIFEST_KEYS and the artifact names of SNAPSHOT_ARTIFACT_FILES', () => {
    for (const dir of ['../../viewer/test/fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3']) {
      const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, dir, 'snapshot.json'), 'utf8'));
      expect(Object.keys(manifest).every((key) => (SNAPSHOT_MANIFEST_KEYS as readonly string[]).includes(key))).toBe(true);
      for (const [key, file] of Object.entries(manifest.artifacts)) expect(SNAPSHOT_ARTIFACT_FILES[key as keyof typeof SNAPSHOT_ARTIFACT_FILES]).toBe(file);
    }
  });
});

// The check file, version 2: JSON lines in one gzip member (the gzip and the byte caps
// are the viewer's). Each line is read alone; hostile lines are refused with a reason
// that says which kind of damage, never what the line holds.
describe('check file, version 2', () => {
  const earlierDir = resolve(import.meta.dirname, '../../viewer/test/fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3');
  const earlier = () => ({
    snapshotId: 'snapshot_v2_8ca29e5bd5a065f3',
    files: Object.fromEntries(readdirSync(earlierDir)
      .filter((name) => (CHECK_FILE_NAMES as readonly string[]).includes(name))
      .map((name) => [name, readFileSync(join(earlierDir, name), 'utf8')])) as Record<string, string>,
  });
  // a check the engine makes now, saved by persistSnapshot into memory, as the viewer's test helper does
  let made: { snapshotId: string; files: Record<string, string> };
  beforeAll(async () => {
    const read = (path: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf8'));
    const route = { ...read('../../config/routes/newport-newyork.json'), passage_id: 'passage-lines-test', name: 'Île d’Yeu → Brest 🌊 <b>bold</b>' };
    const store = new ScenarioBundleStore({ loadBundle: async (bundle: string) => read(`fixtures/scenarios/calm/${bundle}.json`) });
    const nowMs = Date.parse('2026-07-19T18:00:00Z');
    const result = await runAnalysis({ route, profile: read('../../config/profiles/default-limits.json'), departureUtc: '2026-07-20T06:00:00Z', store, now: () => nowMs });
    const files: Record<string, string> = {};
    const memory = {
      exists: async () => false,
      read: async (_id: string, name: string) => files[name] ?? null,
      list: async () => [],
      write: async (_id: string, name: string, content: string) => { files[name] = content; },
    };
    made = { snapshotId: await persistSnapshot(memory, result, route, nowMs), files };
  });
  const header = { exportedAt, exportedBy };
  const lineOf = (check = earlier()) => checkFileEntryLine(check).slice(0, -1);
  const entryOf = (line: string) => JSON.parse(line) as J;
  const rewritten = (change: (entry: J) => void, check = earlier()) => {
    const entry = entryOf(lineOf(check));
    change(entry);
    return JSON.stringify(entry);
  };
  const lineRefused = (line: string, reason: string, options: Parameters<typeof parseCheckFileEntryLine>[1] = { nowMs: NOW_MS }) => {
    const result = parseCheckFileEntryLine(line, options);
    expect(result, JSON.stringify(result).slice(0, 300)).toMatchObject({ ok: false, problem: 'damaged-line', reason });
    return result;
  };

  it('writes header, one line per check and trailer, each compact JSON ended by one newline, and reads every line back', () => {
    const checks = [earlier(), made];
    const text = checkFileHeaderLine(header) + checks.map((check) => checkFileEntryLine(check)).join('') + checkFileTrailerLine(checks.length);
    expect(text.endsWith('}\n')).toBe(true);
    const lines = text.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(4);
    expect(Object.keys(JSON.parse(lines[0]!))).toEqual(['format', 'format_version', 'exported_at', 'exported_by']);
    expect(parseCheckFileHeader(lines[0]!)).toEqual({ ok: true, header, version: 2 });
    lines.slice(1, -1).forEach((line, i) => {
      const check = checks[i]!;
      expect(Object.keys(JSON.parse(line))).toEqual(['snapshot_id', 'files', 'files_digest']);
      const result = parseCheckFileEntryLine(line, { nowMs: NOW_MS, boundTime: true });
      expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
      if (!result.ok) return;
      // the version-1 proof of the same entry, and the texts exactly as given
      const { files_digest: digest, ...entry } = JSON.parse(line);
      expect(digest).toBe(checkFilesDigest(check.files));
      expect(result.check).toEqual((parseCheckEntry(entry, { nowMs: NOW_MS }) as { check: unknown }).check);
      expect(result.check.snapshotId).toBe(check.snapshotId);
      for (const [name, fileText] of Object.entries(check.files)) expect(result.check.files[name as keyof typeof result.check.files]).toBe(fileText);
      expect(Object.keys(result.check.files)).toEqual(CHECK_FILE_NAMES.filter((name) => name in check.files));
      // the entry is exactly a version-1 entry
      expect(JSON.parse(checkFileText(buildCheckFile({ ...check, ...header }))).checks[0]).toEqual(entry);
    });
    expect(lines[3]!.startsWith(CHECK_FILE_V2_TRAILER_PREFIX)).toBe(true);
    expect(parseCheckFileTrailer(lines[3]!, 2)).toEqual({ ok: true, checks: 2 });
  });

  it('gives the same text whatever order the files and clock arrive in', () => {
    const { snapshotId, files } = made;
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(checkFileEntryLine({ snapshotId, files: reversed })).toBe(checkFileEntryLine({ snapshotId, files }));
    expect(checkFileHeaderLine({ exportedAt: '2026-11-15T13:00:00+01:00', exportedBy })).toBe(checkFileHeaderLine(header));
    expect(checkFileHeaderLine(header)).toBe(`{"format":"passage-checks","format_version":2,"exported_at":"${exportedAt}","exported_by":"${exportedBy}"}\n`);
    expect(checkFileTrailerLine(0)).toBe('{"end":"passage-checks","checks":0}\n');
  });

  it('digests the files by name and length-prefixed text, so no two file sets give the same input', () => {
    const base = { 'findings.json': 'ab', 'briefing.json': 'c' };
    const digest = checkFilesDigest(base)!;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(checkFilesDigest({ 'briefing.json': 'c', 'findings.json': 'ab' })).toBe(digest);
    for (const other of [
      { 'findings.json': 'a', 'briefing.json': 'bc' },
      { 'findings.json': 'abc' },
      { 'findings.json': 'ab', 'briefing.json': 'c', 'plume.json': '' },
      { 'findings.json': 'ab', 'route.json': 'c' },
      { 'findings.json': 'ab', 'briefing.json': 'd' },
      { 'findings.json': 'findings.json\n2\nab', 'briefing.json': 'c' },
    ]) expect(checkFilesDigest(other)).not.toBe(digest);
    expect(checkFilesDigest({ 'notes.json': '{}' })).toBeNull();
    expect(checkFilesDigest({ 'plume.json': { a: 1 } })).toBeNull();
    expect(checkFilesDigest('files')).toBeNull();
  });

  it.each([
    ['an extra key', (e: J) => { e.note = 'x'; }],
    ['no files_digest', (e: J) => { delete e.files_digest; }],
    ['no snapshot_id', (e: J) => { delete e.snapshot_id; }],
    ['its keys in another order', (e: J) => { const { snapshot_id: s, ...rest } = e; for (const key of Object.keys(e)) delete e[key]; Object.assign(e, rest, { snapshot_id: s }); }],
    ['a digest in capitals', (e: J) => { e.files_digest = e.files_digest.toUpperCase(); }],
    ['a digest that is a number', (e: J) => { e.files_digest = 12; }],
  ])('refuses a line with %s as not a check line', (_case, change) => { lineRefused(rewritten(change), 'line'); });

  it.each([
    ['a version-1 document', () => checkFileText(buildCheckFile({ ...earlier(), ...header }))],
    ['a header', () => checkFileHeaderLine(header).slice(0, -1)],
    ['a carriage return before the newline', () => `${lineOf()}\r`],
    ['a space before it', () => ` ${lineOf()}`],
    ['not JSON', () => '{"snapshot_id":'],
    ['a JSON array that ends like an object', () => '[{}]'],
    ['the key __proto__', () => lineOf().replace('{', '{"__proto__":{"polluted":true},')],
    ['a repeated key', () => lineOf().replace('{', '{"files_digest":"0123456789abcdef",')],
    ['nesting deeper than 64 levels', () => rewritten((e) => { e.files = JSON.parse(`${'{"a":'.repeat(70)}1${'}'.repeat(70)}`); })],
  ])('refuses %s as not a check line', (_case, make) => {
    lineRefused(make(), 'line');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a line whose files do not give their digest, before proving the check', () => {
    // a digest one hex off; then one file changed by one character, the digest kept
    lineRefused(rewritten((e) => { e.files_digest = `${e.files_digest.slice(0, -1)}${e.files_digest.endsWith('0') ? '1' : '0'}`; }), 'digest');
    const changed = lineRefused(rewritten((e) => { e.files['briefing.json'] = e.files['briefing.json'].replace('"', ' "'); }), 'digest');
    expect(changed.ok || changed.detail).toBe('files that do not give their digest');
    // a file dropped from the line, the digest kept
    lineRefused(rewritten((e) => { delete e.files['plume.json']; }), 'digest');
  });

  it('keeps the version-1 proof\'s reason for a line whose digest holds', () => {
    const redigested = (change: (files: J) => void) => rewritten((e) => { change(e.files); e.files_digest = checkFilesDigest(e.files); });
    const manifest = (change: (m: J) => J) => redigested((files) => { files['snapshot.json'] = JSON.stringify(change(JSON.parse(files['snapshot.json'])), null, 2); });
    lineRefused(manifest((m) => ({ ...m, verdict_state: 'within' })), 'damaged');
    lineRefused(redigested((files) => { files['plume.json'] = files['plume.json'].replace('{', '{"model": "x", "\\u006dodel": "y",'); }), 'damaged');
    lineRefused(redigested((files) => { files['decision-inputs.json'] = files['decision-inputs.json'].replace('{', '{"extra":1,'); }), 'damaged');
    lineRefused(manifest((m) => ({ ...m, created_at: '2099-01-01T00:00:00.000Z' })), 'future-time', { nowMs: NOW_MS, boundTime: true });
    // without the bound (an export) the same line is a check
    expect(parseCheckFileEntryLine(manifest((m) => ({ ...m, created_at: '2099-01-01T00:00:00.000Z' })), { nowMs: NOW_MS }).ok).toBe(true);
    // the contract callback runs as in version 1
    expect(parseCheckFileEntryLine(lineOf(), { nowMs: NOW_MS, validateFile: (name) => name !== 'plume.json' }))
      .toMatchObject({ ok: false, problem: 'damaged-line', reason: 'damaged', detail: 'plume.json does not match its contract' });
    // files no digest can cover: the proof says why
    lineRefused(rewritten((e) => { e.files['imported.json'] = '{}'; }), 'damaged');
    lineRefused(rewritten((e) => { e.files['plume.json'] = { a: 1 }; }), 'damaged');
    lineRefused(rewritten((e) => { e.files = 'files'; }), 'damaged');
  });

  it('never quotes a key or other content in its reasons', () => {
    const lines = [
      lineOf().replace('{', '{"secret-key-name":1,"secret-key-name":2,'),
      rewritten((e) => { e['secret-key-name'] = 1; }),
      rewritten((e) => { e.files['plume.json'] = e.files['plume.json'].replace('{', '{"secret-key-name": 1, "secret-key-name": 2,'); e.files_digest = checkFilesDigest(e.files); }),
    ];
    for (const line of lines) expect(JSON.stringify(parseCheckFileEntryLine(line, { nowMs: NOW_MS }))).not.toContain('secret');
    expect(JSON.stringify(parseCheckFileHeader('{"format":"passage-checks","secret-key-name":1,"secret-key-name":2}'))).not.toContain('secret');
    expect(JSON.stringify(parseCheckFileTrailer('{"end":"passage-checks","secret-key-name":1}', 0))).not.toContain('secret');
  });

  describe('the header', () => {
    const line = (value: Record<string, unknown>) => JSON.stringify(value);
    const valid = { format: 'passage-checks', format_version: 2, exported_at: exportedAt, exported_by: exportedBy };
    it('tells a newer format version apart', () => {
      expect(parseCheckFileHeader(line({ ...valid, format_version: 4 }))).toMatchObject({ ok: false, problem: 'newer-version' });
      expect(parseCheckFileHeader(line({ ...valid, format_version: 4, more: true }))).toMatchObject({ ok: false, problem: 'newer-version' });
    });
    it.each([
      ['version 1', line({ ...valid, format_version: 1 })],
      ['a version-1 document', checkFileText(buildCheckFile({ ...earlier(), ...header }))],
      ['a version-1 document of version 2', line({ ...valid, checks: [] })],
      ['a version that is text', line({ ...valid, format_version: '2' })],
      ['another format', line({ ...valid, format: 'passage-routes' })],
      ['an extra key', line({ ...valid, note: 'x' })],
      ['no exporting version', line({ format: 'passage-checks', format_version: 2, exported_at: exportedAt })],
      ['its keys in another order', line({ format_version: 2, format: 'passage-checks', exported_at: exportedAt, exported_by: exportedBy })],
      ['a time that is not ISO UTC as written', line({ ...valid, exported_at: '2026-11-15T12:00:00Z' })],
      ['no time', line({ ...valid, exported_at: 'later' })],
      ['an exporting version of 201 characters', line({ ...valid, exported_by: 'x'.repeat(201) })],
      ['a blank exporting version', line({ ...valid, exported_by: '  ' })],
      ['spaces between its tokens', JSON.stringify(valid, null, 1).replace(/\n/g, '')],
      ['a carriage return', `${line(valid)}\r`],
      ['an escape the writer never writes', line(valid).replace('Passage', '\\u0050assage')],
      ['a repeated key', line(valid).replace('{', '{"format":"passage-checks",')],
      ['more than 4 KiB', line({ ...valid, exported_by: 'x'.repeat(5000) })],
      ['not JSON', 'passage-checks'],
    ])('refuses %s as not a version-2 header', (_case, text) => {
      expect(parseCheckFileHeader(text)).toMatchObject({ ok: false, problem: 'not-check-file' });
    });
    it('takes an exporting version of 1 to 200 printable ASCII characters only, writing and reading', () => {
      for (const by of ['x', 'Passage engine 0.2.0 (test) ~!', ' '.repeat(10) + 'x', '~'.repeat(200)]) {
        expect(parseCheckFileHeader(checkFileHeaderLine({ exportedAt, exportedBy: by }).slice(0, -1))).toEqual({ ok: true, header: { exportedAt, exportedBy: by }, version: 2 });
      }
      for (const by of ['Passage engine 0.2.0 · Île', 'tab\there', 'new\nline', 'nul\u0000', 'del\u007f', '🌊', '~'.repeat(201), '', '   ']) {
        expect(() => checkFileHeaderLine({ exportedAt, exportedBy: by })).toThrow(/version/);
        expect(parseCheckFileHeader(line({ ...valid, exported_by: by }))).toMatchObject({ ok: false, problem: 'not-check-file', detail: 'no exporting version' });
      }
    });
  });

  describe('the trailer', () => {
    it.each([
      ['a count other than the checks read', '{"end":"passage-checks","checks":3}', 2, 'trailer'],
      ['a missing count', '{"end":"passage-checks"}', 0, 'trailer'],
      ['a count that is text', '{"end":"passage-checks","checks":"2"}', 2, 'trailer'],
      ['a negative count', '{"end":"passage-checks","checks":-1}', -1, 'trailer'],
      ['a fractional count', '{"end":"passage-checks","checks":1.5}', 1.5, 'trailer'],
      ['another end', '{"end":"passage-routes","checks":2}', 2, 'trailer'],
      ['an extra key', '{"end":"passage-checks","checks":2,"more":true}', 2, 'trailer'],
      ['its keys in another order', '{"checks":2,"end":"passage-checks"}', 2, 'trailer'],
      ['a carriage return', '{"end":"passage-checks","checks":2}\r', 2, 'trailer'],
      ['a count written 2.0', '{"end":"passage-checks","checks":2.0}', 2, 'trailer'],
      ['a check line', null, 1, 'trailer'],
      ['more than 1,000 checks', '{"end":"passage-checks","checks":1001}', 1001, 'check-count'],
    ])('refuses %s', (_case, text, read, problem) => {
      expect(parseCheckFileTrailer(text ?? lineOf(), read as number)).toMatchObject({ ok: false, problem });
    });
    it('reads 0 and 1,000 checks', () => {
      expect(parseCheckFileTrailer(checkFileTrailerLine(0).slice(0, -1), 0)).toEqual({ ok: true, checks: 0 });
      expect(parseCheckFileTrailer(checkFileTrailerLine(1000).slice(0, -1), 1000)).toEqual({ ok: true, checks: 1000 });
    });
  });

  it('refuses to write what it would not read', () => {
    expect(() => checkFileTrailerLine(1001)).toThrow();
    expect(() => checkFileTrailerLine(-1)).toThrow();
    expect(() => checkFileTrailerLine(1.5)).toThrow();
    expect(() => checkFileHeaderLine({ exportedAt, exportedBy: ' ' })).toThrow(/version/);
    expect(() => checkFileHeaderLine({ exportedAt, exportedBy: 'x'.repeat(201) })).toThrow(/version/);
    expect(() => checkFileHeaderLine({ exportedAt: 'soon', exportedBy })).toThrow(/time/);
    expect(() => checkFileEntryLine({ snapshotId: '20260720T060000Z_44d2cd5f_64ea971e', files: earlier().files })).toThrow(/v2 check/);
    expect(() => checkFileEntryLine({ snapshotId: earlier().snapshotId, files: { ...earlier().files, 'imported.json': '{}' } })).toThrow(/imported\.json/);
  });

  it('names the file by the UTC date and minute it is made, across midnight', () => {
    expect(allChecksFileName('2026-11-15T23:59:59.999Z')).toBe('passage-all-checks-2026-11-15-2359Z.json.gz');
    expect(allChecksFileName('2026-11-16T00:00:00.000Z')).toBe('passage-all-checks-2026-11-16-0000Z.json.gz');
    expect(allChecksFileName('2026-11-16T00:30:00+01:00')).toBe('passage-all-checks-2026-11-15-2330Z.json.gz');
    expect(allChecksFileName('2026-11-15T23:45:00-02:00')).toBe('passage-all-checks-2026-11-16-0145Z.json.gz');
    expect(() => allChecksFileName('tomorrow')).toThrow();
  });

  it('is fixed: the exact texts of a small check, and the digest computed from its definition', () => {
    // files given out of order, a text with a character outside the Basic Multilingual Plane, an empty text, a newline
    const files = { 'route.json': 'line\nbreak', 'briefing.json': '', 'findings.json': '{}', 'decision-inputs.json': '{"name":"Île 🌊"}', 'snapshot.json': '{"k":1}' };
    const ordered = ['snapshot.json', 'decision-inputs.json', 'findings.json', 'briefing.json', 'route.json'];
    // FNV-1a 64 by its definition, on BigInt: name, U+000A, UTF-16 length in decimal, U+000A, text
    let input = '';
    for (const name of ordered) input += `${name}\n${files[name as keyof typeof files].length}\n${files[name as keyof typeof files]}`;
    expect(input).toContain('decision-inputs.json\n17\n');
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i++) h = ((h ^ BigInt(input.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
    expect(h.toString(16).padStart(16, '0')).toBe('338e411f350e89c1');
    expect(checkFilesDigest(files)).toBe('338e411f350e89c1');
    expect(checkFileHeaderLine({ exportedAt: '2026-11-15T12:00:00Z', exportedBy: 'Passage engine 0.2.0' }))
      .toBe('{"format":"passage-checks","format_version":2,"exported_at":"2026-11-15T12:00:00.000Z","exported_by":"Passage engine 0.2.0"}\n');
    expect(checkFileEntryLine({ snapshotId: 'snapshot_v2_0123456789abcdef', files }))
      .toBe('{"snapshot_id":"snapshot_v2_0123456789abcdef","files":{"snapshot.json":"{\\"k\\":1}","decision-inputs.json":"{\\"name\\":\\"Île 🌊\\"}","findings.json":"{}","briefing.json":"","route.json":"line\\nbreak"},"files_digest":"338e411f350e89c1"}\n');
    expect(checkFileTrailerLine(7)).toBe('{"end":"passage-checks","checks":7}\n');
    expect(CHECK_FILE_V2_TRAILER_PREFIX).toBe('{"end":');
  });

  it('keeps version 1 as it was and sets the version-2 caps', () => {
    expect(CHECK_FILE_VERSION).toBe(1);
    expect(CHECK_FILE_V2_VERSION).toBe(2);
    expect([CHECK_FILE_MAX_COMPRESSED_BYTES, CHECK_FILE_MAX_TEXT_BYTES]).toEqual([16 * 1024 * 1024, 64 * 1024 * 1024]);
    expect(CHECK_FILE_V2_MAX_COMPRESSED_BYTES).toBe(2 ** 30);
    expect(CHECK_FILE_V2_MAX_LINE_BYTES).toBe(64 * 2 ** 20);
    expect(CHECK_FILE_V2_MAX_EDGE_BYTES).toBe(4096);
    expect(CHECK_FILE_V2_MAX_CHECKS).toBe(1000);
    expect(CHECK_FILE_V2_MAX_INFLATED_BYTES).toBe(8 * 2 ** 30);
    // a version-2 header is not a version-1 document
    expect(parseCheckFile(checkFileHeaderLine(header), { nowMs: NOW_MS })).toMatchObject({ ok: false, problem: 'newer-version' });
  });
});

// The check file, version 3: version 2 with exactly one names line after the header.
describe('check file, version 3', () => {
  const exportedAt3 = '2026-11-15T12:00:00Z';
  const pinned = [{ passage_id: '0b6f4c1e-7d2a-4c4e-9f3b-2a1d5e6c7b80', name: 'Autumn delivery, Cherbourg → Plymouth' }];
  /** FNV-1a 64 by its definition, on BigInt, over the names line's digest input. */
  const fnvByDefinition = (names: Array<{ passage_id: string; name: string }>) => {
    let input = '';
    for (const { passage_id: id, name } of names) input += `${id}\n${name.length}\n${name}`;
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i++) h = ((h ^ BigInt(input.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
    return h.toString(16).padStart(16, '0');
  };
  const refused = (line: string) => {
    const result = parseCheckFileNames(line);
    expect(result, line.slice(0, 120)).toMatchObject({ ok: false, problem: 'names' });
    return result;
  };
  // a names line with these entries and, unless given, the digest they would have (a stand-in where none can be computed)
  const digestOf = (list: unknown) => { try { return checkNamesDigest(list as never); } catch { return '0123456789abcdef'; } };
  const names = (list: unknown, digest?: string) => JSON.stringify({ names: list, names_digest: digest ?? digestOf(list) });

  it('is fixed: the exact header and names line of a small file, and the digest computed from its definition', () => {
    expect(CHECK_FILE_V3_VERSION).toBe(3);
    expect(checkFileHeaderLine({ exportedAt: exportedAt3, exportedBy: 'Passage engine 0.2.0', version: 3 }))
      .toBe('{"format":"passage-checks","format_version":3,"exported_at":"2026-11-15T12:00:00.000Z","exported_by":"Passage engine 0.2.0"}\n');
    expect(fnvByDefinition(pinned)).toBe('21f34bf459ab4d61');
    expect(checkNamesDigest(pinned)).toBe('21f34bf459ab4d61');
    expect(checkFileNamesLine(pinned)).toBe('{"names":[{"passage_id":"0b6f4c1e-7d2a-4c4e-9f3b-2a1d5e6c7b80","name":"Autumn delivery, Cherbourg → Plymouth"}],"names_digest":"21f34bf459ab4d61"}\n');
    expect(checkFileNamesLine([])).toBe('{"names":[],"names_digest":"cbf29ce484222325"}\n');
    expect(fnvByDefinition([])).toBe(CHECK_FILE_V3_EMPTY_NAMES_DIGEST);
    expect(CHECK_FILE_V3_NAMES_PREFIX).toBe('{"names":');
    expect([CHECK_FILE_V3_MAX_NAMES, CHECK_FILE_V3_MAX_NAMES_LINE_BYTES]).toEqual([1000, 512 * 1024]);
    // version 2's header is untouched, and stays the default
    expect(checkFileHeaderLine({ exportedAt: exportedAt3, exportedBy: 'Passage engine 0.2.0' })).toContain('"format_version":2,');
  });

  it('reads a version-3 header with its version, and calls version 4 newer', () => {
    const line = checkFileHeaderLine({ exportedAt, exportedBy, version: 3 }).slice(0, -1);
    expect(parseCheckFileHeader(line)).toEqual({ ok: true, header: { exportedAt, exportedBy }, version: 3 });
    expect(parseCheckFileHeader(line.replace('"format_version":3', '"format_version":4'))).toMatchObject({ ok: false, problem: 'newer-version' });
    expect(() => checkFileHeaderLine({ exportedAt, exportedBy, version: 4 })).toThrow();
    expect(() => checkFileHeaderLine({ exportedAt, exportedBy, version: 1 })).toThrow();
  });

  it('writes names sorted by passage id in code-unit order, reads them back, and computes the digest by the definition', () => {
    const entries = [
      { passage_id: 'b', name: 'Île d’Yeu → Brest 🌊' },
      { passage_id: 'B', name: 'Crew 👩\u200D👩\u200D👧' },
      { passage_id: 'a-1', name: 'Solent "hop", 3 \\ 4' },
    ];
    const line = checkFileNamesLine(entries);
    expect(line.endsWith('}\n')).toBe(true);
    const sorted = [entries[1]!, entries[2]!, entries[0]!];
    expect(JSON.parse(line)).toEqual({ names: sorted, names_digest: fnvByDefinition(sorted) });
    expect(parseCheckFileNames(line.slice(0, -1))).toEqual({ ok: true, names: sorted });
    expect(checkFileNamesLine([...entries].reverse())).toBe(line);
  });

  it('refuses to write names the reader would refuse', () => {
    expect(() => checkFileNamesLine([{ passage_id: 'a', name: 'x' }, { passage_id: 'a', name: 'y' }])).toThrow();
    expect(() => checkFileNamesLine([{ passage_id: 'a b', name: 'x' }])).toThrow();
    expect(() => checkFileNamesLine([{ passage_id: 'a', name: ' x' }])).toThrow();
    expect(() => checkFileNamesLine([{ passage_id: 'a', name: '' }])).toThrow();
    expect(() => checkFileNamesLine(Array.from({ length: 1001 }, (_, i) => ({ passage_id: `p${String(i).padStart(4, '0')}`, name: 'x' })))).toThrow();
    expect(checkFileNamesLine(Array.from({ length: 1000 }, (_, i) => ({ passage_id: `${'p'.repeat(124)}${String(i).padStart(4, '0')}`, name: 'é'.repeat(80) }))).length).toBeGreaterThan(200_000);
  });

  it.each([
    ['not JSON', () => '{"names":['],
    ['a space inside', () => checkFileNamesLine(pinned).slice(0, -1).replace('"names":', '"names": ')],
    ['a carriage return', () => `${checkFileNamesLine(pinned).slice(0, -1)}\r`],
    ['keys in another order', () => JSON.stringify({ names_digest: checkNamesDigest(pinned), names: pinned })],
    ['an extra key', () => JSON.stringify({ names: pinned, names_digest: checkNamesDigest(pinned), more: 1 })],
    ['no digest', () => JSON.stringify({ names: pinned })],
    ['a digest in capitals', () => names(pinned, checkNamesDigest(pinned).toUpperCase())],
    ['a wrong digest', () => names(pinned, '0123456789abcdef')],
    ['names that are not a list', () => names({ a: 1 })],
    ['an entry with keys in another order', () => names([{ name: 'x', passage_id: 'a' }])],
    ['an entry with an extra key', () => names([{ passage_id: 'a', name: 'x', more: 1 }])],
    ['an entry that is not an object', () => names(['a'])],
    ['a passage id with a space', () => names([{ passage_id: 'a b', name: 'x' }])],
    ['an empty passage id', () => names([{ passage_id: '', name: 'x' }])],
    ['a passage id of 129 characters', () => names([{ passage_id: 'a'.repeat(129), name: 'x' }])],
    ['a passage id outside ASCII', () => names([{ passage_id: 'é', name: 'x' }])],
    ['a passage id that is a number', () => names([{ passage_id: 1, name: 'x' }])],
    ['an empty name', () => names([{ passage_id: 'a', name: '' }])],
    ['a name with a right-to-left override', () => names([{ passage_id: 'a', name: 'a\u202Eb' }])],
    ['a name with a double space', () => names([{ passage_id: 'a', name: 'a  b' }])],
    ['a name of 81 characters', () => names([{ passage_id: 'a', name: 'x'.repeat(81) }])],
    ['a name that is a number', () => names([{ passage_id: 'a', name: 1 }])],
    ['names out of order', () => names([{ passage_id: 'b', name: 'x' }, { passage_id: 'a', name: 'y' }])],
    ['a passage twice', () => names([{ passage_id: 'a', name: 'x' }, { passage_id: 'a', name: 'x' }])],
    ['1,001 names', () => names(Array.from({ length: 1001 }, (_, i) => ({ passage_id: `p${String(i).padStart(4, '0')}`, name: 'x' })))],
    ['a repeated key', () => checkFileNamesLine(pinned).slice(0, -1).replace('{"names":', '{"names":[],"names":')],
    ['the key __proto__', () => checkFileNamesLine(pinned).slice(0, -1).replace('{"names":', '{"__proto__":{},"names":')],
    ['a check line', () => checkFileTrailerLine(0).slice(0, -1)],
    ['over 512 KiB', () => names([{ passage_id: 'a', name: 'x' }]).replace('"x"', `"${'x'.repeat(80)}"`).padEnd(512 * 1024 + 10, ' ')],
  ])('refuses a names line with %s, never quoting it', (_case, make) => {
    const result = refused(make());
    expect(JSON.stringify(result)).not.toMatch(/Autumn|Cherbourg|0b6f4c1e/);
  });

  it('keeps names cleaned by the one rule, and only those', () => {
    for (const name of ['Brest → Yeu', 'Crew 👩\u200D👩\u200D👧', 'x'.repeat(80)]) {
      expect(cleanPassageName(name)).toBe(name);
      expect(parseCheckFileNames(checkFileNamesLine([{ passage_id: 'a', name }]).slice(0, -1)).ok).toBe(true);
    }
  });
});
