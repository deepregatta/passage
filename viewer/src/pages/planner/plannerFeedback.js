/** Plain-language status and error wording for the planner's actions. The libs
 * that report progress and failures are shared with other pages, so their raw
 * strings are translated here, at the point they are shown. */

/** The planner actions that can be busy or fail; each shows its own status. */
export const ACTION = Object.freeze({ compute: 'compute', scan: 'scan', check: 'check', gpx: 'gpx' });

/** Where an action was started from, when it is not its usual button. */
export const SOURCE = Object.freeze({ comparison: 'comparison' });

/** What the clicked button says while its action runs. */
export const BUSY_BUTTON_LABEL = Object.freeze({
  compute: 'Computing route…',
  scan: 'Comparing departure times…',
  check: 'Checking this passage…',
});

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
};

/** Map a lib's progress string ("loading prepared data", "scanning departures 3/21")
 * to what a sailor reads. Unknown strings are shown capitalised rather than hidden. */
export function progressLabel(raw) {
  if (!raw) return null;
  if (PROGRESS[raw]) return PROGRESS[raw];
  const scanning = /^scanning departures (\d+\/\d+)$/.exec(raw);
  if (scanning) return `Comparing departure times ${scanning[1]}…`;
  if (/^reading \d+-member ensemble tiles$/.test(raw)) return PROGRESS['checking ensemble tiles'];
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}…`;
}

export const FORECAST_LOAD_FAILED = 'The forecast could not be loaded. Check your connection and try again.';

const POLARS_UNAVAILABLE = /^Boat polars are unavailable/;
const RAW_FORECAST_FAILURE = /^forecast (?:tile )?(?:fetch (?:failed|timed out)|invalid)/i;
const RAW_NETWORK_FAILURE = /^(?:TypeError: )?(?:Failed to fetch|NetworkError|Network request failed|Load failed)/i;

/**
 * A failure as the page shows it: plain wording, the original text kept as
 * `detail` for a "Technical detail" disclosure, and `polars` when switching to a
 * drawn route is the way out. Messages that are already friendly pass through.
 * @returns {{message: string, detail: string | null, polars: boolean}}
 */
export function friendlyError(raw) {
  const text = String(raw ?? '').trim() || 'Something went wrong. Please try again.';
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
export function blockReason(action, { mode, endpoints, polarId, route, speedsValid, departureIssue }) {
  if (action === ACTION.compute) {
    if (endpoints.length !== 2) return 'Mark a start and finish on the chart.';
    if (!polarId) return 'Choose your boat first';
    return departureIssue?.message ?? null;
  }
  if (!route) {
    if (mode === 'draw') return 'Mark at least two points on the chart: your start and destination.';
    return endpoints.length === 2 ? 'Compute the route first.' : 'Mark a start and finish on the chart.';
  }
  if (!speedsValid) return 'Enter a speed above zero for slow, usual and fast.';
  return departureIssue?.message ?? null;
}
