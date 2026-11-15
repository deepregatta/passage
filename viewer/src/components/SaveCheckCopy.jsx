import { useRef, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { COPY, canSaveCheckFile, saveCheckFile, savableCheck } from '../lib/checkFile.js';

/**
 * "Save a copy to a file" beside "Share this check" (2026-11-15): one
 * browser-saved check with a v2 identity, as one gzip file the browser saves
 * with its downloads. Not offered for a served check or the example, a legacy
 * check, while nothing is open, or in a browser without CompressionStream
 * (never an uncompressed file instead). No analytics event.
 *
 * Each check keeps its own outcome, so a save still running for one check
 * never changes another's button, and one check is never saved twice at once.
 * While saving, the button stays focusable (aria-disabled, not disabled) and
 * the live region below it is always present, so the outcome is announced.
 */
export default function SaveCheckCopy({ className }) {
  const snapshotId = useApp((state) => state.snapshotId);
  const snapshotSource = useApp((state) => state.snapshotSource);
  const findings = useApp((state) => state.findings);
  const ready = useApp((state) => !state.loading && !state.loadError && Boolean(state.findings && state.briefing));
  // snapshot id → its last outcome (lib/checkFile.js COPY)
  const [outcomes, setOutcomes] = useState({});
  const inFlight = useRef(new Set());
  const status = Object.hasOwn(outcomes, snapshotId) ? outcomes[snapshotId] : COPY.idle;

  if (!ready || !canSaveCheckFile() || !savableCheck({ snapshotId, snapshotSource, findings })) return null;

  async function save() {
    const id = snapshotId;
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setOutcomes((current) => ({ ...current, [id]: COPY.saving }));
    try {
      const outcome = await saveCheckFile(id);
      setOutcomes((current) => ({ ...current, [id]: outcome }));
    } finally {
      inFlight.current.delete(id);
    }
  }

  const saving = status === COPY.saving;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" onClick={save} aria-disabled={saving || undefined} className={className}>
        {saving ? 'Saving a copy…' : 'Save a copy to a file'}
      </button>
      <span role="status" className="font-instrument text-xs text-ink-soft max-w-[72ch]">
        {status === COPY.made ? 'Copy made. Your browser saves it with its downloads: one file with the route, the departure time, your limits, the boat reference and the forecast data this check used. Nothing is sent anywhere.' : ''}
      </span>
      {status === COPY.unreadable && (
        <span role="alert" className="font-instrument text-xs text-event">This copy was not saved: this browser could not read every file of the check.</span>
      )}
      {status === COPY.damaged && (
        <span role="alert" className="font-instrument text-xs text-event">This copy was not saved: the check stored in this browser is damaged.</span>
      )}
      {status === COPY.polar && (
        <span role="alert" className="font-instrument text-xs text-event">This copy was not saved: the check holds boat polar data, which Passage never puts in a file.</span>
      )}
      {status === COPY.failed && (
        <span role="alert" className="font-instrument text-xs text-event">Could not save the copy. Please try again.</span>
      )}
    </span>
  );
}
