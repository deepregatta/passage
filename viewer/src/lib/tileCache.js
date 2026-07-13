/**
 * IndexedDB-backed TileCache for the forecast tile store. Tiles are immutable
 * per run, so entries are keyed `${run_id}/${path}` and evicted whole runs at
 * a time (evictExcept, called by the store after reading latest.json). A byte
 * budget guards against unbounded growth; when IndexedDB is unavailable
 * (private browsing, old browsers), callers fall back to the in-memory cache.
 */

const DB_NAME = 'passage-forecast-tiles';
const STORE = 'tiles';
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('run_id', 'run_id');
      store.createIndex('used_at', 'used_at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class IndexedDbTileCache {
  constructor() {
    this.dbPromise = null;
  }

  db() {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async get(key) {
    try {
      const db = await this.db();
      const entry = await tx(db, 'readonly', (store) => store.get(key));
      if (!entry) return null;
      // touch used_at for LRU without blocking the read path
      tx(db, 'readwrite', (store) => store.put({ ...entry, used_at: Date.now() })).catch(() => {});
      return new Uint8Array(entry.bytes);
    } catch {
      return null;
    }
  }

  async put(key, bytes, runId) {
    try {
      const db = await this.db();
      await tx(db, 'readwrite', (store) =>
        store.put({
          key,
          run_id: runId,
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          size: bytes.byteLength,
          used_at: Date.now(),
        }),
      );
      await this.enforceBudget(db);
    } catch {
      // cache write failures are non-fatal
    }
  }

  async evictExcept(runIds) {
    try {
      const keep = new Set(runIds);
      const db = await this.db();
      const entries = await tx(db, 'readonly', (store) => store.getAll());
      const stale = (entries ?? []).filter((e) => !keep.has(e.run_id));
      if (stale.length) {
        await tx(db, 'readwrite', (store) => {
          for (const e of stale) store.delete(e.key);
        });
      }
    } catch {
      // eviction failures are non-fatal
    }
  }

  async enforceBudget(db) {
    const entries = (await tx(db, 'readonly', (store) => store.getAll())) ?? [];
    let total = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
    if (total <= MAX_BYTES) return;
    const byAge = entries.sort((a, b) => (a.used_at ?? 0) - (b.used_at ?? 0));
    const doomed = [];
    for (const e of byAge) {
      if (total <= MAX_BYTES) break;
      doomed.push(e.key);
      total -= e.size ?? 0;
    }
    await tx(db, 'readwrite', (store) => {
      for (const key of doomed) store.delete(key);
    });
  }
}

/** IndexedDB when available, else null (store falls back to memory cache) */
export function createTileCache() {
  return typeof indexedDB === 'undefined' ? null : new IndexedDbTileCache();
}
