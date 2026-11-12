import ActionStatus from './ActionStatus.jsx';
import { ACTION, BUSY_BUTTON_LABEL, STOP_REFINE_LABEL, refineAddsText, refinedText } from './plannerFeedback.js';

/**
 * The comparison's one refinement: an explicit action, never automatic. It adds
 * departure times every 2 h within 6 h of each marked (◎) or tied (≈) time of
 * either ranking, on the very forecast and inputs of the comparison on show,
 * and they appear as a second row under their day. One refinement per
 * comparison: afterwards this says what was added.
 *
 * `reason` says why it cannot run (null when it can); `count` is how many times
 * it would add, and `bothRankings` whether the Cautious ranking's marks are among
 * those it adds around. Progress, stop and failure behave as the comparison's own.
 */
export default function RefineControl({ scan, reason, count, bothRankings, downloadLine, busy, activeAction, onRefine, onStop, status }) {
  if (scan.refined) {
    // Only the added times that were assessed: the others are counted with the unassessed departures.
    const assessed = new Set(scan.candidates.map((c) => c.departure_utc));
    const compared = scan.refined.departures.filter((departure) => assessed.has(departure)).length;
    return <p className="font-sans text-[12px] text-ink-soft max-w-[80ch]">{refinedText(compared)}</p>;
  }
  const refining = activeAction?.kind === ACTION.refine;
  // A failure or a "stopped" notice already says what to do next: the reason is not repeated under it.
  const said = status.failure?.kind === ACTION.refine || status.notice?.kind === ACTION.refine;
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onRefine}
        disabled={reason !== null || busy !== null}
        aria-describedby={downloadLine ? 'download-refine' : undefined}
        className="text-left text-event underline underline-offset-4 min-h-11 disabled:opacity-40 disabled:no-underline"
      >
        {refining ? BUSY_BUTTON_LABEL.refine : 'Refine around the least-exposure times'}
      </button>
      {reason === null && !refining && (
        <p className="font-sans text-[12px] text-ink-soft max-w-[80ch]">
          {refineAddsText(count, bothRankings)}
        </p>
      )}
      {downloadLine && <p id="download-refine" className="font-sans text-[12px] text-ink-soft">{downloadLine}</p>}
      <ActionStatus kind={ACTION.refine} {...status} />
      {refining && (
        <button type="button" onClick={onStop} className="min-h-11 px-3 border border-ink/50 rounded-sm hover:bg-white/50 font-sans text-sm">
          {STOP_REFINE_LABEL}
        </button>
      )}
      <div aria-live="polite" className="empty:hidden">
        {reason && busy === null && !said && <p className="font-sans text-[13px] text-ink-soft">{reason}</p>}
      </div>
    </div>
  );
}
