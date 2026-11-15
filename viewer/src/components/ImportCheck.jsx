import { useEffect, useRef, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { IMPORT, canImportCheckFile, whenIdle } from '../lib/checkImportOutcomes.js';
import { OWNED, localTime, passageText } from '../lib/passages.js';

/**
 * "Import a check" on My passages (2026-11-15): one .json.gz check file saved
 * from Passage, read in this browser and stored like a saved check, marked as
 * imported. The importer and its validators load only once a file is chosen.
 * Not offered without DecompressionStream. No analytics event.
 */
export default function ImportCheck({ language, onAnnounce }) {
  const loadManifest = useApp((state) => state.loadManifest);
  const openSnapshot = useApp((state) => state.openSnapshot);
  const servedIds = useApp((state) => state.servedIds);
  const input = useRef(null);
  const busy = useRef(false);
  const [state, setState] = useState({ status: null, snapshotId: null, departureUtc: null, working: false });

  // Load the importer once the page is idle, so a page that loaded online can still import after the connection drops.
  useEffect(() => {
    if (!canImportCheckFile()) return undefined;
    return whenIdle(() => { import('../lib/checkImport.js').catch(() => {}); });
  }, []);

  if (!canImportCheckFile()) return null;

  async function chosen(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // the same file can be chosen again
    if (!file || busy.current) return;
    busy.current = true;
    setState({ status: null, snapshotId: null, departureUtc: null, working: true });
    // the live text changes even when this import ends like the last one
    onAnnounce?.('');
    let result;
    try {
      const { importCheckFile } = await import('../lib/checkImport.js');
      result = await importCheckFile(file, { servedIds });
    } catch {
      // the importer itself could not load (offline, or a newer site): nothing was read or written
      result = { outcome: IMPORT.offline };
    } finally {
      busy.current = false;
    }
    setState({ status: result.outcome, snapshotId: result.snapshotId ?? null, departureUtc: result.departureUtc ?? null, working: false });
    const done = resultLine(result.outcome, result.departureUtc ? localTime(result.departureUtc, language) : null, language);
    // the page's own live region says it (a failure is an alert of its own)
    if (done) onAnnounce?.(done);
    if (result.outcome === IMPORT.imported) await loadManifest();
  }

  const { status, working } = state;
  const time = state.departureUtc ? localTime(state.departureUtc, language) : null;
  const opened = status === IMPORT.imported || status === IMPORT.alreadyHere;
  const line = resultLine(status, time, language);
  return (
    <div className="mt-6 max-w-3xl space-y-2" data-testid="import-check">
      <input ref={input} type="file" accept=".gz,application/gzip" className="sr-only" tabIndex={-1} aria-hidden onChange={chosen} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => { if (!busy.current) input.current?.click(); }}
          aria-disabled={working || undefined}
          className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft aria-disabled:opacity-50 aria-disabled:cursor-wait"
        >
          {working ? 'Importing…' : 'Import a check'}
        </button>
        <span className="font-sans text-sm text-ink-soft">Choose a check file saved from Passage (.json.gz). It is read in this browser; nothing is uploaded.</span>
      </div>
      {line && <p data-testid="import-result" className="font-sans text-sm text-ink" {...OWNED}>{line}</p>}
      {opened && (
        <button type="button" onClick={() => openSnapshot(state.snapshotId)} className="min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
          Open the check
        </button>
      )}
      {status && !opened && <ImportProblem status={status} />}
    </div>
  );
}

/** The line after an import that worked or found the check already here; null otherwise. */
function resultLine(status, time, language) {
  if (status === IMPORT.imported) return passageText('Check imported from a file, departing {time}.', { time }, language);
  if (status === IMPORT.alreadyHere) return passageText('This check is already in My passages, departing {time}.', { time }, language);
  return null;
}

function ImportProblem({ status }) {
  return (
    <p role="alert" className="font-sans text-sm text-verdict-exceeds">
      {status === IMPORT.notCheckFile && 'This file is not a Passage check file.'}
      {status === IMPORT.newer && 'This file was made by a newer Passage. Reload the page to update Passage, then try again.'}
      {status === IMPORT.count && 'This file holds more than one check, or none. Passage imports one check per file.'}
      {status === IMPORT.tooLarge && 'This file is too large to be a Passage check file.'}
      {status === IMPORT.damaged && 'This check was not imported: the file is damaged or has been altered.'}
      {status === IMPORT.future && 'This check was not imported: its time is in the future. Check this device’s date and time.'}
      {status === IMPORT.polar && 'This check was not imported: the file holds boat polar data, which Passage never stores from a file.'}
      {status === IMPORT.served && 'This check was not imported: it is one of the checks Passage publishes, such as the example.'}
      {status === IMPORT.offline && 'This check could not be imported now. Check your connection and try again.'}
      {status === IMPORT.conflict && 'This check was not imported: a different check with the same identity is already in this browser. Nothing was changed.'}
      {status === IMPORT.storage && 'This check was not imported: this browser could not store it, and nothing was saved.'}
    </p>
  );
}
