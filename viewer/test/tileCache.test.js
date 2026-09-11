import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore, IDBRequest } from 'fake-indexeddb';
import { IndexedDbTileCache, createTileCache } from '../src/lib/tileCache.js';

let caches;
const makeCache = () => { const cache = new IndexedDbTileCache(); caches.push(cache); return cache; };
const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const records = (db, store) => request(db.transaction(store).objectStore(store).getAll());

beforeEach(() => {
  caches = [];
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('navigator', { storage: { estimate: vi.fn().mockResolvedValue({ quota: 1000, usage: 0 }) } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cache of caches) (await cache.db().catch(() => null))?.close();
  vi.unstubAllGlobals();
});

describe('IndexedDbTileCache', () => {
  it('deletes one corrupt entry and its metadata while retaining healthy tiles', async () => {
    const cache = makeCache();
    await cache.put('r/bad', new Uint8Array([1]), 'r');
    await cache.put('r/good', new Uint8Array([2]), 'r');
    await cache.get('r/bad');
    await cache.delete('r/bad');
    await cache.delete('missing');
    expect(await cache.get('r/bad')).toBeNull();
    expect(await cache.get('r/good')).toEqual(new Uint8Array([2]));
    expect((await records(await cache.db(), 'metadata')).map(e => e.key)).toEqual(['r/good']);
    expect(cache.touched.has('r/bad')).toBe(false);
  });

  it('round trips only the supplied view and returns null on a miss', async () => {
    const cache = makeCache();
    expect(await cache.get('missing')).toBeNull();
    await cache.put('r/a', new Uint8Array([9, 1, 2, 9]).subarray(1, 3), 'r');
    expect(Array.from(await cache.get('r/a'))).toEqual([1, 2]);
  });

  it('never bulk reads tile bytes during writes or run eviction', async () => {
    const cache = makeCache();
    const bulk = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    await cache.put('old/a', new Uint8Array(10), 'old');
    await cache.put('keep/b', new Uint8Array(10), 'keep');
    await cache.evictExcept(['keep']);
    expect(bulk.mock.contexts.filter(store => store.name === 'tiles')).toHaveLength(0);
    expect(await cache.get('old/a')).toBeNull();
    expect(await cache.get('keep/b')).toHaveLength(10);
    const db = await cache.db();
    expect((await records(db, 'metadata')).map(e => e.key)).toEqual(['keep/b']);
  });

  it('touches metadata once per session without rewriting bytes', async () => {
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(10), 'r');
    const reader = makeCache();
    const writes = vi.spyOn(IDBObjectStore.prototype, 'put');
    await Promise.all([reader.get('r/a'), reader.get('r/a')]);
    await reader.get('r/a');
    await records(await reader.db(), 'tiles'); // drain queued transactions
    expect(writes.mock.contexts.filter(store => store.name === 'tiles')).toHaveLength(0);
    expect(writes.mock.contexts.filter(store => store.name === 'metadata')).toHaveLength(1);
  });

  it('evicts least recently used entries before writing within the quota budget', async () => {
    const cache = makeCache();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    await cache.put('r/a', new Uint8Array(40), 'r');
    now.mockReturnValue(2);
    await cache.put('r/b', new Uint8Array(40), 'r');
    now.mockReturnValue(3);
    await makeCache().get('r/a');
    await cache.put('r/c', new Uint8Array(40), 'r');
    expect(navigator.storage.estimate).toHaveBeenCalled();
    expect(await cache.get('r/b')).toBeNull();
    expect(await cache.get('r/a')).toHaveLength(40);
    expect(await cache.get('r/c')).toHaveLength(40);
  });

  it('accounts for replacement sizes and serializes concurrent writes', async () => {
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(80), 'r');
    await cache.put('r/a', new Uint8Array(20), 'r');
    await Promise.all([cache.put('r/b', new Uint8Array(40), 'r'), makeCache().put('r/c', new Uint8Array(40), 'r')]);
    const db = await cache.db();
    expect((await records(db, 'metadata')).reduce((n, e) => n + e.size, 0)).toBe(100);
    expect((await records(db, 'tiles')).map(e => e.key)).toEqual(['r/a', 'r/b', 'r/c']);
  });

  it('reserves headroom for other origin storage and skips oversized entries', async () => {
    navigator.storage.estimate.mockResolvedValue({ quota: 1000, usage: 980 });
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(11), 'r');
    expect(await cache.get('r/a')).toBeNull();
    await cache.put('r/b', new Uint8Array(10), 'r');
    expect(await cache.get('r/b')).toHaveLength(10);
  });

  it.each([undefined, { quota: NaN }, { quota: 0 }, { quota: Infinity }])('uses a finite fallback for unavailable estimates: %j', async estimate => {
    navigator.storage.estimate.mockResolvedValue(estimate);
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(10), 'r');
    expect(await cache.get('r/a')).toHaveLength(10);
  });

  it('tolerates denied storage estimates and unavailable IndexedDB', async () => {
    navigator.storage.estimate.mockRejectedValue(new Error('denied'));
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(10), 'r');
    expect(await cache.get('r/a')).toHaveLength(10);
    vi.stubGlobal('indexedDB', undefined);
    expect(createTileCache()).toBeNull();
    const unavailable = makeCache();
    expect(await unavailable.get('a')).toBeNull();
    await expect(unavailable.put('a', new Uint8Array(1), 'r')).resolves.toBeUndefined();
    await expect(unavailable.evictExcept([])).resolves.toBeUndefined();
  });

  it('rolls back eviction and both stores when a write aborts', async () => {
    const cache = makeCache();
    await cache.put('r/a', new Uint8Array(80), 'r');
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (entry) {
      const result = original.call(this, entry);
      if (this.name === 'metadata' && entry.key === 'r/b') this.transaction.abort();
      return result;
    });
    await expect(cache.put('r/b', new Uint8Array(80), 'r')).resolves.toBeUndefined();
    expect(await cache.get('r/a')).toHaveLength(80);
    expect(await cache.get('r/b')).toBeNull();
    expect((await records(await cache.db(), 'metadata')).map(e => e.key)).toEqual(['r/a']);
  });

  it('clears version 1 bytes on upgrade and stores metadata separately', async () => {
    const opening = indexedDB.open('passage-forecast-tiles', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('tiles', { keyPath: 'key' });
    const old = await request(opening);
    await request(old.transaction('tiles', 'readwrite').objectStore('tiles').put({ key: 'old', bytes: new ArrayBuffer(10) }));
    old.close();
    const cache = makeCache();
    expect(await cache.get('old')).toBeNull();
    const db = await cache.db();
    expect(db.version).toBe(2);
    await cache.put('r/a', new Uint8Array(10), 'r');
    expect(await records(db, 'metadata')).toEqual([{ key: 'r/a', run_id: 'r', size: 10, used_at: expect.any(Number) }]);
    expect(Object.keys((await records(db, 'tiles'))[0]).sort()).toEqual(['bytes', 'key']);
  });
});
