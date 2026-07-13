// Browser-local snapshot persistence for static hosting (Cloudflare Pages).
// The dev server accepts POST /data/snapshots/… and writes to the repo; in
// production there is no write endpoint, so briefings persist here instead —
// one IndexedDB record per artifact file, keyed `${snapshot_id}/${filename}`.
// Snapshots remain write-once: exists() is checked before any write.

const DB_NAME = 'passage-local-snapshots';
const STORE = 'files';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('snapshot_id', 'snapshot_id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(request?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const available = () => typeof indexedDB !== 'undefined';

export const localSnapshots = {
  async exists(snapshotId) {
    if (!available()) return false;
    const db = await openDb();
    const record = await tx(db, 'readonly', (s) => s.get(`${snapshotId}/snapshot.json`));
    return record != null;
  },

  async write(snapshotId, filename, content) {
    if (!available()) throw new Error('This browser cannot store briefings (no IndexedDB)');
    const db = await openDb();
    await tx(db, 'readwrite', (s) =>
      s.put({ key: `${snapshotId}/${filename}`, snapshot_id: snapshotId, filename, content }),
    );
  },

  // returns the raw JSON string, or null when this snapshot/file is not local
  async read(snapshotId, filename) {
    if (!available()) return null;
    try {
      const db = await openDb();
      const record = await tx(db, 'readonly', (s) => s.get(`${snapshotId}/${filename}`));
      return record?.content ?? null;
    } catch {
      return null;
    }
  },

  // manifest entries (same shape as /data/snapshots/manifest.json), newest first
  async list() {
    if (!available()) return [];
    try {
      const db = await openDb();
      const records = (await tx(db, 'readonly', (s) => s.getAll())) ?? [];
      return records
        .filter((r) => r.filename === 'snapshot.json')
        .map((r) => {
          try {
            const doc = JSON.parse(r.content);
            return {
              snapshot_id: doc.snapshot_id ?? r.snapshot_id,
              created_at: doc.created_at,
              route_id: doc.route_id,
              profile_id: doc.profile_id,
              departure_utc: doc.departure_utc,
              verdict_state: doc.verdict_state ?? null,
              demo: false,
              local: true,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.snapshot_id.localeCompare(a.snapshot_id));
    } catch {
      return [];
    }
  },

  async remove(snapshotId) {
    if (!available()) return false;
    const db = await openDb();
    const keys = await tx(db, 'readonly', (s) =>
      s.index('snapshot_id').getAllKeys(snapshotId),
    );
    if (!keys?.length) return false;
    await tx(db, 'readwrite', (s) => {
      for (const key of keys) s.delete(key);
    });
    return true;
  },
};

// Snapshots baked into the static build (demo briefings) cannot be deleted
// server-side; "deleting" one hides it in this browser via a tombstone list.
const TOMBSTONES_KEY = 'deepweather.deleted-snapshots';

export const snapshotTombstones = {
  all() {
    try {
      return new Set(JSON.parse(localStorage.getItem(TOMBSTONES_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  },
  add(snapshotId) {
    const ids = this.all();
    ids.add(snapshotId);
    try {
      localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([...ids]));
    } catch {
      // storage full/blocked: the entry reappears next visit, nothing breaks
    }
  },
};

// Reads a snapshot artifact wherever it lives: browser-local first (user
// briefings on static hosting), then the served /data/snapshots/ tree
// (demo snapshots, dev middleware). A locally-stored snapshot is complete as
// written — a file it lacks (e.g. warnings.json) is absent, not elsewhere,
// so don't fall through to HTTP and log a guaranteed 404.
export async function fetchSnapshotJson(snapshotId, filename) {
  const local = await localSnapshots.read(snapshotId, filename);
  if (local !== null) return JSON.parse(local);
  if (await localSnapshots.exists(snapshotId)) {
    throw new Error(`${snapshotId}/${filename}: not stored with this briefing`);
  }
  const url = `/data/snapshots/${snapshotId}/${filename}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
