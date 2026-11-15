import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_FILE_FORMAT, CHECK_FILE_NAMES, CHECK_FILE_REQUIRED, CHECK_FILE_VERSION, buildCheckFile, checkFileName, checkFileText, checkHex, contentHash,
  jsonKeyProblem, parseCheckFile, SNAPSHOT_ARTIFACT_FILES, SNAPSHOT_MANIFEST_KEYS, CHECK_FILE_MAX_SEQUENCE,
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
