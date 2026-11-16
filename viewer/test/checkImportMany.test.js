import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import * as engine from '@deepweather/engine';
import { checkFileOf, fileOf, makeCheck } from './helpers/checkFiles.js';

// Importing many checks from one version-2 file (lib/checkImportMany.js). Scratch
// IndexedDB only (fake-indexeddb, a fresh factory per test), checks the engine makes,
// files gzipped by node:zlib and read through Node's own File (jsdom's has no stream()).
vi.mock('@deepweather/engine', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, parseCheckFileEntryLine: vi.fn(original.parseCheckFileEntryLine) };
});
vi.setConfig({ testTimeout: 60_000 });

const { CHECK_FILE_NAMES, buildCheckFile, checkFileEntryLine, checkFileHeaderLine, checkFileText, checkFileTrailerLine, checkFilesDigest } = engine;
const SERVED = new Set(['snapshot_v2_406ad333228b0a73', 'snapshot_v2_8ca29e5bd5a065f3']);
const NOW = Date.parse('2026-11-16T09:00:00Z');
const exportedAt = '2026-11-15T12:00:00.000Z';
const exportedBy = 'Passage engine 0.2.0';
const HEADER = checkFileHeaderLine({ exportedAt, exportedBy });
const savedFiles = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));
const lineOf = (check) => checkFileEntryLine(check).slice(0, -1);
/** A version-2 file of these lines (texts without newlines), its trailer counting them unless told. */
const backupOf = (lines, trailer = checkFileTrailerLine(lines.length)) => HEADER + lines.map((line) => `${line}\n`).join('') + trailer;
const fileFrom = (text) => new NodeFile([gzipSync(text)], 'passage-all-checks.json.gz', { type: 'application/gzip' });

let a, b, c, pre;
let localSnapshots, many, checkImport;
beforeAll(async () => {
  a = await makeCheck({ passageId: 'passage-a', nowMs: Date.parse('2026-07-19T10:00:00Z') });
  b = await makeCheck({ passageId: 'passage-b', departureUtc: '2026-07-21T06:00:00Z', nowMs: Date.parse('2026-07-19T11:00:00Z'), name: 'Île d’Yeu → Brest 🌊' });
  c = await makeCheck({ passageId: 'passage-c', departureUtc: '2026-07-22T06:00:00Z', nowMs: Date.parse('2026-07-19T12:00:00Z') });
  pre = await makeCheck({ passageId: 'passage-pre', departureUtc: '2026-07-23T06:00:00Z', nowMs: Date.parse('2026-07-19T09:00:00Z') });
});
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  many = await import('../src/lib/checkImportMany.js');
  checkImport = await import('../src/lib/checkImport.js');
  vi.mocked(engine.parseCheckFileEntryLine).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const importLines = (file, options = {}) => many.importChecksFile(file, { servedIds: SERVED, nowMs: NOW, ...options });

/** Every record of the store, bytes included. */
async function dump() {
  await localSnapshots.list();
  const db = await new Promise((done) => { const request = indexedDB.open('passage-local-snapshots'); request.onsuccess = () => done(request.result); });
  const records = await new Promise((done) => { const request = db.transaction('files').objectStore('files').getAll(); request.onsuccess = () => done(request.result); });
  db.close();
  return records.map((record) => ({ ...record, content: typeof record.content === 'string' ? record.content : Array.from(record.content) }));
}
const recordsOf = (records, id) => JSON.stringify(records.filter((record) => record.snapshot_id === id));
const idsIn = (records) => [...new Set(records.map((record) => record.snapshot_id))].sort();
const zero = { imported: 0, already: 0, repeated: 0, damaged: 0, futureTime: 0, polar: 0, served: 0, conflict: 0, tooLarge: 0 };

/** Each stored file of a check read back, exactly as the file gave it, and its marker. */
async function expectStored(check) {
  for (const [name, text] of Object.entries(check.files)) expect(await localSnapshots.read(check.snapshotId, name)).toBe(text);
  expect(JSON.parse(await localSnapshots.read(check.snapshotId, 'imported.json'))).toEqual({ imported_at: '2026-11-16T09:00:00.000Z', exported_at: exportedAt, exported_by: exportedBy });
}

/** The check with one file's parsed value changed; its line keeps a right digest, so the proof is what judges it. */
const edited = (check, name, change) => ({ ...check, files: { ...check.files, [name]: JSON.stringify(change(JSON.parse(check.files[name]))) } });
const textEdited = (check, name, change) => ({ ...check, files: { ...check.files, [name]: change(check.files[name]) } });
/** A line written by hand (for files checkFileEntryLine refuses to write), with the digest its files give. */
const handLine = (snapshotId, files) => JSON.stringify({ snapshot_id: snapshotId, files, files_digest: checkFilesDigest(files) ?? '0123456789abcdef' });

describe('a version-2 file', () => {
  it('stores each check exactly as given, marked, and says it is complete', async () => {
    const progress = [];
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)])), { onProgress: (step) => progress.push(step) });
    expect(result).toEqual({ kind: 'v2', outcomes: { ...zero, imported: 2 }, importedIds: [a.snapshotId, b.snapshotId], joinedOwn: 0, linesRead: 2, first: { outcome: 'imported', snapshotId: a.snapshotId }, end: 'complete', hint: null, notReached: 0, refusal: null, storageFull: false });
    expect(progress).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    await expectStored(a);
    await expectStored(b);
    expect((await localSnapshots.list()).every((entry) => entry.imported)).toBe(true);
  });

  it('counts a repeated id once settled, without settling it again', async () => {
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(a), lineOf(b)])));
    expect(result.outcomes).toEqual({ ...zero, imported: 2, repeated: 1 });
    expect(engine.parseCheckFileEntryLine).toHaveBeenCalledTimes(2);
  });

  it('finds a check already here from its stored decision inputs text, proving and writing nothing for it', async () => {
    await localSnapshots.writeAll(a.snapshotId, savedFiles(a));
    const before = await dump();
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)])));
    expect(result.outcomes).toEqual({ ...zero, already: 1, imported: 1 });
    expect(engine.parseCheckFileEntryLine).toHaveBeenCalledTimes(1);
    expect(recordsOf(await dump(), a.snapshotId)).toBe(recordsOf(before, a.snapshotId));
    expect(await localSnapshots.read(a.snapshotId, 'imported.json')).toBeNull();
  });

  it('conflicts with another check stored under the same id, which stays untouched, and goes on', async () => {
    await localSnapshots.writeAll(a.snapshotId, savedFiles(a).map((file) => (file.filename === 'decision-inputs.json' ? { ...file, content: b.files['decision-inputs.json'] } : file)));
    const before = await dump();
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)])));
    expect(result.outcomes).toEqual({ ...zero, conflict: 1, imported: 1 });
    expect(recordsOf(await dump(), a.snapshotId)).toBe(recordsOf(before, a.snapshotId));
  });

  it('makes no request at all', async () => {
    globalThis.fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    expect((await importLines(fileFrom(backupOf([lineOf(a)])))).end).toBe('complete');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses before reading any check line when this page never read the served ids', async () => {
    const result = await importLines(fileFrom(backupOf([lineOf(a)])), { servedIds: null });
    expect(result).toMatchObject({ kind: 'v2', end: 'refused', refusal: 'offline', importedIds: [] });
    expect(engine.parseCheckFileEntryLine).not.toHaveBeenCalled();
    expect(await dump()).toEqual([]);
  });

  it('refuses a header of a newer format version before reading anything', async () => {
    const newer = `${JSON.stringify({ format: 'passage-checks', format_version: 4, exported_at: exportedAt, exported_by: exportedBy })}\n`;
    expect(await importLines(fileFrom(`${newer}${lineOf(a)}\n`))).toMatchObject({ kind: 'v2', end: 'refused', refusal: 'newer-version' });
    expect(await dump()).toEqual([]);
  });
});

describe('one refused line among valid ones: the store holds exactly the valid ones', () => {
  const key = ['speeds', 'kt'].join('_');
  const servedLine = () => {
    const dir = resolve(import.meta.dirname, 'fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3');
    const files = Object.fromEntries(readdirSync(dir).filter((name) => CHECK_FILE_NAMES.includes(name) && name !== 'synoptic.json').map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
    const manifest = JSON.parse(files['snapshot.json']);
    delete manifest.artifacts.synoptic;
    files['snapshot.json'] = JSON.stringify(manifest, null, 2);
    return lineOf({ snapshotId: manifest.snapshot_id, files });
  };
  const cases = [
    ['a repeated key in a file', 'damaged', () => lineOf(textEdited(c, 'findings.json', (text) => text.replace('{', '{"snapshot_id": "x",')))],
    ['an import marker in the line', 'damaged', () => handLine(c.snapshotId, { ...c.files, 'imported.json': '{}' })],
    ['a file a check file cannot hold', 'damaged', () => handLine(c.snapshotId, { ...c.files, 'changes.json': '{}' })],
    ['a bad digest', 'damaged', () => lineOf(c).replace(/"files_digest":"[0-9a-f]{16}"/, '"files_digest":"0123456789abcdef"')],
    ['a line that is not a check line', 'damaged', () => '{"snapshot_id":"not a check"}'],
    ['a version-1 document as a line', 'damaged', () => checkFileText(buildCheckFile({ ...c, exportedAt, exportedBy }))],
    ['decision inputs that no longer hash to the id', 'damaged', () => lineOf(edited(c, 'decision-inputs.json', (value) => ({ ...value, departureUtc: '2026-07-22T07:00:00Z' })))],
    ['a manifest with another verdict', 'damaged', () => lineOf(edited(c, 'snapshot.json', (value) => ({ ...value, verdict_state: value.verdict_state === 'within' ? 'exceeds' : 'within' })))],
    ['findings with 200,000 legs', 'damaged', () => lineOf(edited(c, 'findings.json', (value) => ({ ...value, legs: Array.from({ length: 200_000 }, (_, i) => ({ leg_id: `L${i + 1}` })) })))],
    ['findings of the wrong types', 'damaged', () => lineOf(edited(c, 'findings.json', (value) => ({ ...value, legs: value.legs.map((leg) => ({ ...leg, hours: 'many' })) })))],
    ['a route name changed to markup', 'damaged', () => lineOf(edited(c, 'route.json', (value) => ({ ...value, name: '<img src=x onerror="alert(1)">' })))],
    ['check sequence 0', 'damaged', () => lineOf(edited(c, 'snapshot.json', (value) => ({ ...value, check_sequence: 0 })))],
    ['check sequence 1,000,000', 'damaged', () => lineOf(edited(c, 'snapshot.json', (value) => ({ ...value, check_sequence: 1_000_000 })))],
    ['a served check\'s demo flag', 'damaged', () => lineOf(edited(c, 'snapshot.json', (value) => ({ ...value, demo: true })))],
    ['nesting 70 levels deep', 'damaged', () => lineOf(edited(c, 'findings.json', (value) => ({ ...value, debug: JSON.parse(`${'['.repeat(70)}1${']'.repeat(70)}`) })))],
    ['a string over 64 KiB in findings', 'damaged', () => lineOf(edited(c, 'findings.json', (value) => ({ ...value, debug: 'x'.repeat(70_000) })))],
    ['the key __proto__ in every file', 'damaged', () => lineOf({ ...c, files: Object.fromEntries(Object.entries(c.files).map(([name, text]) => [name, text.replace('{', '{"__proto__": {"polluted": true},')])) })],
    ['a check saved in 2099', 'futureTime', () => lineOf(edited(c, 'snapshot.json', (value) => ({ ...value, created_at: '2099-01-01T00:00:00.000Z' })))],
    ['polar data in an open findings field', 'polar', () => lineOf(edited(c, 'findings.json', (value) => ({ ...value, debug: { [key]: [[4.1, 5.2], [6.3, 7.4]] } })))],
    ['polar data behind a unicode-escaped key', 'polar', () => lineOf(textEdited(c, 'findings.json', (text) => text.replace('{', `{"debug": {"${key.replace('_', '\\u005f')}": [[4.1, 5.2], [6.3, 7.4]]},`)))],
    ['polar data inside a JSON string', 'polar', () => lineOf(textEdited(c, 'findings.json', (text) => text.replace('{', `{"debug": ${JSON.stringify(JSON.stringify({ [key]: [[4.1, 5.2], [6.3, 7.4]] }))},`)))],
    ['a check Passage serves', 'served', servedLine],
  ];

  it.each(cases)('%s → %s', async (_case, outcome, make) => {
    await localSnapshots.writeAll(pre.snapshotId, savedFiles(pre));
    const before = await dump();
    const result = await importLines(fileFrom(backupOf([lineOf(a), make(), lineOf(b)])));
    expect(result).toMatchObject({ kind: 'v2', end: 'complete', importedIds: [a.snapshotId, b.snapshotId] });
    expect(result.outcomes).toEqual({ ...zero, imported: 2, [outcome]: 1 });
    const after = await dump();
    expect(idsIn(after)).toEqual([a.snapshotId, b.snapshotId, pre.snapshotId].sort());
    expect(recordsOf(after, pre.snapshotId)).toBe(recordsOf(before, pre.snapshotId));
    await expectStored(a);
    await expectStored(b);
    expect(({}).polluted).toBeUndefined();
    for (const [line] of vi.mocked(console.error).mock.calls) expect(String(line)).not.toMatch(/Newport|New York|<img|alert/);
  });
});

/** A Blob whose stream gives the compressed bytes cut at the given offsets. */
function cutFile(bytes, cuts) {
  const blob = new NodeBlob([bytes]);
  return {
    size: bytes.byteLength,
    slice: (start, end) => blob.slice(start, end),
    stream() {
      const edges = [0, ...cuts, bytes.byteLength];
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= edges.length - 1) { controller.close(); return; }
          controller.enqueue(bytes.slice(edges[i], edges[i + 1]));
          i += 1;
        },
      });
    },
  };
}

describe('a file that breaks part-way keeps what was stored', () => {
  it('stops at a storage failure: every stored check whole, and how many lines were not settled', async () => {
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
      if (record.filename === 'imported.json' && record.snapshot_id === b.snapshotId) {
        const raw = this._rawObjectStore;
        const storeRecord = raw.storeRecord;
        raw.storeRecord = () => { raw.storeRecord = storeRecord; throw new DOMException('Quota exceeded.', 'QuotaExceededError'); };
      }
      return add.call(this, record);
    });
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b), lineOf(c)])));
    vi.mocked(IDBObjectStore.prototype.add).mockRestore();
    expect(result).toMatchObject({ end: 'storage', storageFull: true, importedIds: [a.snapshotId], notReached: 2, outcomes: { ...zero, imported: 1 } });
    expect(idsIn(await dump())).toEqual([a.snapshotId]);
    await expectStored(a);
  });

  it('says how many were not settled is unknown when the trailer cannot be reached', async () => {
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
      if (record.filename === 'imported.json' && record.snapshot_id === b.snapshotId) {
        const raw = this._rawObjectStore;
        const storeRecord = raw.storeRecord;
        raw.storeRecord = () => { raw.storeRecord = storeRecord; throw new DOMException('Quota exceeded.', 'QuotaExceededError'); };
      }
      return add.call(this, record);
    });
    const text = backupOf([lineOf(a), lineOf(b), lineOf(c)]);
    const result = await importLines(fileFrom(text.slice(0, text.lastIndexOf(lineOf(c)) + 100)));
    vi.mocked(IDBObjectStore.prototype.add).mockRestore();
    expect(result).toMatchObject({ end: 'storage', importedIds: [a.snapshotId], notReached: null });
  });

  it('keeps the checks before a cut and flags the import incomplete', async () => {
    const text = backupOf([lineOf(a), lineOf(b), lineOf(c)]);
    const result = await importLines(fileFrom(text.slice(0, text.lastIndexOf(lineOf(c)) + 100)));
    expect(result).toMatchObject({ end: 'incomplete', hint: 'truncated', importedIds: [a.snapshotId, b.snapshotId], outcomes: { ...zero, imported: 2 } });
    expect(idsIn(await dump())).toEqual([a.snapshotId, b.snapshotId].sort());
  });

  it('keeps the checks of a file whose gzip fails its check, and flags it incomplete', async () => {
    const bytes = new Uint8Array(gzipSync(backupOf([lineOf(a), lineOf(b)])));
    bytes[bytes.byteLength - 8] ^= 0xff;
    const result = await importLines(cutFile(bytes, [bytes.byteLength - 8]));
    expect(result).toMatchObject({ end: 'incomplete', hint: 'corrupt', importedIds: [a.snapshotId, b.snapshotId] });
  });

  it('flags a trailer counting other than the lines read as incomplete', async () => {
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)], checkFileTrailerLine(3))));
    expect(result).toMatchObject({ end: 'incomplete', hint: 'trailer', importedIds: [a.snapshotId, b.snapshotId] });
  });

  it('counts a check line over the line cap as too large, the read ending there', async () => {
    const small = new TextEncoder().encode(lineOf(a)).byteLength;
    const large = await makeCheck({ passageId: 'passage-large', nowMs: Date.parse('2026-07-19T13:00:00Z'), routeExtras: { note: 'x'.repeat(60_000) } });
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(large), lineOf(b)])), { caps: { lineBytes: small + 1000 } });
    expect(result).toMatchObject({ end: 'incomplete', hint: 'too-large', importedIds: [a.snapshotId], outcomes: { ...zero, imported: 1, tooLarge: 1 } });
  });

  it('stops between two checks on an abort, keeping what was stored', async () => {
    const controller = new AbortController();
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b), lineOf(c)])), { signal: controller.signal, onProgress: ({ index }) => { if (index === 1) controller.abort(); } });
    expect(result).toMatchObject({ end: 'stopped', importedIds: [a.snapshotId] });
    expect(idsIn(await dump())).toEqual([a.snapshotId]);
    await expectStored(a);
  });
});

describe('a version-1 file', () => {
  it('goes to the stage 1 import, with its own outcome', async () => {
    const file = fileOf((await checkFileOf(a)).bytes);
    const v1 = new NodeFile([new Uint8Array(await file.arrayBuffer())], 'passage-check.json.gz');
    expect(await importLines(v1)).toEqual({ kind: 'v1', outcome: 'imported', snapshotId: a.snapshotId, departureUtc: '2026-07-20T06:00:00Z' });
    expect(await importLines(v1)).toEqual({ kind: 'v1', outcome: 'already-here', snapshotId: a.snapshotId, departureUtc: '2026-07-20T06:00:00Z' });
    const newer = new NodeFile([gzipSync(JSON.stringify({ ...JSON.parse((await checkFileOf(b)).text), format_version: 2 }))], 'x.json.gz');
    expect(await importLines(newer)).toEqual({ kind: 'v1', outcome: 'newer-version' });
  });

  it('is not a check file when it is not gzip, whatever its size (stage 1 says too large past 16 MB)', async () => {
    const big = new NodeFile([new Uint8Array(16 * 1024 * 1024 + 1).fill(0x7b)], 'big.json.gz');
    expect(await importLines(big)).toEqual({ kind: 'v1', outcome: 'not-check-file' });
    expect((await checkImport.importCheckFile(big, { servedIds: SERVED })).outcome).toBe('too-large');
    expect(await importLines(new NodeFile([new TextEncoder().encode('{}')], 'small.json'))).toEqual({ kind: 'v1', outcome: 'not-check-file' });
  });
});

it('export-all → import-many into a clean store → export-all gives the same lines', async () => {
  const { makeAllChecksFile } = await import('../src/lib/allChecksFile.js');
  const lines = await import('../src/lib/checkFileLines.js');
  const deps = () => ({
    store: localSnapshots,
    loadValidators: () => import('../src/lib/generated/checkFileValidators.js'),
    compressor: () => new CompressionStream('gzip'),
    Blob: NodeBlob,
    pause: () => Promise.resolve(),
  });
  const linesOf = async (blob) => {
    const out = [];
    for await (const item of lines.readCheckFileLines(blob)) if (typeof item === 'string') out.push(item);
    return out;
  };
  // a and b saved here (b's name outside Latin-1), c imported from a single-check file
  await localSnapshots.writeAll(a.snapshotId, savedFiles(a));
  await localSnapshots.writeAll(b.snapshotId, savedFiles(b));
  expect((await checkImport.importCheckFile(fileOf((await checkFileOf(c)).bytes), { servedIds: SERVED, nowMs: NOW })).outcome).toBe('imported');
  const first = await makeAllChecksFile(deps(), { nowMs: NOW });
  expect(first.included).toHaveLength(3);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  many = await import('../src/lib/checkImportMany.js');
  const { makeAllChecksFile: again } = await import('../src/lib/allChecksFile.js');
  const imported = await importLines(first.blob);
  expect(imported).toMatchObject({ end: 'complete', outcomes: { ...zero, imported: 3 } });
  const second = await again(deps(), { nowMs: NOW });
  expect(second.included).toEqual(first.included);
  expect(await linesOf(second.blob)).toEqual(await linesOf(first.blob));
});

describe('removeImportedChecks', () => {
  it('removes only checks that carry an import marker, files and marker', async () => {
    await localSnapshots.writeAll(pre.snapshotId, savedFiles(pre));
    const before = await dump();
    await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)])));
    const result = await many.removeImportedChecks([a.snapshotId, pre.snapshotId, 'snapshot_v2_0123456789abcdef', 42]);
    expect(result).toEqual({ removed: [a.snapshotId], refused: [pre.snapshotId, 'snapshot_v2_0123456789abcdef', 42] });
    const after = await dump();
    expect(idsIn(after)).toEqual([b.snapshotId, pre.snapshotId].sort());
    expect(recordsOf(after, pre.snapshotId)).toBe(recordsOf(before, pre.snapshotId));
  });
});

describe('review round: settling, passages, unknown counts, concurrency', () => {
  it('proves a later copy of an id whose earlier copy was refused, instead of counting it repeated', async () => {
    const damagedFirst = lineOf(edited(a, 'snapshot.json', (value) => ({ ...value, check_sequence: 0 })));
    const first = await importLines(fileFrom(backupOf([damagedFirst, lineOf(a)])));
    expect(first.outcomes).toEqual({ ...zero, damaged: 1, imported: 1 });
    expect(first.importedIds).toEqual([a.snapshotId]);
    await expectStored(a);
    // a line whose prefix names b's id but that repeats the key: refused, then b itself is proven
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    many = await import('../src/lib/checkImportMany.js');
    const twice = lineOf(b).replace(`{"snapshot_id":"${b.snapshotId}",`, `{"snapshot_id":"${b.snapshotId}","snapshot_id":"${b.snapshotId}",`);
    expect(twice.startsWith(`{"snapshot_id":"${b.snapshotId}"`)).toBe(true);
    const second = await importLines(fileFrom(backupOf([twice, lineOf(b)])));
    expect(second.outcomes).toEqual({ ...zero, damaged: 1, imported: 1 });
    await expectStored(b);
  });

  it('still counts a copy after an imported, already-here, conflicting or served one as repeated', async () => {
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(a)])));
    expect(result.outcomes).toEqual({ ...zero, imported: 1, repeated: 1 });
  });

  it('counts the stored checks that joined a passage holding a check made in this browser before the import', async () => {
    // pre is made here; c is imported (its passage holds no check made here)
    await localSnapshots.writeAll(pre.snapshotId, savedFiles(pre));
    expect((await checkImport.importCheckFile(fileOf((await checkFileOf(c)).bytes), { servedIds: SERVED, nowMs: NOW })).outcome).toBe('imported');
    const samePre = await makeCheck({ passageId: 'passage-pre', departureUtc: '2026-07-24T06:00:00Z', nowMs: Date.parse('2026-07-19T20:00:00Z') });
    const sameC = await makeCheck({ passageId: 'passage-c', departureUtc: '2026-07-24T06:00:00Z', nowMs: Date.parse('2026-07-19T20:00:00Z') });
    const listed = vi.spyOn(localSnapshots, 'list');
    const result = await importLines(fileFrom(backupOf([lineOf(samePre), lineOf(sameC), lineOf(a)])));
    expect(result).toMatchObject({ end: 'complete', joinedOwn: 1, outcomes: { ...zero, imported: 3 } });
    // one list, before the first line
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it('tells 0 lines not settled (complete) from an unknown number (a cut file, a line over its cap)', async () => {
    expect((await importLines(fileFrom(backupOf([lineOf(a)])))).notReached).toBe(0);
    const text = backupOf([lineOf(a), lineOf(b)]);
    expect(await importLines(fileFrom(text.slice(0, text.lastIndexOf(lineOf(b)) + 50)))).toMatchObject({ end: 'incomplete', notReached: null, linesRead: 1 });
    const small = new TextEncoder().encode(lineOf(a)).byteLength;
    const large = await makeCheck({ passageId: 'passage-large-2', nowMs: Date.parse('2026-07-19T13:00:00Z'), routeExtras: { note: 'x'.repeat(60_000) } });
    expect(await importLines(fileFrom(backupOf([lineOf(a), lineOf(large)])), { caps: { lineBytes: small + 1000 } })).toMatchObject({ end: 'incomplete', hint: 'too-large', notReached: null, linesRead: 1 });
  });

  it('runs two imports of the same file side by side: each check stored once, the ids disjoint, their union the store', async () => {
    const text = backupOf([lineOf(a), lineOf(b), lineOf(c)]);
    const [one, two] = await Promise.all([importLines(fileFrom(text)), importLines(fileFrom(text))]);
    expect(one.importedIds.filter((id) => two.importedIds.includes(id))).toEqual([]);
    expect([...one.importedIds, ...two.importedIds].sort()).toEqual([a.snapshotId, b.snapshotId, c.snapshotId].sort());
    expect(idsIn(await dump())).toEqual([a.snapshotId, b.snapshotId, c.snapshotId].sort());
    expect(one.outcomes.imported + two.outcomes.imported).toBe(3);
    expect(one.outcomes.already + two.outcomes.already).toBe(3);
    for (const check of [a, b, c]) await expectStored(check);
  });

  it('finishes a write an abort lands in, so what is stored is exactly importedIds', async () => {
    const controller = new AbortController();
    const writeAll = localSnapshots.writeAll.bind(localSnapshots);
    let writes = 0;
    vi.spyOn(localSnapshots, 'writeAll').mockImplementation(async (id, records) => {
      writes += 1;
      if (writes === 2) controller.abort();
      return writeAll(id, records);
    });
    const result = await importLines(fileFrom(backupOf([lineOf(a), lineOf(b), lineOf(c)])), { signal: controller.signal });
    expect(result.end).toBe('stopped');
    expect(result.importedIds).toEqual([a.snapshotId, b.snapshotId]);
    expect(idsIn(await dump())).toEqual([...result.importedIds].sort());
  });
});

it('removes imported checks through the delete it is given, and counts as removed only what the store no longer holds', async () => {
  await importLines(fileFrom(backupOf([lineOf(a), lineOf(b)])));
  const seen = [];
  const result = await many.removeImportedChecks([a.snapshotId, b.snapshotId], {
    // a delete that removes a, and one that fails for b
    remove: async (id) => { seen.push(id); if (id === a.snapshotId) await localSnapshots.remove(id); else throw new Error('blocked'); },
  });
  expect(seen).toEqual([a.snapshotId, b.snapshotId]);
  expect(result).toEqual({ removed: [a.snapshotId], refused: [b.snapshotId] });
  expect(idsIn(await dump())).toEqual([b.snapshotId]);
});

it('reads the checks of a version-3 file after its names line, the names not yet applied', async () => {
  const { checkFileNamesLine: namesLine } = await import('@deepweather/engine');
  const header3 = checkFileHeaderLine({ exportedAt, exportedBy, version: 3 });
  const text = header3 + namesLine([{ passage_id: 'passage-a', name: 'A name' }]) + `${lineOf(a)}\n${lineOf(b)}\n` + checkFileTrailerLine(2);
  const result = await importLines(fileFrom(text));
  expect(result).toMatchObject({ kind: 'v2', end: 'complete', importedIds: [a.snapshotId, b.snapshotId], outcomes: { ...zero, imported: 2 } });
  expect(localStorage.getItem('deepweather.passage-labels')).toBeNull();
});
