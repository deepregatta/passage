import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { CHECK_FILE_NAMES, buildCheckFile, checkFileText } from '@deepweather/engine';
import { gunzipText, gzipText } from '../src/lib/snapshotCodec.js';
import { checkFileOf, fileOf, makeCheck, scenarioSynoptic } from './helpers/checkFiles.js';

// Importing one check from a file (lib/checkImport.js). The file is hostile:
// each refusal leaves the store byte for byte as it was. Scratch IndexedDB only
// (fake-indexeddb, a fresh factory per test); the served catalogue is the setup's.
vi.setConfig({ testTimeout: 30_000 });

let original, other, localSnapshots, checkImport, checkFile;
beforeAll(async () => {
  original = await makeCheck();
  other = await makeCheck({ passageId: 'passage-other', departureUtc: '2026-07-21T06:00:00Z' });
});
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  checkImport = await import('../src/lib/checkImport.js');
  checkFile = await import('../src/lib/checkFile.js');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// the served catalogue's ids as the page read them (the setup's demo pair), and the import time
const SERVED = new Set(['snapshot_v2_406ad333228b0a73', 'snapshot_v2_8ca29e5bd5a065f3']);
const IMPORT_MS = Date.parse('2026-11-16T09:00:00Z');
const importFile = (file, options = {}) => checkImport.importCheckFile(file, { servedIds: SERVED, nowMs: IMPORT_MS, ...options });
const fileFor = async (check) => fileOf((await checkFileOf(check)).bytes);
const savedFiles = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));

/** Every record of the store as IndexedDB holds it, bytes included: the proof that nothing was written. */
async function dump() {
  await localSnapshots.list();
  const db = await new Promise((done) => { const request = indexedDB.open('passage-local-snapshots'); request.onsuccess = () => done(request.result); });
  const records = await new Promise((done) => { const request = db.transaction('files').objectStore('files').getAll(); request.onsuccess = () => done(request.result); });
  db.close();
  return JSON.stringify(records.map((record) => ({ ...record, content: typeof record.content === 'string' ? record.content : Array.from(record.content) })));
}

/** The document of a check file, edited, gzipped as a File. */
async function edited(change, check = original) {
  const document = JSON.parse((await checkFileOf(check)).text);
  const text = change(document) ?? JSON.stringify(document);
  return fileOf(await gzipText(typeof text === 'string' ? text : JSON.stringify(text)));
}
const editFile = (name, change, check = original) => edited((document) => {
  const files = document.checks[0].files;
  files[name] = change(files[name], JSON.parse(files[name]));
}, check);

describe('a check file that holds a valid check', () => {
  it('is stored exactly as given, marked as imported, and listed as imported', async () => {
    const result = await importFile(await fileFor(original), { nowMs: Date.parse('2026-11-16T09:00:00Z') });
    expect(result).toEqual({ outcome: checkImport.IMPORT.imported, snapshotId: original.snapshotId, departureUtc: '2026-07-20T06:00:00Z' });
    for (const [name, text] of Object.entries(original.files)) expect(await localSnapshots.read(original.snapshotId, name)).toBe(text);
    expect(JSON.parse(await localSnapshots.read(original.snapshotId, 'imported.json'))).toEqual({
      imported_at: '2026-11-16T09:00:00.000Z', exported_at: '2026-11-15T12:00:00.000Z', exported_by: 'Passage engine 0.2.0',
    });
    const [entry] = await localSnapshots.list();
    expect(entry).toMatchObject({ snapshot_id: original.snapshotId, imported: true, local: true, passage_id: 'passage-import-test' });
    // stored the same way as a browser save: the large files compressed at rest
    const raw = JSON.parse(await dump());
    expect(raw.find((record) => record.filename === 'decision-inputs.json').encoding).toBe('gzip');
    expect(raw.find((record) => record.filename === 'snapshot.json').encoding).toBeUndefined();
    // the manifest's artifacts never name the marker
    expect(Object.values(JSON.parse(original.files['snapshot.json']).artifacts)).not.toContain('imported.json');
  });

  it('exports the original texts without the marker, and export → import in a clean store → export gives the same texts', async () => {
    await importFile(await fileFor(original));
    const first = JSON.parse(await gunzipText((await checkFile.prepareCheckFile(original.snapshotId)).bytes));
    expect(first.checks[0].files).toEqual(Object.fromEntries(CHECK_FILE_NAMES.filter((name) => name in original.files).map((name) => [name, original.files[name]])));
    expect(Object.keys(first.checks[0].files)).not.toContain('imported.json');
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    checkImport = await import('../src/lib/checkImport.js');
    checkFile = await import('../src/lib/checkFile.js');
    const again = fileOf(await gzipText(JSON.stringify(first)));
    expect((await importFile(again)).outcome).toBe(checkImport.IMPORT.imported);
    const second = JSON.parse(await gunzipText((await checkFile.prepareCheckFile(original.snapshotId)).bytes));
    expect(second.checks[0].files).toEqual(first.checks[0].files);
  });

  it('is already here when this browser holds the same check, saved or imported: nothing written, nothing marked', async () => {
    await localSnapshots.writeAll(original.snapshotId, savedFiles(original));
    const before = await dump();
    expect(await importFile(await fileFor(original))).toEqual({ outcome: checkImport.IMPORT.alreadyHere, snapshotId: original.snapshotId, departureUtc: '2026-07-20T06:00:00Z' });
    expect(await dump()).toBe(before);
    expect(await localSnapshots.read(original.snapshotId, 'imported.json')).toBeNull();
    expect((await localSnapshots.list())[0].imported).toBeUndefined();
  });

  it('conflicts with a different check stored under the same id, which stays untouched', async () => {
    // a damaged or older store: the id's records hold another check's decision inputs
    await localSnapshots.writeAll(original.snapshotId, savedFiles(original).map((file) => (file.filename === 'decision-inputs.json' ? { ...file, content: other.files['decision-inputs.json'] } : file)));
    const before = await dump();
    expect(await importFile(await fileFor(original))).toEqual({ outcome: checkImport.IMPORT.conflict });
    expect(await dump()).toBe(before);
  });

  it('reports a storage failure and leaves nothing behind', async () => {
    await localSnapshots.writeAll(other.snapshotId, savedFiles(other));
    const before = await dump();
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
      if (record.filename === 'imported.json') {
        const raw = this._rawObjectStore;
        const storeRecord = raw.storeRecord;
        raw.storeRecord = () => { raw.storeRecord = storeRecord; throw new DOMException('Quota exceeded.', 'QuotaExceededError'); };
      }
      return add.call(this, record);
    });
    expect(await importFile(await fileFor(original))).toEqual({ outcome: checkImport.IMPORT.storage });
    vi.mocked(IDBObjectStore.prototype.add).mockRestore();
    expect(await dump()).toBe(before);
    expect(await localSnapshots.exists(original.snapshotId)).toBe(false);
  });

  it('makes no request at all, so a page that loaded online imports offline', async () => {
    globalThis.fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    expect((await importFile(await fileFor(original))).outcome).toBe(checkImport.IMPORT.imported);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('a file that is refused writes nothing', () => {
  const zeros = (n) => new Uint8Array(n);
  const cases = [
    ['bytes that are not gzip', 'not-check-file', async () => fileOf(new TextEncoder().encode('{"format":"passage-checks"}'))],
    ['an empty file', 'not-check-file', async () => fileOf(new Uint8Array())],
    ['truncated gzip', 'damaged', async () => { const { bytes } = await checkFileOf(original); return fileOf(bytes.slice(0, Math.floor(bytes.length / 2))); }],
    ['gzip with corrupt bytes', 'damaged', async () => { const { bytes } = await checkFileOf(original); const bad = bytes.slice(); bad.fill(7, 20, 60); return fileOf(bad); }],
    ['a gzip bomb over the inflated cap', 'too-large', async () => fileOf(await gzipBytes(zeros(66 * 1024 * 1024)))],
    ['a file over 16 MB', 'too-large', async () => fileOf(new Uint8Array(16 * 1024 * 1024 + 1).fill(0x1f))],
    ['invalid UTF-8', 'damaged', async () => fileOf(await gzipBytes(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])))],
    ['JSON that is not a check file', 'not-check-file', async () => fileOf(await gzipText(JSON.stringify({ type: 'FeatureCollection', features: [] })))],
    ['text that is not JSON', 'not-check-file', async () => fileOf(await gzipText('passage-checks'))],
    ['a valid file of another format (GPX)', 'not-check-file', async () => fileOf(await gzipText('<?xml version="1.0"?><gpx version="1.1"><rte/></gpx>'))],
    ['a newer format version', 'newer-version', () => edited((d) => { d.format_version = 2; })],
    ['two checks', 'check-count', () => edited((d) => { d.checks.push(d.checks[0]); })],
    ['no check', 'check-count', () => edited((d) => { d.checks = []; })],
    ['a repeated key in the document', 'not-check-file', () => edited((d) => JSON.stringify(d).replace('"format":"passage-checks"', '"format":"passage-checks","format":"passage-checks"'))],
    ['a repeated key in a file', 'damaged', () => editFile('findings.json', (text) => text.replace('{', '{"snapshot_id": "x",'))],
    ['an import marker in the file', 'damaged', () => edited((d) => { d.checks[0].files['imported.json'] = '{}'; })],
    ['a file a check file cannot hold', 'damaged', () => edited((d) => { d.checks[0].files['changes.json'] = '{}'; })],
    ['decision inputs that no longer hash to the id', 'damaged', () => editFile('decision-inputs.json', (_text, value) => JSON.stringify({ ...value, departureUtc: '2026-07-20T07:00:00Z' }))],
    ['a manifest with another verdict', 'damaged', () => editFile('snapshot.json', (_text, value) => JSON.stringify({ ...value, verdict_state: 'exceeds' }))],
    ['findings with 200,000 legs', 'damaged', () => editFile('findings.json', (_text, value) => JSON.stringify({ ...value, legs: Array.from({ length: 200_000 }, (_, i) => ({ leg_id: `L${i + 1}` })) }))],
    ['a route with 200,000 waypoints', 'damaged', () => editFile('route.json', (_text, value) => JSON.stringify({ ...value, waypoints: Array.from({ length: 200_000 }, () => value.waypoints[0]) }))],
    ['findings of the wrong types (no schema passes them)', 'damaged', () => editFile('findings.json', (_text, value) => JSON.stringify({ ...value, legs: value.legs.map((leg) => ({ ...leg, hours: 'many' })) }))],
    ['a verdict of the wrong type everywhere', 'damaged', () => edited((d) => {
      const files = d.checks[0].files;
      files['findings.json'] = JSON.stringify({ ...JSON.parse(files['findings.json']), verdict: { ...JSON.parse(files['findings.json']).verdict, state: 42 } });
      files['snapshot.json'] = JSON.stringify({ ...JSON.parse(files['snapshot.json']), verdict_state: 42 });
    })],
    ['a chart path trying ..', 'damaged', () => edited((d) => {
      const files = d.checks[0].files;
      files['synoptic.json'] = JSON.stringify({ schema_version: 1, run_id: 'r', generated_at: '2026-07-19T18:00:00Z', systems: [], route_transitions: [], regimes: [], chart_captions: [{ file: 'runs/../../secret.png', step_h: 0 }] });
      const manifest = JSON.parse(files['snapshot.json']);
      files['snapshot.json'] = JSON.stringify({ ...manifest, artifacts: { ...manifest.artifacts, synoptic: 'synoptic.json' } });
    })],
    ['a route name changed to markup without its decision inputs', 'damaged', () => editFile('route.json', (_text, value) => JSON.stringify({ ...value, name: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }))],
    ['a check saved in the future (2099)', 'future-time', () => editFile('snapshot.json', (_text, value) => JSON.stringify({ ...value, created_at: '2099-01-01T00:00:00.000Z' }))],
    ['check sequence 0', 'damaged', () => editFile('snapshot.json', (_text, value) => JSON.stringify({ ...value, check_sequence: 0 }))],
    ['check sequence 1,000,000', 'damaged', () => editFile('snapshot.json', (_text, value) => JSON.stringify({ ...value, check_sequence: 1_000_000 }))],
    ['a manifest with a served check\'s demo flag', 'damaged', () => editFile('snapshot.json', (_text, value) => JSON.stringify({ ...value, demo: true }))],
    ['nesting 70 levels deep in a field the findings contract leaves open', 'damaged', () => editFile('findings.json', (_text, value) => JSON.stringify({ ...value, debug: JSON.parse(`${'['.repeat(70)}1${']'.repeat(70)}`) }))],
    ['a string over 64 KiB in findings', 'damaged', () => editFile('findings.json', (_text, value) => JSON.stringify({ ...value, debug: 'x'.repeat(70_000) }))],
    ['a check id Passage serves (the example)', 'served', async () => {
      const dir = resolve(import.meta.dirname, 'fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3');
      const files = Object.fromEntries(readdirSync(dir).filter((name) => CHECK_FILE_NAMES.includes(name) && name !== 'synoptic.json').map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
      const manifest = JSON.parse(files['snapshot.json']);
      delete manifest.artifacts.synoptic;
      files['snapshot.json'] = JSON.stringify(manifest, null, 2);
      return fileOf(await gzipText(checkFileText(buildCheckFile({ snapshotId: manifest.snapshot_id, files, exportedAt: '2026-11-15T12:00:00Z', exportedBy: 'x' }))));
    }],
  ];

  for (const key of ['__proto__', 'constructor']) {
    cases.push([`the key "${key}" in every file`, 'damaged', () => edited((d) => {
      for (const name of Object.keys(d.checks[0].files)) d.checks[0].files[name] = d.checks[0].files[name].replace('{', `{"${key}": {"polluted": true},`);
    })]);
  }

  it.each(cases)('%s → %s', async (_case, outcome, make) => {
    await localSnapshots.writeAll(other.snapshotId, savedFiles(other));
    const before = await dump();
    const file = await make();
    expect(await importFile(file)).toEqual({ outcome });
    expect(await dump()).toBe(before);
    expect(({}).polluted).toBeUndefined();
    // the reason is logged; never the file's content, names or positions
    for (const [line] of vi.mocked(console.error).mock.calls) expect(String(line)).not.toMatch(/Newport|New York|-7\d\.\d|4\d\.\d{2}|<img|alert/);
  });

  it('refuses boat polar data in any file text', async () => {
    const key = ['speeds', 'kt'].join('_');
    // a field the findings contract leaves open, so only the safety net stops it
    const file = await editFile('findings.json', (_text, value) => JSON.stringify({ ...value, debug: { [key]: [[4.1, 5.2], [6.3, 7.4]] } }));
    const before = await dump();
    expect(await importFile(file)).toEqual({ outcome: checkImport.IMPORT.polar });
    expect(await dump()).toBe(before);
  });

  it('imports nothing when this page never read the served ids', async () => {
    const before = await dump();
    expect(await importFile(await fileFor(original), { servedIds: null })).toEqual({ outcome: checkImport.IMPORT.offline });
    expect(await dump()).toBe(before);
  });

  // invented, polar-shaped and built at run time, so this source holds no polar table
  const key = ['speeds', 'kt'].join('_');
  const table = `[[4.1, 5.2], [6.3, 7.4]]`;
  it.each([
    ['behind a unicode-escaped key', (text) => text.replace('{', `{"debug": {"${key.replace('_', '\\u005f')}": ${table}},`)],
    ['inside a JSON string', (text) => text.replace('{', `{"debug": ${JSON.stringify(JSON.stringify({ [key]: [[4.1, 5.2], [6.3, 7.4]] }))},`)],
  ])('refuses boat polar data %s', async (_case, plant) => {
    const file = await editFile('findings.json', (text) => plant(text));
    const before = await dump();
    expect(await importFile(file)).toEqual({ outcome: checkImport.IMPORT.polar });
    expect(await dump()).toBe(before);
  });
});

/** gzip of raw bytes (not text). */
async function gzipBytes(bytes) {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }).pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('every check the engine can make round-trips: export → import in a clean store → export', () => {
  const variants = [
    ['the calm check', {}],
    ['another passage and departure', { passageId: 'passage-round-trip', departureUtc: '2026-07-22T18:30:00Z' }],
    ['a name outside Latin-1, with markup, saved as typed', { name: 'Île d’Yeu → Brest 🌊 <b>bold</b> & “quotes”' }],
    ['a synoptic without route_transitions (engine scenario)', { synoptic: scenarioSynoptic('reference-demo') }],
    ['the storm scenario synoptic', { synoptic: scenarioSynoptic('storm'), departureUtc: '2026-07-20T12:00:00Z' }],
    ['a route with a boat reference', { routeExtras: { provenance: { routing_request: { polar_id: 'invented-boat-34', polar_scaling: 0.85 } } } }],
  ];
  it.each(variants)('%s', async (_case, options) => {
    const check = await makeCheck(options);
    expect(check.snapshotId).toMatch(/^snapshot_v2_[0-9a-f]{16}$/);
    if (options.synoptic) expect(JSON.parse(check.files['synoptic.json']).route_transitions).toBeUndefined();
    await localSnapshots.writeAll(check.snapshotId, savedFiles(check));
    const first = await checkFile.prepareCheckFile(check.snapshotId, { nowMs: IMPORT_MS });
    const firstFiles = JSON.parse(await gunzipText(first.bytes)).checks[0].files;
    expect(firstFiles).toEqual(Object.fromEntries(CHECK_FILE_NAMES.filter((name) => name in check.files).map((name) => [name, check.files[name]])));
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    checkImport = await import('../src/lib/checkImport.js');
    checkFile = await import('../src/lib/checkFile.js');
    expect((await importFile(fileOf(first.bytes), { nowMs: IMPORT_MS + 1000 })).outcome).toBe(checkImport.IMPORT.imported);
    const second = await checkFile.prepareCheckFile(check.snapshotId, { nowMs: IMPORT_MS + 2000 });
    expect(JSON.parse(await gunzipText(second.bytes)).checks[0].files).toEqual(firstFiles);
    expect(second.name).toBe(first.name);
  });
});

describe('times and sequences from another device', () => {
  it('imports a check saved with a clock 10 minutes fast, exported after the clock was corrected', async () => {
    // saved at 18:10 by a device 10 minutes fast; exported at 18:05 after the correction
    const fast = await makeCheck({ passageId: 'passage-fast-clock', nowMs: Date.parse('2026-07-19T18:10:00Z') });
    await localSnapshots.writeAll(fast.snapshotId, savedFiles(fast));
    const copy = await checkFile.prepareCheckFile(fast.snapshotId, { nowMs: Date.parse('2026-07-19T18:05:00Z') });
    const document = JSON.parse(await gunzipText(copy.bytes));
    expect(Date.parse(document.exported_at)).toBeLessThan(Date.parse(JSON.parse(document.checks[0].files['snapshot.json']).created_at));
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    checkImport = await import('../src/lib/checkImport.js');
    // a device with the correct clock, at 18:06
    expect((await importFile(fileOf(copy.bytes), { nowMs: Date.parse('2026-07-19T18:06:00Z') })).outcome).toBe(checkImport.IMPORT.imported);
  });

  it('imports a file whose exported_at is earlier than the check\'s save time', async () => {
    const file = await edited((d) => { d.exported_at = '2026-07-01T00:00:00.000Z'; });
    expect((await importFile(file)).outcome).toBe(checkImport.IMPORT.imported);
  });

  it('leaves a forged sequence of 999,999 out of the sailor\'s next check, which exports and re-imports cleanly', async () => {
    const { persistSnapshot, runAnalysis, ScenarioBundleStore } = await import('@deepweather/engine');
    const forged = await makeCheck({ passageId: 'passage-own', nowMs: Date.parse('2026-07-19T12:00:00Z') });
    const manifest = JSON.parse(forged.files['snapshot.json']);
    const file = await editFile('snapshot.json', () => JSON.stringify({ ...manifest, check_sequence: 999_999 }, null, 2), forged);
    expect((await importFile(file)).outcome).toBe(checkImport.IMPORT.imported);
    // the sailor's own next check of that passage, saved the way the browser saves one
    const store = {
      exists: (snapshotId) => localSnapshots.exists(snapshotId),
      read: (snapshotId, name) => localSnapshots.read(snapshotId, name),
      list: () => localSnapshots.list(),
      write: (snapshotId, name, content) => localSnapshots.write(snapshotId, name, content),
      writeAll: (snapshotId, files) => localSnapshots.writeAll(snapshotId, files),
    };
    const route = JSON.parse(forged.files['route.json']);
    const profile = JSON.parse(forged.files['decision-inputs.json']).profile;
    const read = (path) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf8'));
    const scenario = new ScenarioBundleStore({ loadBundle: async (bundle) => read(`../../engine/test/fixtures/scenarios/calm/${bundle}.json`) });
    const result = await runAnalysis({ route, profile, departureUtc: '2026-07-21T06:00:00Z', store: scenario, now: () => Date.parse('2026-07-19T19:00:00Z') });
    const ownId = await persistSnapshot(store, result, route, Date.parse('2026-07-19T19:00:00Z'));
    // the number it would have had without the import: the passage's first own check
    expect(JSON.parse(await localSnapshots.read(ownId, 'snapshot.json')).check_sequence).toBe(1);
    const copy = await checkFile.prepareCheckFile(ownId, { nowMs: IMPORT_MS });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    checkImport = await import('../src/lib/checkImport.js');
    expect((await importFile(fileOf(copy.bytes))).outcome).toBe(checkImport.IMPORT.imported);
  });
});
