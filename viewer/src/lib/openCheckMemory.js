/**
 * The browser-saved check open in this tab, remembered for a reload or a tab
 * the browser restores. Per tab (sessionStorage), so two tabs reopen their own
 * checks; nothing about the check goes into the URL, which stays the address of
 * served checks only. Only the opaque check id is kept; the check itself stays
 * in IndexedDB (localSnapshots.js). Blocked storage just means no reopen.
 */
const KEY = 'deepweather.open-check';

export const openCheckMemory = {
  read() {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  remember(snapshotId) {
    try {
      sessionStorage.setItem(KEY, snapshotId);
    } catch {
      // the open check is simply not restored after a reload
    }
  },
  forget(snapshotId = null) {
    try {
      if (snapshotId === null || sessionStorage.getItem(KEY) === snapshotId) sessionStorage.removeItem(KEY);
    } catch {
      // nothing was stored
    }
  },
};
