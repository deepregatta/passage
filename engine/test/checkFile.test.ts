import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_FILE_FORMAT, CHECK_FILE_NAMES, CHECK_FILE_REQUIRED, CHECK_FILE_VERSION, buildCheckFile, checkFileName, checkFileText, checkHex, contentHash,
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
