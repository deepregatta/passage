// The last file of all checks this browser handed to a download (My passages,
// components/SaveAllChecks.jsx): when it was made and which checks it holds,
// so the page can say which checks saved since are not in it. A convenience
// only: it lives in this browser's local storage, every read and write may
// fail, and the page works without it. Nothing is sent anywhere.

export const LAST_CHECKS_FILE_KEY = 'deepweather.last-checks-file';
/** A check id a version-2 file can hold (engine/src/checkFile.ts SNAPSHOT_V2_ID), without loading the engine. */
export const EXPORTABLE_ID = /^snapshot_v2_[0-9a-f]{16}$/;

/** The record { madeAt, ids }, or null when there is none or it cannot be read. */
export function readLastChecksFile() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_CHECKS_FILE_KEY) ?? 'null');
    if (!value || typeof value.made_at !== 'string' || !Number.isFinite(Date.parse(value.made_at))) return null;
    if (!Array.isArray(value.ids) || value.ids.length > 1000 || !value.ids.every((id) => typeof id === 'string' && EXPORTABLE_ID.test(id))) return null;
    return { madeAt: value.made_at, ids: value.ids };
  } catch {
    return null;
  }
}

/** Keep the record; false when this browser would not store it. */
export function writeLastChecksFile({ madeAt, ids }) {
  try {
    localStorage.setItem(LAST_CHECKS_FILE_KEY, JSON.stringify({ made_at: madeAt, ids }));
    return true;
  } catch {
    return false;
  }
}

/** The checks this browser can put in a file: saved or imported here, with a v2 id. */
export const exportableIds = (snapshots) => (snapshots ?? [])
  .filter((snapshot) => snapshot?.local && EXPORTABLE_ID.test(snapshot.snapshot_id))
  .map((snapshot) => snapshot.snapshot_id);
