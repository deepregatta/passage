/**
 * IndexedDB-backed TileCache. Immutable tile bytes live separately from small
 * LRU/run metadata so budget checks and eviction never materialize the cache.
 * Storage failures are non-fatal: callers retain their in-memory fallback.
 */
const DB_NAME = 'passage-forecast-tiles';
const STORE = 'tiles';
const METADATA = 'metadata';
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const FALLBACK_BYTES = 64 * 1024 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 1 mixed bytes and metadata. This disposable cache can be
      // refetched; clearing avoids reading all old bytes during migration.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: 'key' });
      db.createObjectStore(METADATA, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const result = fn(transaction);
    transaction.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function storageEstimate() {
  try {
    return await globalThis.navigator?.storage?.estimate?.();
  } catch {
    return undefined;
  }
}

function byteBudget(estimate, cachedBytes) {
  if (!Number.isFinite(estimate?.quota) || estimate.quota <= 0) return FALLBACK_BYTES;
  // Use at most 10% of the origin quota, keeping half the remaining room for
  // snapshots, other storage and IndexedDB overhead. Usage includes our cache.
  const usage = Number.isFinite(estimate.usage) && estimate.usage >= 0 ? estimate.usage : 0;
  const otherUsage = Math.max(0, usage - cachedBytes);
  return Math.floor(Math.max(0, Math.min(MAX_BYTES, estimate.quota * 0.1, (estimate.quota - otherUsage) * 0.5)));
}

export class IndexedDbTileCache {
  constructor() {
    this.dbPromise = null;
    this.touched = new Set();
  }

  db() {
    this.dbPromise ??= openDb().catch(error => {
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }

  async get(key) {
    try {
      const db = await this.db();
      const entry = await tx(db, [STORE], 'readonly', t => t.objectStore(STORE).get(key));
      if (!entry) return null;
      if (!this.touched.has(key)) {
        this.touched.add(key);
        await tx(db, [METADATA], 'readwrite', t => {
          const store = t.objectStore(METADATA);
          const request = store.get(key);
          request.onsuccess = () => {
            // Re-read in the write transaction: never resurrect an evicted key.
            if (request.result) store.put({ ...request.result, used_at: Date.now() });
          };
        }).catch(() => this.touched.delete(key));
      }
      return new Uint8Array(entry.bytes);
    } catch {
      return null;
    }
  }

  async put(key, bytes, runId) {
    try {
      const db = await this.db();
      const estimate = await storageEstimate();
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      // Budget, deletion and insertion share one transaction across both stores.
      // Concurrent writers cannot race a stale metadata snapshot or leave orphans.
      await tx(db, [STORE, METADATA], 'readwrite', t => {
        const tiles = t.objectStore(STORE);
        const metadata = t.objectStore(METADATA);
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = request.result;
          const total = entries.reduce((sum, entry) => sum + entry.size, 0);
          const budget = byteBudget(estimate, total);
          if (buffer.byteLength > budget) return;
          let required = total - (entries.find(entry => entry.key === key)?.size ?? 0) + buffer.byteLength;
          entries.sort((a, b) => a.used_at - b.used_at);
          for (const entry of entries) {
            if (required <= budget) break;
            if (entry.key === key) continue;
            tiles.delete(entry.key);
            metadata.delete(entry.key);
            required -= entry.size;
          }
          tiles.put({ key, bytes: buffer });
          metadata.put({ key, run_id: runId, size: buffer.byteLength, used_at: Date.now() });
        };
      });
    } catch {
      // Includes quota errors: the transaction rolls back both stores together.
    }
  }

  async evictExcept(runIds) {
    try {
      const keep = new Set(runIds);
      const db = await this.db();
      await tx(db, [STORE, METADATA], 'readwrite', t => {
        const metadata = t.objectStore(METADATA);
        const request = metadata.getAll();
        request.onsuccess = () => {
          for (const entry of request.result) {
            if (keep.has(entry.run_id)) continue;
            t.objectStore(STORE).delete(entry.key);
            metadata.delete(entry.key);
          }
        };
      });
    } catch {
      // Eviction failures are non-fatal.
    }
  }
}

/** IndexedDB when available, else null (store falls back to memory cache). */
export function createTileCache() {
  return typeof indexedDB === 'undefined' ? null : new IndexedDbTileCache();
}
