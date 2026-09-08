import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let localSnapshots;
let fetchSnapshotJson;

beforeEach(async () => {
  vi.resetModules();
  ({ localSnapshots, fetchSnapshotJson } = await import('../src/lib/localSnapshots.js'));
});
afterEach(() => vi.unstubAllGlobals());

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
