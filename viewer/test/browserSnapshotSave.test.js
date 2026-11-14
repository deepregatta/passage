// A Check saved in this browser is all-or-nothing through the real path:
// analyzeInBrowser → persistSnapshot → FallbackSnapshotStore → IndexedDB
// (fake-indexeddb, a fresh database per test). A failed save leaves no record
// and tells the planner which kind of failure it was.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
