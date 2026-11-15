import { identityFields } from './passageIdentity.js';
import { gunzipText, gzipText } from './snapshotCodec.js';
// Browser-local snapshot persistence for static hosting (Cloudflare Pages).
// The dev server accepts POST /data/snapshots/… and writes to the repo; in
// production there is no write endpoint, so briefings persist here instead —
// one IndexedDB record per artifact file, keyed `${snapshot_id}/${filename}`.
// A check is saved by writeAll in one transaction, so a failed save stores
// nothing. Snapshots remain write-once: add rejects replacement, and records
// left by an interrupted save from before writeAll are kept as they are.
// Since 2026-11-15 a new check's files, except the manifest, are stored as
// gzip bytes ({ encoding: 'gzip', content: Uint8Array }) when that is smaller;
// read returns the original text for both forms. Saved records are never
// rewritten (docs/saved-identities.md).

const DB_NAME = 'passage-local-snapshots';
const STORE = 'files';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (event) => {
      const store = event.oldVersion < 1
        ? req.result.createObjectStore(STORE, { keyPath: 'key' })
        : req.transaction.objectStore(STORE);
      if (event.oldVersion < 1) store.createIndex('snapshot_id', 'snapshot_id');
      // IndexedDB backfills existing records without loading artifact bodies into JS.
      store.createIndex('filename', 'filename');
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }).catch((error) => {
    // A failed open must not poison every later storage attempt.
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(request?.result);
    t.onerror = () => reject(request?.error ?? t.error);
    t.onabort = () => reject(t.error);
  });
}

// Adds every record in one readwrite transaction: any failure aborts it and
// rolls back every add, so either all records exist afterwards or none do.
// Rejects with the cause, wherever the browser reports it: a request's error
// (a duplicate key, or quota in some browsers), the transaction's error (quota
// on commit), the error add threw, or an AbortError when nothing names one.
function addAll(db, records) {
  return new Promise((resolve, reject) => {
    let cause = null;
    const t = db.transaction(STORE, 'readwrite');
    t.oncomplete = () => resolve();
    // Requests still queued when the transaction aborts fail with AbortError:
    // a consequence, not the cause.
    t.onerror = (event) => {
      const error = event.target?.error;
      if (error && error.name !== 'AbortError') cause ??= error;
    };
    t.onabort = () => reject(cause ?? t.error ?? new DOMException('The save was interrupted.', 'AbortError'));
    try {
      const store = t.objectStore(STORE);
      for (const record of records) store.add(record);
    } catch (error) {
      cause ??= error;
      try { t.abort(); } catch { /* already aborting */ }
    }
  });
}

// The manifest stays a plain string: listing parses it straight from the index.
const MANIFEST = 'snapshot.json';
/** The record that marks a check imported from a file: never named in the
 * manifest's artifacts and never exported (lib/checkImport.js). */
export const IMPORT_MARKER = 'imported.json';

/** The record one file is stored as. Compression finishes here, before any
 * transaction opens: a transaction commits as soon as its code awaits anything
 * but its own requests, so awaiting a stream inside it would split a check.
 * A saved check is write-once, so gzip bytes are stored only after this
 * browser has decoded them back to exactly the same text. Without
 * CompressionStream, on a codec error, when the round trip fails or differs,
 * or when gzip does not shrink the text, the record is plain, exactly as
 * before (no `encoding` field). */
async function toRecord(snapshotId, filename, content) {
  const record = { key: `${snapshotId}/${filename}`, snapshot_id: snapshotId, filename, content };
  if (filename === MANIFEST || typeof content !== 'string') return record;
  try {
    const bytes = await gzipText(content);
    if (bytes && bytes.byteLength < content.length && await gunzipText(bytes) === content) {
      return { ...record, encoding: 'gzip', content: bytes };
    }
  } catch {
    // compression is an optimisation: never a failed save
  }
  return record;
}

/** A record's text, or null. A record this build cannot decode (an unknown
 * encoding, no DecompressionStream, corrupt bytes) reads as null, the path an
 * unreadable record takes: the check still exists, so the opener reports it
 * cannot load it and an exact retry is refused (blocked) without writing. */
async function contentOf(record) {
  if (record?.encoding === undefined) return record?.content ?? null;
  try {
    if (record.encoding !== 'gzip') throw new Error(`unknown encoding ${String(record.encoding)}`);
    return await gunzipText(record.content);
  } catch (error) {
    console.error(`Saved briefing file ${record.key} cannot be read in this browser:`, error);
    return null;
  }
}

// A saved manifest is data from storage, which a damaged store, an old build or
// a hand edit can leave in any shape. Listing reads each field as the type My
// passages uses it as, and a value of another type reads as absent, so one
// damaged manifest cannot break the page or the list of the other checks
// (2026-11-15). Which manifests are listed is unchanged.
const text = (value) => (typeof value === 'string' ? value : undefined);
const IDENTITY_TYPES = { identity_version: 'number', passage_id: 'string', route_revision: 'string', decision_hash: 'string', check_sequence: 'number' };

function listEntry(record) {
  let doc;
  try {
    doc = JSON.parse(record.content);
    if (doc === null) return null;
  } catch {
    return null;
  }
  const fields = typeof doc === 'object' ? doc : {};
  // The id every file of the check is stored, read and deleted under; the
  // manifest's own copy only when the record has none (they match for every
  // check this app saves).
  const snapshotId = text(record.snapshot_id) || text(fields.snapshot_id);
  if (!snapshotId) return null;
  const identity = Object.fromEntries(Object.entries(identityFields(fields))
    .filter(([key, value]) => typeof value === IDENTITY_TYPES[key]));
  return {
    ...identity,
    snapshot_id: snapshotId,
    created_at: text(fields.created_at),
    route_id: text(fields.route_id),
    profile_id: text(fields.profile_id),
    departure_utc: text(fields.departure_utc),
    verdict_state: text(fields.verdict_state) ?? null,
    demo: false,
    local: true,
  };
}

const available = () => typeof indexedDB !== 'undefined';
const NO_INDEXEDDB = 'This browser cannot store briefings (no IndexedDB)';

export const localSnapshots = {
  async exists(snapshotId) {
    if (!available()) return false;
    try {
      const db = await openDb();
      const count = await tx(db, 'readonly', (s) => s.index('snapshot_id').count(snapshotId));
      return count > 0;
    } catch {
      return false;
    }
  },

  /** Whether a record of this file exists for the check, without reading it (false when storage fails). */
  async has(snapshotId, filename) {
    if (!available()) return false;
    try {
      const db = await openDb();
      return (await tx(db, 'readonly', (s) => s.count(`${snapshotId}/${filename}`))) > 0;
    } catch {
      return false;
    }
  },

  async write(snapshotId, filename, content) {
    if (!available()) throw new Error(NO_INDEXEDDB);
    const record = await toRecord(snapshotId, filename, content);
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.add(record));
  },

  /** All files of one check ([{filename, content}], manifest last), all or nothing. */
  async writeAll(snapshotId, files) {
    if (!available()) throw new Error(NO_INDEXEDDB);
    // every file is compressed before the one transaction opens
    const records = await Promise.all(files.map(({ filename, content }) => toRecord(snapshotId, filename, content)));
    const db = await openDb();
    await addAll(db, records);
  },

  // returns the raw JSON string, or null when this snapshot/file is not local
  // or cannot be read (see contentOf)
  async read(snapshotId, filename) {
    if (!available()) return null;
    let record;
    try {
      const db = await openDb();
      record = await tx(db, 'readonly', (s) => s.get(`${snapshotId}/${filename}`));
    } catch {
      return null;
    }
    return contentOf(record);
  },

  // manifest entries (same shape as /data/snapshots/manifest.json), newest first
  async list() {
    if (!available()) return [];
    try {
      const db = await openDb();
      const records = (await tx(db, 'readonly', (s) =>
        s.index('filename').getAll('snapshot.json'),
      )) ?? [];
      // a check imported from a file has an imported.json marker (lib/checkImport.js)
      const marked = new Set(((await tx(db, 'readonly', (s) => s.index('filename').getAllKeys(IMPORT_MARKER))) ?? [])
        .map((key) => (typeof key === 'string' ? key.slice(0, -IMPORT_MARKER.length - 1) : null)));
      return records
        .map(listEntry)
        .filter(Boolean)
        .map((entry) => (marked.has(entry.snapshot_id) ? { ...entry, imported: true } : entry))
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
