// @ts-check
// How old the prepared regional current grid is, for the planner's currents
// line. Display only: nothing here chooses a current source, changes a verdict
// or touches a Check record. "Now" is always passed in, never read here.
import { fmtAge, fmtLocalTime } from './format.js';

/** A grid fetched longer ago than this gets a caution instead of the plain line. */
export const STALE_CURRENTS_MS = 24 * 3600_000;

/** Whether a route's current summary (routingCurrentSummary) names the prepared regional grid. @param {{ source?: string } | null | undefined} currents */
export const isPreparedGrid = (currents) => currents?.source === 'prepared';

/** @param {unknown} value @returns {string | null} the value when it is a string Date can read as a time */
const asInstant = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/**
 * When a prepared current grid was fetched: its source's `fetched_at`, else its
 * own `generated_at`. Null when neither is a readable time (no time is guessed,
 * and the pointer's time is never borrowed: a carried-over grid keeps its own).
 * @param {{ source?: { fetched_at?: unknown }, generated_at?: unknown } | null | undefined} grid
 * @returns {string | null}
 */
export function gridFetchedAt(grid) {
  return asInstant(grid?.source?.fetched_at) ?? asInstant(grid?.generated_at);
}

/**
 * The planner's line for a prepared current grid: when it was fetched (local
 * time, as the rest of the planner states times) and how long ago. Past
 * STALE_CURRENTS_MS the same facts read as a caution. The age uses fmtAge, the
 * wording of every other age in the viewer ("under 1 h", "5 h", "3 days"). No
 * cause is claimed for an old grid. Null when there is no readable time.
 * @param {string | null | undefined} fetchedAt ISO instant
 * @param {number} nowMs
 * @returns {{ text: string, stale: boolean } | null}
 */
export function currentsFetchedLine(fetchedAt, nowMs) {
  if (!asInstant(fetchedAt) || !Number.isFinite(nowMs)) return null;
  const ageMs = nowMs - Date.parse(/** @type {string} */ (fetchedAt));
  const when = fmtLocalTime(fetchedAt);
  const age = fmtAge(ageMs);
  return ageMs > STALE_CURRENTS_MS
    ? { stale: true, text: `These currents were fetched ${when} local time, ${age} ago.` }
    : { stale: false, text: `Currents fetched ${when} local time, ${age} ago` };
}
