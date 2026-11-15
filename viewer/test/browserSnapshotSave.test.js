// A Check saved in this browser is all-or-nothing through the real path:
// analyzeInBrowser → persistSnapshot → FallbackSnapshotStore → IndexedDB
// (fake-indexeddb, a fresh database per test). A failed save leaves no record
// and tells the planner which kind of failure it was.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { runAnalysis } from '@deepweather/engine';

vi.mock('@deepweather/engine', async original => ({ ...await original(), runAnalysis: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => Object.fromEntries(['init', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid', 'getWindGrid'].map(key => [key, async () => null]).concat([['describe', () => ({})]])) }));
vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: async () => ({ doc: null }) }));

const read = (path) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf8'));
const route = read('../../config/routes/newport-newyork.json');
const profile = read('../../config/profiles/default-limits.json');
let analyzeInBrowser;
let localSnapshots;

beforeEach(async () => {
  // the evaluation clock is fixed so that the same Check gives the same snapshot id
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-19T18:00:00Z'));
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ analyzeInBrowser } = await import('../src/lib/browserAnalysis.js'));
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  const { runAnalysis: realAnalysis, ScenarioBundleStore } = await vi.importActual('@deepweather/engine');
  const store = new ScenarioBundleStore({
    loadBundle: async (name) => read(`../../engine/test/fixtures/scenarios/calm/${name}.json`),
  });
  runAnalysis.mockImplementation((options) => realAnalysis({ ...options, warnings: undefined, store }));
  // Static hosting: no write endpoint, an empty served catalogue, no served snapshot.
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') return { ok: false, status: 405 };
    if (url === '/data/snapshots/manifest.json') return { ok: true, status: 200, json: async () => ({ snapshots: [] }) };
    return { ok: false, status: 404, json: async () => undefined };
  }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const check = () => analyzeInBrowser({ route, profile, departureUtc: '2026-07-20T06:00:00Z' });
async function recordKeys() {
  const opening = indexedDB.open('passage-local-snapshots');
  const db = await new Promise((done, fail) => { opening.onsuccess = () => done(opening.result); opening.onerror = () => fail(opening.error); });
  const request = db.transaction('files').objectStore('files').getAllKeys();
  const keys = await new Promise(done => { request.onsuccess = () => done(request.result); });
  db.close();
  return keys;
}
/** The records of the files store exactly as IndexedDB holds them, by key. */
async function storedRecords() {
  const opening = indexedDB.open('passage-local-snapshots');
  const db = await new Promise((done, fail) => { opening.onsuccess = () => done(opening.result); opening.onerror = () => fail(opening.error); });
  const request = db.transaction('files').objectStore('files').getAll();
  const records = await new Promise(done => { request.onsuccess = () => done(request.result); });
  db.close();
  return Object.fromEntries(records.map(record => [record.filename, record]));
}
const storedLength = (content) => typeof content === 'string' ? content.length : content.byteLength;

it('a saved Check stores its decision inputs compressed, under a quarter of their JSON text', async () => {
  const { snapshotId } = await check();
  const text = await localSnapshots.read(snapshotId, 'decision-inputs.json');
  const stored = (await storedRecords())['decision-inputs.json'];
  expect(storedLength(stored.content) / text.length).toBeLessThan(0.25);
});

/** The add of route.json fails the way it does when this site's storage is full. */
function storageFullOnRoute() {
  const add = IDBObjectStore.prototype.add;
  return vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
    if (record.filename === 'route.json') {
      const raw = this._rawObjectStore;
      const storeRecord = raw.storeRecord;
      raw.storeRecord = () => { raw.storeRecord = storeRecord; throw new DOMException('Quota exceeded for this origin.', 'QuotaExceededError'); };
    }
    return add.call(this, record);
  });
}

it('a save that runs out of storage part-way stores nothing; the same Check then saves', async () => {
  const full = storageFullOnRoute();
  const failure = await check().catch(error => error);
  expect(failure).toMatchObject({ saveFailure: 'storage-full' });
  expect(failure.message).toContain('Quota exceeded for this origin.');
  full.mockRestore();
  expect(await recordKeys()).toEqual([]);
  expect(await localSnapshots.list()).toEqual([]);

  const { snapshotId } = await check();
  expect(snapshotId).toMatch(/^snapshot_v2_[0-9a-f]{16}$/);
  expect((await localSnapshots.list()).map(item => item.snapshot_id)).toEqual([snapshotId]);
  const files = (await recordKeys()).map(key => key.slice(snapshotId.length + 1));
  expect(files).toContain('decision-inputs.json');
  expect(files).toContain('snapshot.json');
  const decision = await localSnapshots.read(snapshotId, 'decision-inputs.json');
  expect(decision).not.toContain('\n');
  // an exact retry reopens the saved Check
  await expect(check()).resolves.toMatchObject({ snapshotId });
});

it('a Check blocked by a partial save from before stays refused, keeps its bytes and is a blocked save', async () => {
  const { snapshotId } = await check();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  ({ analyzeInBrowser } = await import('../src/lib/browserAnalysis.js'));
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  await localSnapshots.write(snapshotId, 'route.json', '{"original":true}');
  const failure = await check().catch(error => error);
  expect(failure).toMatchObject({ saveFailure: 'blocked' });
  expect(failure.message).toMatch(/incomplete, legacy or conflicting/);
  expect(await recordKeys()).toEqual([`${snapshotId}/route.json`]);
  expect(await localSnapshots.read(snapshotId, 'route.json')).toBe('{"original":true}');
});

it('the dev middleware refusing an existing file (409) is the same blocked save', async () => {
  fetch.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return { ok: false, status: 409 };
    if (url === '/data/snapshots/manifest.json') return { ok: true, status: 200, json: async () => ({ snapshots: [] }) };
    return { ok: false, status: 404, json: async () => undefined };
  });
  const failure = await check().catch(error => error);
  expect(failure).toMatchObject({ saveFailure: 'blocked' });
  expect(failure.message).toMatch(/already exists \(write-once\)$/);
  expect(await recordKeys()).toEqual([]);
});

it.each([
  ['no IndexedDB', () => vi.stubGlobal('indexedDB', undefined)],
])('any other refusal (%s) is a plain save failure', async (_name, arrange) => {
  arrange();
  const failure = await check().catch(error => error);
  expect(failure).toMatchObject({ saveFailure: 'failed' });
  expect(failure.message).toMatch(/no IndexedDB/);
});

// Compressed storage (2026-11-15): the exact retry reads saved checks of both forms.
const putRaw = async (record) => {
  const opening = indexedDB.open('passage-local-snapshots');
  const db = await new Promise((done, fail) => { opening.onsuccess = () => done(opening.result); opening.onerror = () => fail(opening.error); });
  const transaction = db.transaction('files', 'readwrite');
  transaction.objectStore('files').put(record);
  await new Promise((done, fail) => { transaction.oncomplete = done; transaction.onabort = () => fail(transaction.error); });
  db.close();
};

it('an exact retry reopens a compressed Check without writing', async () => {
  const { snapshotId } = await check();
  const stored = await storedRecords();
  expect(stored['decision-inputs.json'].encoding).toBe('gzip');
  expect(stored['snapshot.json'].encoding).toBeUndefined();
  const add = vi.spyOn(IDBObjectStore.prototype, 'add');
  await expect(check()).resolves.toMatchObject({ snapshotId });
  expect(add).not.toHaveBeenCalled();
});

const nativeCompressionStream = globalThis.CompressionStream;
it('an exact retry reopens a plain Check saved the way earlier builds saved it, without writing', async () => {
  vi.stubGlobal('CompressionStream', undefined);
  const { snapshotId } = await check();
  expect(Object.values(await storedRecords()).every(record => !('encoding' in record) && typeof record.content === 'string')).toBe(true);
  vi.stubGlobal('CompressionStream', nativeCompressionStream); // this build again
  const add = vi.spyOn(IDBObjectStore.prototype, 'add');
  await expect(check()).resolves.toMatchObject({ snapshotId });
  expect(add).not.toHaveBeenCalled();
});

it('a Check whose compressed decision inputs cannot be decoded is a blocked save that keeps its bytes', async () => {
  const { snapshotId } = await check();
  const damaged = (await storedRecords())['decision-inputs.json'];
  damaged.content = damaged.content.slice(0, 40);
  await putRaw(damaged);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const add = vi.spyOn(IDBObjectStore.prototype, 'add');
  const failure = await check().catch(error => error);
  expect(failure).toMatchObject({ saveFailure: 'blocked' });
  expect(add).not.toHaveBeenCalled();
  expect(await localSnapshots.exists(snapshotId)).toBe(true);
  expect(Array.from((await storedRecords())['decision-inputs.json'].content)).toEqual(Array.from(damaged.content));
});

it.each([
  ['an aborted transaction', (transaction) => queueMicrotask(() => transaction.abort())],
  ['an add that throws', () => { throw new DOMException('could not be cloned', 'DataCloneError'); }],
])('%s with compressed records stores nothing and is a plain save failure', async (_name, fail) => {
  const add = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
    if (record.filename !== 'route.json') return add.call(this, record);
    const request = fail(this.transaction);
    return request ?? add.call(this, record);
  });
  const failure = await check().catch(error => error);
  expect(spy.mock.calls.some(([record]) => record.encoding === 'gzip')).toBe(true);
  expect(failure).toMatchObject({ saveFailure: 'failed' });
  spy.mockRestore();
  expect(await recordKeys()).toEqual([]);
});

it('deleting a compressed Check removes every record', async () => {
  const { snapshotId } = await check();
  expect(await localSnapshots.remove(snapshotId)).toBe(true);
  expect(await recordKeys()).toEqual([]);
});

// Ask the browser to keep saved checks (2026-11-15): once, after a check saved in this browser, never awaited.
describe('asking the browser to keep the saved check', () => {
  let persist;
  const storing = (answer) => {
    persist = vi.fn(answer ?? (async () => false));
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { persist, persisted: async () => false } }));
  };
  beforeEach(() => localStorage.clear());

  it('asks exactly once after a successful browser save', async () => {
    storing();
    await check();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    // an exact retry reopens the same check; within 30 days the browser is not asked again
    await check();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not make the save wait for a request that never answers', async () => {
    storing(() => new Promise(() => {}));
    const saved = await check();
    expect(saved.snapshotId).toMatch(/^snapshot_v2_[0-9a-f]{16}$/);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(await localSnapshots.exists(saved.snapshotId)).toBe(true);
  });

  it('a rejecting request breaks nothing and surfaces no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      storing(async () => { throw new Error('refused'); });
      await expect(check()).resolves.toMatchObject({ snapshotId: expect.any(String) });
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it.each([
    ['storage-full', () => storageFullOnRoute()],
    ['blocked', () => fetch.mockImplementation(async (url, init) => (init?.method === 'POST' ? { ok: false, status: 409 }
      : url === '/data/snapshots/manifest.json' ? { ok: true, status: 200, json: async () => ({ snapshots: [] }) } : { ok: false, status: 404 }))],
    ['failed', () => vi.stubGlobal('indexedDB', undefined)],
  ])('does not ask after a failed save (%s)', async (kind, arrange) => {
    storing();
    arrange();
    const failure = await check().catch(error => error);
    expect(failure).toMatchObject({ saveFailure: kind });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not ask for a check the dev middleware wrote to disk', async () => {
    storing();
    const written = [];
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') { written.push(url); return { ok: true, status: 200 }; }
      if (url === '/data/snapshots/manifest.json') return { ok: true, status: 200, json: async () => ({ snapshots: [] }) };
      return { ok: false, status: 404, json: async () => undefined };
    });
    await check();
    expect(written.length).toBeGreaterThan(0);
    expect(await recordKeys()).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(persist).not.toHaveBeenCalled();
  });
});
