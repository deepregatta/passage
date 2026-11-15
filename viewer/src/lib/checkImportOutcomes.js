// How an import from a file ends (lib/checkImport.js), kept apart from the
// importer so My passages can show the control and its messages without
// loading the importer and its validators until a file is chosen.

export const IMPORT = Object.freeze({
  imported: 'imported',
  alreadyHere: 'already-here',
  notCheckFile: 'not-check-file',
  newer: 'newer-version',
  count: 'check-count',
  tooLarge: 'too-large',
  damaged: 'damaged',
  future: 'future-time',
  polar: 'polar',
  served: 'served',
  offline: 'offline',
  conflict: 'conflict',
  storage: 'storage',
});

/** This browser can read a gzip file; without DecompressionStream the import is not offered. */
export const canImportCheckFile = () => typeof DecompressionStream === 'function';

/** Run once the page is idle (a second later where the browser has no idle callback); returns a cancel. */
export function whenIdle(run) {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run);
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 1000);
  return () => clearTimeout(timer);
}
