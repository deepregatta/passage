import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { IMPORT, canImportCheckFile, whenIdle } from '../lib/checkImportOutcomes.js';
import { OWNED, localTime, passageText } from '../lib/passages.js';
import { importStartLine, importSummary, importerUnavailable, importingLine, listsAfter, removeLabel, removeQuestion, removedLine, singleStatusOf } from '../lib/checksFileText.js';
import ConfirmDialog from './ConfirmDialog.jsx';

/**
 * "Import from a file" on My passages (2026-11-15; one control for both kinds
 * of file since 2026-11-16): a .json.gz file saved from Passage, with one check
 * (version 1, or version 2 with one line: told exactly as stage 1 tells it,
 * with "Open the check") or many (version 2, lib/checkImportMany.js: a running
 * count with a Stop button, then one summary). Read in this browser and stored
 * like saved checks, marked as imported; nothing is uploaded. After an import
 * of many that stored any, one button removes exactly what it added, through
 * the confirmation dialog. The importer and its validators load once the page
 * is idle or a file is chosen. Not offered without DecompressionStream. No
 * analytics event. `removeChecks(ids)` is the page's removal of imported
 * checks (Passages.jsx: through the store delete its own "Delete" uses). When
 * the Stop or the undo button goes while it has focus, focus moves to the line
 * that says how it ended, so it never falls to the page.
 */
export default function ImportCheck({ language, onAnnounce, removeChecks }) {
  const loadManifest = useApp((state) => state.loadManifest);
  const openSnapshot = useApp((state) => state.openSnapshot);
  const servedIds = useApp((state) => state.servedIds);
  const input = useRef(null);
  const busy = useRef(false);
  const controller = useRef(null);
  const [state, setState] = useState({ working: false, progress: null, status: null, snapshotId: null, departureUtc: null, summary: null, added: [] });
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(null);
  const progressBlock = useRef(null);
  const outcome = useRef(null);
  const removedText = useRef(null);
  const mainButton = useRef(null);
  // the ref of what gets focus once the state that removed a focused button is drawn
  const refocus = useRef(null);
  const progressText = useId();
  useEffect(() => {
    const target = refocus.current;
    if (!target || state.working) return;
    refocus.current = null;
    (target.current ?? mainButton.current)?.focus();
  }, [state, removed]);

  // Load the importer once the page is idle, so a page that loaded online can still import after the connection drops.
  useEffect(() => {
    if (!canImportCheckFile()) return undefined;
    return whenIdle(() => { import('../lib/checkImportMany.js').catch(() => {}); });
  }, []);
  useEffect(() => () => controller.current?.abort(), []);

  if (!canImportCheckFile()) return null;

  async function chosen(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // the same file can be chosen again
    if (!file || busy.current) return;
    busy.current = true;
    const stop = new AbortController();
    controller.current = stop;
    setState({ working: true, progress: null, status: null, snapshotId: null, departureUtc: null, summary: null, added: [] });
    setRemoved(null);
    // the live text changes even when this import ends like the last one
    onAnnounce?.('');
    const onProgress = ({ index }) => {
      if (index === 0) onAnnounce?.(importStartLine(language));
      setState((current) => ({ ...current, progress: { index } }));
    };
    let result;
    try {
      const { importChecksFile } = await import('../lib/checkImportMany.js');
      result = await importChecksFile(file, { servedIds, signal: stop.signal, onProgress });
    } catch {
      result = importerUnavailable();
    } finally {
      busy.current = false;
      controller.current = null;
    }
    // Stop goes with the count: focus on it moves to the outcome
    if (progressBlock.current?.contains(document.activeElement)) refocus.current = outcome;
    const single = singleStatusOf(result);
    if (single) {
      if (listsAfter(result, single)) await loadManifest();
      // a check of a version-2 file departs as its listing says
      const departureUtc = single.departureUtc ?? useApp.getState().manifest?.snapshots?.find((entry) => entry.snapshot_id === single.snapshotId)?.departure_utc ?? null;
      setState({ working: false, progress: null, status: single.status, snapshotId: single.snapshotId, departureUtc, summary: null, added: [] });
      const done = resultLine(single.status, departureUtc ? localTime(departureUtc, language) : null, language);
      // the page's own live region says it (a failure is an alert of its own)
      if (done) onAnnounce?.(done);
      return;
    }
    await loadManifest();
    const summary = importSummary(result, language);
    setState({ working: false, progress: null, status: null, snapshotId: null, departureUtc: null, summary, added: result.importedIds ?? [] });
    if (summary.info.length) onAnnounce?.(summary.info.join(' '));
  }

  async function removeAdded() {
    const ids = state.added;
    setConfirming(false);
    if (!ids.length) return;
    let gone;
    if (removeChecks) ({ removed: gone } = await removeChecks(ids));
    else ({ removed: gone } = await (await import('../lib/checkImportMany.js')).removeImportedChecks(ids));
    await loadManifest();
    // the undo button goes: focus moves to the line saying how many were removed
    refocus.current = removedText;
    setState((current) => ({ ...current, added: [] }));
    const line = removedLine(gone.length, language);
    setRemoved(line);
    onAnnounce?.(line);
  }

  const { working, progress, status, summary, added } = state;
  const time = state.departureUtc ? localTime(state.departureUtc, language) : null;
  const opened = status === IMPORT.imported || status === IMPORT.alreadyHere;
  const line = resultLine(status, time, language);
  return (
    <div className="space-y-2" data-testid="import-check">
      <input ref={input} type="file" accept=".gz,application/gzip" className="sr-only" tabIndex={-1} aria-hidden onChange={chosen} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          ref={mainButton}
          type="button"
          onClick={() => { if (!busy.current) input.current?.click(); }}
          aria-disabled={working || undefined}
          className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft aria-disabled:opacity-50 aria-disabled:cursor-wait"
        >
          {working ? 'Importing…' : 'Import from a file'}
        </button>
        <span className="font-sans text-sm text-ink-soft">Choose a file saved from Passage (.json.gz), with one check or all of them. It is read in this browser; nothing is uploaded.</span>
      </div>
      {working && progress && (
        <div ref={progressBlock} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="import-progress">
          {/* indeterminate: a file says how many checks it holds only at its end */}
          <progress aria-labelledby={progressText} className="w-40 max-w-full" />
          <span id={progressText} className="font-sans text-sm text-ink-soft" {...OWNED}>{importingLine(progress.index, language)}</span>
          <button type="button" onClick={() => controller.current?.abort()} className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft">
            Stop
          </button>
        </div>
      )}
      {line && <p ref={outcome} tabIndex={-1} data-testid="import-result" className="font-sans text-sm text-ink focus:outline-hidden" {...OWNED}>{line}</p>}
      {opened && (
        <button type="button" onClick={() => openSnapshot(state.snapshotId)} className="min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
          Open the check
        </button>
      )}
      {status && !opened && <ImportProblem status={status} focusRef={outcome} />}
      {summary && (
        <div data-testid="import-summary" className="space-y-1">
          {summary.info.map((text, i) => <p key={text} ref={i === 0 ? outcome : undefined} tabIndex={i === 0 ? -1 : undefined} className="font-sans text-sm text-ink focus:outline-hidden" {...OWNED}>{text}</p>)}
          {summary.problems.length > 0 && (
            <div ref={summary.info.length ? undefined : outcome} tabIndex={summary.info.length ? undefined : -1} role="alert" className="space-y-1 focus:outline-hidden" {...OWNED}>
              {summary.problems.map((text) => <p key={text} className="font-sans text-sm text-verdict-exceeds">{text}</p>)}
            </div>
          )}
        </div>
      )}
      {added.length > 0 && (
        <div className="space-y-1">
          <button type="button" onClick={() => setConfirming(true)} className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft" {...OWNED}>
            {removeLabel(added.length, language)}
          </button>
          <p data-testid="import-undo-note" className="font-sans text-sm text-ink-soft">This button stays only until you leave this page.</p>
        </div>
      )}
      {removed && <p ref={removedText} tabIndex={-1} data-testid="import-removed" className="font-sans text-sm text-ink focus:outline-hidden" {...OWNED}>{removed}</p>}
      {confirming && (
        <ConfirmDialog
          heading={removeQuestion(added.length, language)}
          headingProps={OWNED}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          onConfirm={removeAdded}
          onCancel={() => setConfirming(false)}
        >
          <p className="font-medium">This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The line after an import that worked or found the check already here; null otherwise. */
function resultLine(status, time, language) {
  if (status === IMPORT.imported) return passageText('Check imported from a file, departing {time}.', { time }, language);
  if (status === IMPORT.alreadyHere) return passageText('This check is already in My passages, departing {time}.', { time }, language);
  return null;
}

function ImportProblem({ status, focusRef }) {
  return (
    <p ref={focusRef} tabIndex={-1} role="alert" className="font-sans text-sm text-verdict-exceeds focus:outline-hidden">
      {status === IMPORT.notCheckFile && 'This file is not a Passage check file.'}
      {status === IMPORT.newer && 'This file was made by a newer Passage. Reload the page to update Passage, then try again.'}
      {status === IMPORT.count && 'This file holds more than one check, or none. Passage imports one check per file.'}
      {status === IMPORT.tooLarge && 'This file is too large to be a Passage check file.'}
      {status === IMPORT.damaged && 'This check was not imported: the file is damaged or has been altered.'}
      {status === IMPORT.future && 'This check was not imported: its time is in the future. Check this device’s date and time.'}
      {status === IMPORT.polar && 'This check was not imported: the file holds boat polar data, which Passage never stores from a file.'}
      {status === IMPORT.served && 'This check was not imported: it is one of the checks Passage publishes, such as the example.'}
      {status === IMPORT.offline && 'This check could not be imported now. Check your connection and try again.'}
      {status === IMPORT.manyOffline && 'The checks in this file could not be imported now. Check your connection and try again.'}
      {status === IMPORT.conflict && 'This check was not imported: a different check with the same identity is already in this browser. Nothing was changed.'}
      {status === IMPORT.storage && 'This check was not imported: this browser could not store it, and nothing was saved.'}
    </p>
  );
}
