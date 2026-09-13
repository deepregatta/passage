import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';

let localSnapshots;
let fetchSnapshotJson;

beforeEach(async () => {
  vi.resetModules();
  ({ localSnapshots, fetchSnapshotJson } = await import('../src/lib/localSnapshots.js'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

it('upgrades legacy briefings and lists only snapshot documents, preserving list/write/delete behavior', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const opening = indexedDB.open('passage-local-snapshots', 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore('files', { keyPath: 'key' });
    store.createIndex('snapshot_id', 'snapshot_id');
  };
  const legacy = await requestResult(opening);
  const transaction = legacy.transaction('files', 'readwrite');
  const store = transaction.objectStore('files');
  const doc = { created_at: '2026-09-13T12:00:00Z', route_id: 'route', profile_id: 'profile', departure_utc: '2026-09-14T12:00:00Z' };
  for (const [id, filename, content] of [
    ['old', 'snapshot.json', JSON.stringify(doc)],
    ['old', 'plume.json', 'x'.repeat(2_000_000)],
    ['broken', 'snapshot.json', '{bad json'],
    ['partial', 'plume.json', '{}'],
  ]) store.put({ key: `${id}/${filename}`, snapshot_id: id, filename, content });
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = reject; });
  legacy.close();

  const bulk = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  const indexed = vi.spyOn(IDBIndex.prototype, 'getAll');
  const entry = { ...doc, snapshot_id: 'old', verdict_state: null, demo: false, local: true };
  expect(await localSnapshots.list()).toEqual([entry]);
  expect(bulk).not.toHaveBeenCalled();
  expect(indexed).toHaveBeenCalledWith('snapshot.json');
  expect(indexed.mock.contexts.map(index => index.keyPath)).toEqual(['filename']);
  expect(await localSnapshots.read('old', 'plume.json')).toHaveLength(2_000_000);

  await localSnapshots.write('z-new', 'snapshot.json', JSON.stringify({ ...doc, snapshot_id: 'z-new', verdict_state: 'within' }));
  expect(await localSnapshots.list()).toEqual([{ ...entry, snapshot_id: 'z-new', verdict_state: 'within' }, entry]);
  await localSnapshots.write('z-new', 'snapshot.json', '{malformed replacement');
  expect(await localSnapshots.list()).toEqual([entry]);
  expect(await localSnapshots.remove('old')).toBe(true);
  expect(await localSnapshots.read('old', 'plume.json')).toBeNull();
  expect(await localSnapshots.list()).toEqual([]);
  expect(await localSnapshots.remove('old')).toBe(false);
});

it('creates an empty database and fails soft when listing storage is unavailable', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  expect(await localSnapshots.list()).toEqual([]);
  vi.stubGlobal('indexedDB', undefined);
  expect(await localSnapshots.list()).toEqual([]);
});

// Only the request/transaction events used by these failure paths are emulated.
function installDb({ openFailure, readFailure, record } = {}) {
  const error = new Error('IndexedDB unavailable');
  const db = {
    transaction: vi.fn(() => {
      if (readFailure === 'throw') throw error;
      const transaction = { objectStore: () => ({ get: () => ({ result: record }) }) };
      queueMicrotask(() => {
        if (readFailure) {
          transaction.error = error;
          transaction[readFailure === 'abort' ? 'onabort' : 'onerror']();
        } else transaction.oncomplete();
      });
      return transaction;
    }),
  };
  const open = vi.fn(() => {
    if (openFailure === 'throw') throw error;
    const request = { result: db, error };
    queueMicrotask(() => openFailure ? request.onerror() : request.onsuccess());
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return { open, db, error, recover: () => { openFailure = null; } };
}

it.each(['throw', 'error'])('fails soft on an IndexedDB open %s and retries concurrent readers', async (openFailure) => {
  const { open, recover } = installDb({ openFailure, record: { content: '{}' } });
  await expect(Promise.all([localSnapshots.exists('saved'), localSnapshots.exists('saved')]))
    .resolves.toEqual([false, false]);
  expect(open).toHaveBeenCalledTimes(1);
  recover();
  await expect(Promise.all([localSnapshots.exists('saved'), localSnapshots.exists('saved')]))
    .resolves.toEqual([true, true]);
  await expect(localSnapshots.read('saved', 'snapshot.json')).resolves.toBe('{}');
  expect(open).toHaveBeenCalledTimes(2);
});

it.each(['throw', 'error', 'abort'])('exists returns false on a transaction %s', async (readFailure) => {
  installDb({ readFailure });
  await expect(localSnapshots.exists('saved')).resolves.toBe(false);
});

it('returns false when IndexedDB or the snapshot is absent', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(localSnapshots.exists('missing')).resolves.toBe(false);
  installDb();
  await expect(localSnapshots.exists('missing')).resolves.toBe(false);
});

it('loads a served snapshot when IndexedDB keeps failing', async () => {
  installDb({ openFailure: 'error' });
  const snapshot = { snapshot_id: 'demo' };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchSnapshotJson('demo', 'snapshot.json')).resolves.toEqual(snapshot);
  expect(fetch).toHaveBeenCalledWith('/data/snapshots/demo/snapshot.json');
});

it('still rejects writes when opening storage fails', async () => {
  const { error } = installDb({ openFailure: 'error' });
  await expect(localSnapshots.write('saved', 'snapshot.json', '{}')).rejects.toBe(error);
});
