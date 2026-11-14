/** Plain-language status and error wording for the planner's actions. The libs
 * that report progress and failures are shared with other pages, so their raw
 * strings are translated here, at the point they are shown. */

/** The planner actions that can be busy or fail; each shows its own status. */
export const ACTION = Object.freeze({ compute: 'compute', scan: 'scan', refine: 'refine', check: 'check', gpx: 'gpx' });

/** Where an action was started from, when it is not its usual button. */
export const SOURCE = Object.freeze({ comparison: 'comparison' });

/** What the clicked button says while its action runs. */
export const BUSY_BUTTON_LABEL = Object.freeze({
  compute: 'Computing route…',
  scan: 'Comparing departure times…',
  refine: 'Refining…',
  check: 'Checking this passage…',
});

/** The control that stops a running departure comparison. */
export const STOP_SCAN_LABEL = 'Stop comparing';
/** The control that stops a running refinement of the comparison. */
export const STOP_REFINE_LABEL = 'Stop refining';

/**
 * What the refine action will do, before it runs: `count` departure times it adds
 * around the ◎ and ≈ times, of both rankings when `bothRankings` (the Cautious one
 * has scenario evidence to rank on), else of the Typical ranking alone.
 */
export const refineAddsText = (count, bothRankings = false) =>
  `Adds ${count} departure ${count === 1 ? 'time' : 'times'}, every 2 h within 6 h of each ◎ or ≈ time${bothRankings ? ' in either ranking' : ''}, from the same forecast as this comparison.`;

/** When no added time could be assessed: no second row exists, and the times are listed as unassessed. */
export const REFINED_NONE = 'Refined: none of the added departure times could be assessed. They are listed under Unassessed departures.';

/** What a refinement did: `count` added departure times that were assessed (the others are listed as unassessed). */
export const refinedText = (count) => (count === 0 ? REFINED_NONE
  : `Refined: ${count} more departure ${count === 1 ? 'time' : 'times'} compared, every 2 h around the ◎ and ≈ times. They are in a second row under their day.`);

const PROGRESS = {
  starting: 'Starting…',
  'computing route': 'Finding the best route…',
  'loading coastline': 'Loading the coastline…',
  'loading forecast tiles': 'Loading the forecast…',
  'loading current tiles': 'Loading ocean currents…',
  'loading prepared data': 'Loading the forecast charts…',
  'reading forecast run manifest': 'Loading the forecast…',
  'reading deterministic forecast tiles': 'Reading the wind forecast…',
  'checking ensemble tiles': 'Reading the ensemble forecast…',
  'reading wave tiles': 'Reading the wave forecast…',
  'reading hazard and model-comparison tiles': 'Reading the wind and hazard data…',
  'reading current tiles': 'Reading ocean currents…',
  'evaluating against your limits': 'Comparing with your limits…',
  'saving immutable snapshot': 'Saving your check…',
  'scanning departures': 'Comparing departure times…',
  'refining departures': 'Refining the comparison…',
};

/** Map a lib's progress string ("loading prepared data", "scanning departures 3/21")
 * to what a sailor reads. Unknown strings are shown capitalised rather than hidden. */
export function progressLabel(raw) {
  if (!raw) return null;
  if (PROGRESS[raw]) return PROGRESS[raw];
  const scanning = /^scanning departures (\d+\/\d+)$/.exec(raw);
  if (scanning) return `Comparing departure times ${scanning[1]}…`;
  const routing = /^routing departures (\d+\/\d+)$/.exec(raw);
  if (routing) return `Routing departures ${routing[1]}…`;
  if (/^reading \d+-member ensemble tiles$/.test(raw)) return PROGRESS['checking ensemble tiles'];
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}…`;
}

export const FORECAST_LOAD_FAILED = 'The forecast could not be loaded. Check your connection and try again.';

/** A Check whose save failed stored nothing new (the save is all or nothing); `saveFailure` says why. */
export const SAVE_FAILED = Object.freeze({
  'storage-full': 'This check was not saved: this browser’s storage for this site is full, so nothing was stored. To free space, delete saved checks you no longer need in My passages.',
  // write-once: records for this exact check exist and cannot be reopened (unfinished, legacy,
  // conflicting, or unreadable just now); a new forecast run or another route, departure or limits gives a new check
  blocked: 'This check could not be saved: this browser already holds an earlier save of the same check that cannot be reopened, and saved checks are never overwritten. Nothing new was stored. A check on a newer forecast, or after a change to the route, departure or limits, can be saved normally.',
  failed: 'This check was not saved in this browser, and nothing was stored.',
});

const POLARS_UNAVAILABLE = /^Boat polars are unavailable/;
const RAW_FORECAST_FAILURE = /^forecast (?:tile )?(?:fetch (?:failed|timed out)|invalid)/i;
const RAW_NETWORK_FAILURE = /^(?:TypeError: )?(?:Failed to fetch|NetworkError|Network request failed|Load failed)/i;

/**
 * A failure as the page shows it: plain wording, the original text kept as
 * `detail` for a "Technical detail" disclosure, and `polars` when switching to a
 * drawn route is the way out. Messages that are already friendly pass through.
 * A failed save (`saveFailure` from browserAnalysis: 'storage-full', 'blocked' or 'failed')
 * always gets its plain sentence; the browser's own text stays the detail.
 * @param {unknown} raw
 * @param {string | null} [saveFailure]
 * @returns {{message: string, detail: string | null, polars: boolean}}
 */
export function friendlyError(raw, saveFailure = null) {
  const text = String(raw ?? '').trim() || 'Something went wrong. Please try again.';
  if (saveFailure) {
    return { message: SAVE_FAILED[saveFailure] ?? SAVE_FAILED.failed, detail: String(raw ?? '').trim() || null, polars: false };
  }
  if (POLARS_UNAVAILABLE.test(text)) return { message: text, detail: null, polars: true };
  if (RAW_FORECAST_FAILURE.test(text) || RAW_NETWORK_FAILURE.test(text)) {
    return { message: FORECAST_LOAD_FAILED, detail: text, polars: false };
  }
  return { message: text, detail: null, polars: false };
}

/**
 * Why a planner action cannot run yet, or null when it can. Order matters: the
 * first missing thing is the one to do next.
 * @param {'compute' | 'scan' | 'check'} action
 */
export function blockReason(action, { mode, endpoints, polarId, route, speedsValid, departureIssue, polarPercentValid = true }) {
  if (action === ACTION.compute) {
    if (endpoints.length !== 2) return 'Mark a start and finish on the chart.';
    if (!polarId) return 'Choose your boat first';
    if (!polarPercentValid) return 'Enter a percent of polar from 50 to 120.';
    return departureIssue?.message ?? null;
  }
  if (!route) {
    if (mode === 'draw') return 'Mark at least two points on the chart: your start and destination.';
    return endpoints.length === 2 ? 'Compute the route first.' : 'Mark a start and finish on the chart.';
  }
  if (!speedsValid) return 'Enter a speed above zero for slow, usual and fast.';
  return departureIssue?.message ?? null;
}

/**
 * One line over the map saying where the sailor is in setting up the route.
 * @returns {string}
 */
export function mapHint({ mode, endpoints, waypoints, computed, distance }) {
  if (mode === 'compute') {
    if (computed) return `Route computed · ${computed.distance_nm} nm · ${computed.duration_h} h`;
    if (endpoints.length === 0) return 'Mark your start on the chart';
    if (endpoints.length === 1) return 'Start set — now mark the finish';
    return 'Start and finish set — compute the route';
  }
  if (waypoints.length === 0) return 'Add your start on the chart';
  if (waypoints.length === 1) return 'Start set — add the next point';
  return `${waypoints.length} waypoints${distance === null ? '' : ` · ${distance} nm`}`;
}

/** The short status in the phone action bar: what stops the action, what it is doing, or what is ready. */
export function barStatus({ failure, busy, blocked, mode, computed, waypoints, distance }) {
  // The reason is written out under the button that failed; this is only the pointer to it.
  if (failure) return 'That did not finish — try again, or see the message in the form';
  if (busy) return progressLabel(busy);
  if (blocked) return blocked;
  if (mode === 'compute' && computed) return `Route ready: ${computed.distance_nm} nm · ${computed.duration_h} h`;
  if (mode === 'draw' && distance !== null) return `${waypoints.length} waypoints · ${distance} nm`;
  return null;
}

/** Bring a result into view and move focus to it; no animation when the sailor asks for less motion. */
export function revealElement(element) {
  if (!element) return;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  element.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  element.focus({ preventScroll: true });
}
