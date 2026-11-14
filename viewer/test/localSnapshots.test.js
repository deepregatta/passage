import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';

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
  await expect(localSnapshots.write('z-new', 'snapshot.json', '{malformed replacement')).rejects.toThrow();
  expect(await localSnapshots.list()).toHaveLength(2);
  await localSnapshots.remove('z-new');
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

it('recognizes partial saved artifacts and refuses replacement without modifying bytes', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await localSnapshots.write('partial', 'route.json', '{"original":true}');
  expect(await localSnapshots.exists('partial')).toBe(true);
  expect(await localSnapshots.list()).toEqual([]);
  await expect(localSnapshots.write('partial', 'route.json', '{"original":false}')).rejects.toThrow();
  expect(await localSnapshots.read('partial', 'route.json')).toBe('{"original":true}');
});

// Only the request/transaction events used by these failure paths are emulated.
function installDb({ openFailure, readFailure, record } = {}) {
  const error = new Error('IndexedDB unavailable');
  const db = {
    transaction: vi.fn(() => {
      if (readFailure === 'throw') throw error;
      const transaction = { objectStore: () => ({ get: () => ({ result: record }), index: () => ({ count: () => ({ result: record ? 1 : 0 }) }) }) };
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

it('round-trips every committed legacy artifact through storage without rewriting, and lists v2 identity fields', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  vi.stubGlobal('indexedDB', new IDBFactory());
  for (const root of ['fixtures/demo/snapshots', 'fixtures/compatibility']) {
    const dir = resolve(import.meta.dirname, root);
    for (const id of readdirSync(dir)) {
      for (const file of readdirSync(join(dir, id))) {
        if (!statSync(join(dir, id, file)).isFile()) continue;
        const original = readFileSync(join(dir, id, file), 'utf8');
        await localSnapshots.write(id, file, original);
        expect(await localSnapshots.read(id, file)).toBe(original);
      }
    }
  }
  const old = await localSnapshots.list();
  expect(old).toHaveLength(3);
  const modern = { snapshot_id: 'v2', created_at: '2026-10-03T00:00:00.001Z', route_id: 'same',
    profile_id: 'default', departure_utc: '2026-10-04T00:00Z', identity_version: 2,
    passage_id: 'intent', route_revision: '0123456789abcdef', decision_hash: 'fedcba9876543210' };
  await localSnapshots.write('v2', 'snapshot.json', JSON.stringify(modern));
  expect((await localSnapshots.list()).find(s => s.snapshot_id === 'v2')).toMatchObject(modern);
  await localSnapshots.remove('v2');
  expect(await localSnapshots.list()).toEqual(old);
});

// All-or-nothing saves: one readwrite transaction per check.
const CHECK = ['decision-inputs.json', 'findings.json', 'briefing.json', 'route.json', 'snapshot.json']
  .map(filename => ({ filename, content: filename === 'snapshot.json' ? JSON.stringify({ snapshot_id: 'check', created_at: '2026-11-14T00:00:00Z' }) : `{"file":"${filename}"}` }));
const recordsOf = async (id) => {
  const opening = indexedDB.open('passage-local-snapshots');
  const db = await requestResult(opening);
  const keys = await requestResult(db.transaction('files').objectStore('files').index('snapshot_id').getAllKeys(id));
  db.close();
  return keys;
};
const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
/** Make the `route.json` add fail the way a browser can: its request errors, the transaction aborts (with or without a cause), or add throws. */
function failOnRoute(how) {
  const add = IDBObjectStore.prototype.add;
  return vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (record) {
    if (record.filename !== 'route.json') return add.call(this, record);
    if (how === 'throw') throw new DOMException('could not be cloned', 'DataCloneError');
    if (how === 'request-quota') {
      // fake-indexeddb runs its own error event, abort and rollback for a failing record store
      const raw = this._rawObjectStore;
      const storeRecord = raw.storeRecord;
      raw.storeRecord = () => { raw.storeRecord = storeRecord; throw quota(); };
      return add.call(this, record);
    }
    const request = add.call(this, record);
    const transaction = this.transaction;
    // after every add is queued, as a failed commit or a closing tab would
    queueMicrotask(() => {
      transaction.abort();
      if (how === 'abort-quota') transaction.error = quota(); // set before the abort event fires
    });
    return request;
  });
}

it('writes a whole check in one transaction and lists it', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
  await localSnapshots.writeAll('check', CHECK);
  expect(transaction.mock.calls.filter(([, mode]) => mode === 'readwrite')).toHaveLength(1);
  for (const { filename, content } of CHECK) expect(await localSnapshots.read('check', filename)).toBe(content);
  expect((await localSnapshots.list()).map(item => item.snapshot_id)).toEqual(['check']);
});

it.each([
  ['a request quota failure', 'request-quota', 'QuotaExceededError'],
  ['a quota failure on commit', 'abort-quota', 'QuotaExceededError'],
  ['an aborted transaction', 'abort', 'AbortError'],
  ['an add that throws', 'throw', 'DataCloneError'],
])('%s part-way leaves no record of the check, and the same check then saves', async (_name, how, name) => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const spy = failOnRoute(how);
  const failure = localSnapshots.writeAll('check', CHECK);
  await expect(failure).rejects.toMatchObject({ name });
  if (how !== 'abort') await expect(failure).rejects.not.toMatchObject({ message: '' });
  spy.mockRestore();
  expect(await recordsOf('check')).toEqual([]);
  expect(await localSnapshots.exists('check')).toBe(false);
  expect(await localSnapshots.list()).toEqual([]);
  await localSnapshots.writeAll('check', CHECK);
  expect(await recordsOf('check')).toHaveLength(CHECK.length);
  expect((await localSnapshots.list()).map(item => item.snapshot_id)).toEqual(['check']);
});

it('refuses a batch over a pre-existing partial check without adding or changing a record', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await localSnapshots.write('check', 'route.json', '{"original":true}');
  await expect(localSnapshots.writeAll('check', CHECK)).rejects.toMatchObject({ name: 'ConstraintError' });
  expect(await recordsOf('check')).toEqual(['check/route.json']);
  expect(await localSnapshots.read('check', 'route.json')).toBe('{"original":true}');
  expect(await localSnapshots.list()).toEqual([]);
});

it('rejects a batch when IndexedDB is missing or cannot open', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(localSnapshots.writeAll('check', CHECK)).rejects.toThrow('no IndexedDB');
  const { error } = installDb({ openFailure: 'error' });
  await expect(localSnapshots.writeAll('check', CHECK)).rejects.toBe(error);
});
