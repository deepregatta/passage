import { ACTION, progressLabel } from './plannerFeedback.js';

/**
 * Progress, result and failure of one planner action, shown directly under the
 * control that started it. Place one under each action button; each shows only
 * what concerns its own action.
 *
 * - progress and "Route updated" style results are announced politely
 * - a failure is an alert with Retry, a way out for unavailable boat polars and
 *   the raw message kept under "Technical detail"
 *
 * `source` separates two controls that start the same action (the Check button
 * and a time picked from the departure comparison).
 */
export default function ActionStatus({
  kind, source = null, activeAction, busy, failure, notice, onRetry, onSwitchToDraw,
}) {
  const same = (item) => item?.kind === kind && (item.source ?? null) === source;
  const running = same(activeAction);
  const text = running ? progressLabel(busy) : same(notice) ? notice.text : null;
  const failed = same(failure) ? failure : null;
  return (
    <>
      <p aria-live="polite" className="text-[12px] text-ink-soft empty:hidden">{text}</p>
      {failed && (
        <div className="space-y-2">
          <p role="alert" className="text-[13px] text-verdict-exceeds">{failed.message}</p>
          {failed.detail && (
            <details className="text-[12px] text-ink-soft">
              <summary className="cursor-pointer min-h-11 flex items-center">Technical detail</summary>
              <p className="font-mono break-words">{failed.detail}</p>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onRetry} className="min-h-11 px-3 border border-ink/50 rounded-sm hover:bg-white/50">
              {kind === ACTION.gpx ? 'Choose another file' : 'Retry'}
            </button>
            {failed.polars && (
              <button type="button" onClick={onSwitchToDraw} className="min-h-11 px-3 border border-ink/50 rounded-sm hover:bg-white/50">
                Switch to Draw my route
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
