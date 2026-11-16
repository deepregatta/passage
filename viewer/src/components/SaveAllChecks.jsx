import { useEffect, useId, useRef, useState } from 'react';
import { OWNED, localTime } from '../lib/passages.js';
import { saveFile } from '../lib/download.js';
import { readLastChecksFile, writeLastChecksFile } from '../lib/lastChecksFile.js';
import { FAILURE, SAVE_ALL as PHASE, canSaveAllChecks, lastFileLine, logFailure, savePhaseOf, savedLine, stoppedLine, makingLine, notInLastFileLine, readyLine, skippedLines } from '../lib/checksFileText.js';

/**
 * "Save all checks to a file" in the storage block of My passages
 * (2026-11-16, stage 2): every check saved or imported in this browser with a
 * v2 identity, in one version-2 check file made here (lib/allChecksFile.js,
 * loaded on the first tap with its validators). Two taps on purpose: the
 * first makes the file, the second ("Save the file") is a fresh gesture that
 * hands it to the browser's downloads. Busy buttons stay focusable
 * (aria-disabled and a guard, never disabled); how it ends is said through
 * the page's one live region (onAnnounce), never per check; failures are
 * alerts. No analytics event. Not shown without
 * CompressionStream or when no check here can be put in a file; the line about
 * the last file shows whenever its record exists and a check is saved here.
 * When making ends while focus is on Stop, focus moves to the line that says
 * how it ended, so it never falls to the page.
 */

/** How long a handed-over file's object URL outlives the page or the control: some browsers read it lazily, after the click. */
export const REVOKE_DELAY_MS = 60_000;

export default function SaveAllChecks({ exportable, hasLocalCheck, language, onAnnounce }) {
  const [state, setState] = useState({ phase: PHASE.idle, index: 0, total: 0, counts: null, count: 0, bytes: 0 });
  const [lastFile, setLastFile] = useState(() => readLastChecksFile());
  const busy = useRef(false);
  const controller = useRef(null);
  const made = useRef(null); // { blob, name, exportedAt, included } of the file ready to save
  const url = useRef(null);
  const mounted = useRef(true);
  const progress = useRef(null);
  const outcome = useRef(null);
  const mainButton = useRef(null);
  const refocus = useRef(false);
  const progressText = useId();

  // A new file replaces the URL at once; leaving the page or the control lets it outlive the
  // download a while, since some browsers read a blob URL only after the click.
  const release = (later) => {
    const old = url.current;
    url.current = null;
    if (!old) return;
    if (later) setTimeout(() => URL.revokeObjectURL(old), REVOKE_DELAY_MS);
    else URL.revokeObjectURL(old);
  };
  useEffect(() => {
    mounted.current = true;
    const hide = () => release(true);
    window.addEventListener('pagehide', hide);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', hide);
      controller.current?.abort();
      release(true);
      made.current = null;
    };
  }, []);
  // Stop goes when making ends: focus that was on it moves to the line saying how it ended
  useEffect(() => {
    if (!refocus.current || state.phase === PHASE.making) return;
    refocus.current = false;
    (outcome.current ?? mainButton.current)?.focus();
  }, [state.phase]);

  const canSave = canSaveAllChecks() && exportable.length > 0;
  const missing = lastFile ? exportable.filter((id) => !lastFile.ids.includes(id)).length : 0;
  if (!canSave && !(lastFile && hasLocalCheck)) return null;

  async function make() {
    if (busy.current) return;
    busy.current = true;
    release(false);
    made.current = null;
    const stop = new AbortController();
    controller.current = stop;
    setState({ phase: PHASE.making, index: 0, total: exportable.length, counts: null, count: 0, bytes: 0 });
    // the live text changes even when this file ends like the last one
    onAnnounce?.('');
    let result;
    try {
      const { prepareAllChecksFile } = await import('../lib/allChecksFile.js');
      result = await prepareAllChecksFile({
        signal: stop.signal,
        onProgress: ({ index, total }) => { if (mounted.current) setState((current) => ({ ...current, index, total })); },
      });
    } catch (error) {
      logFailure(FAILURE.make, error);
      result = {};
    } finally {
      busy.current = false;
      controller.current = null;
    }
    if (!mounted.current) return;
    refocus.current = Boolean(progress.current?.contains(document.activeElement));
    const phase = savePhaseOf(result.outcome);
    if (phase === PHASE.ready) made.current = { blob: result.blob, name: result.name, exportedAt: result.exportedAt, included: result.included };
    setState({
      phase, index: 0, total: 0, counts: result.counts ?? null,
      count: phase === PHASE.ready ? result.included.length : 0, bytes: phase === PHASE.ready ? result.blob.size : 0,
    });
    // the page's own live region says how it ended (a failure is an alert of its own)
    if (phase === PHASE.ready) onAnnounce?.(readyLine(result.included.length, result.blob.size, language));
    if (phase === PHASE.stopped) onAnnounce?.(stoppedLine(language));
  }

  function save() {
    const file = made.current;
    if (!file) return;
    url.current ??= URL.createObjectURL(file.blob);
    try {
      saveFile({ url: url.current, name: file.name });
    } catch (error) {
      logFailure(FAILURE.hand, error);
      setState((current) => ({ ...current, phase: PHASE.failed }));
      return;
    }
    // when the file was made: its header's exported_at, the instant in its name
    const record = { madeAt: file.exportedAt, ids: file.included };
    writeLastChecksFile(record);
    setLastFile(record);
    setState((current) => ({ ...current, phase: PHASE.saved }));
    onAnnounce?.(savedLine(language));
  }

  const { phase, index, total, counts, count, bytes } = state;
  const making = phase === PHASE.making;
  const fileLine = phase === PHASE.ready || phase === PHASE.saved ? readyLine(count, bytes, language) : null;
  const skipped = phase === PHASE.ready || phase === PHASE.saved || phase === PHASE.empty ? skippedLines(counts, language) : [];
  return (
    <div className="space-y-2" data-testid="save-all-checks">
      {canSave && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              ref={mainButton}
              type="button"
              onClick={make}
              aria-disabled={making || undefined}
              className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft aria-disabled:opacity-50 aria-disabled:cursor-wait"
            >
              Save all checks to a file
            </button>
            <span className="font-sans text-sm text-ink-soft">One file with every check saved in this browser and the names you gave their passages, made here without sending anything. Keep it on another device or drive: if this browser deletes its checks, you can import them again.</span>
          </div>
          {making && (
            <div ref={progress} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="save-all-progress">
              <progress max={Math.max(1, total)} value={Math.min(index, total)} aria-labelledby={progressText} className="w-40 max-w-full" />
              <span id={progressText} className="font-sans text-sm text-ink-soft" {...OWNED}>
                {makingLine(index, total, language)}
              </span>
              <button type="button" onClick={() => controller.current?.abort()} className="min-h-11 border hairline rounded-sm px-4 font-medium text-ink hover:border-ink-soft">
                Stop
              </button>
            </div>
          )}
          {phase === PHASE.stopped && <p ref={outcome} tabIndex={-1} data-testid="save-all-stopped" className="font-sans text-sm text-ink focus:outline-hidden" {...OWNED}>{stoppedLine(language)}</p>}
          {fileLine && <p ref={outcome} tabIndex={-1} data-testid="save-all-ready" className="font-sans text-sm text-ink focus:outline-hidden" {...OWNED}>{fileLine}</p>}
          {(phase === PHASE.ready || phase === PHASE.saved) && (
            <button type="button" onClick={save} className="min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
              Save the file
            </button>
          )}
          {phase === PHASE.saved && (
            <p data-testid="save-all-saved" className="font-sans text-sm text-ink" {...OWNED}>{savedLine(language)}</p>
          )}
          {phase === PHASE.empty && (
            <p ref={outcome} tabIndex={-1} role="alert" className="font-sans text-sm text-verdict-exceeds focus:outline-hidden">No check saved in this browser can be put in a file.</p>
          )}
          {phase === PHASE.failed && (
            <p ref={outcome} tabIndex={-1} role="alert" className="font-sans text-sm text-verdict-exceeds focus:outline-hidden">Could not make the file. Please try again.</p>
          )}
          {skipped.length > 0 && (
            <ul data-testid="save-all-skipped" className="font-sans text-sm text-ink-soft space-y-1" {...OWNED}>
              {skipped.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </>
      )}
      {lastFile && hasLocalCheck && (
        <div data-testid="last-checks-file" className="font-sans text-sm text-ink-soft space-y-1" {...OWNED}>
          <p>{lastFileLine(lastFile.ids.length, localTime(lastFile.madeAt, language), language)}</p>
          {missing > 0 && <p>{notInLastFileLine(missing, language)}</p>}
        </div>
      )}
    </div>
  );
}
