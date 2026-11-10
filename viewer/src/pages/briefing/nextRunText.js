import { describeNextRun } from '@deepweather/engine';
import { fmtTextClock, fmtTextTime } from '../../lib/format.js';

/**
 * The next forecast run as one sentence, read at display time (`nowMs`), in the
 * header zone. An estimate within a few minutes reads "due now"; a passed one
 * "late; no estimate", never a past clock time.
 * @param {any} briefing
 * @param {number} nowMs
 */
export function nextRunText(briefing, nowMs) {
  const runs = briefing?.next_runs?.length ? briefing.next_runs : briefing?.next_run ?? null;
  const next = describeNextRun(runs, new Date(nowMs).toISOString());
  if (next.kind === 'none') return { kind: 'none', text: 'No estimate for the next run. Check the published forecast before departure.' };
  const run = `Next ${next.model_name} run${next.cycle ? ` (${next.cycle})` : ''}`;
  if (next.kind === 'due') return { kind: 'due', text: `${run} is due now.` };
  if (next.kind === 'overdue') return { kind: 'overdue', text: `${run} is late; no estimate.` };
  const sameDay = new Date(next.expected_at).toDateString() === new Date(nowMs).toDateString();
  return { kind: 'future', text: `${run} expected about ${sameDay ? fmtTextClock(next.expected_at) : fmtTextTime(next.expected_at)}.` };
}
