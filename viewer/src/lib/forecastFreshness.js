/**
 * Keeps the page's pinned forecast runs fresh between user actions
 * (docs/grib-export-plan.md, Phase 5A). forecast-tiles keeps only the current
 * and previous run of each layer, so once it publishes every provider cycle a
 * run is deleted about 12 h after it is superseded, and a page left open
 * would read runs that no longer exist.
 *
 * - At the start of each action (check a passage, compare departures, compute
 *   a route, prepare a GRIB file) the store re-reads latest.json when its last
 *   check is more than 10 minutes old, and swaps in the layers that changed.
 * - Never during an action: while one runs, another starting meanwhile shares
 *   its runs, so no action ever reads two runs of a layer.
 * - When a tile of a deleted run answers 404, the store refreshes once and the
 *   action is retried if the run was replaced. Otherwise the action fails with
 *   "The forecast has been updated. Try again."
 */

import { FORECAST_UPDATED_MESSAGE, forecastRunGone } from '@deepweather/engine';
import { forecastStore } from './forecastStore.js';

export const FORECAST_CHECK_MS = 10 * 60_000;

let activeActions = 0;

export class ForecastUpdatedError extends Error {
  code = 'forecast-updated';
  constructor(options) {
    super(FORECAST_UPDATED_MESSAGE, options);
    this.name = 'ForecastUpdatedError';
  }
}

/** A tile store that can re-read latest.json (a scenario store cannot). */
const canRefresh = (store) => typeof store?.refresh === 'function' && typeof store.lastCheckedMs === 'function';

function isStale(store, now) {
  if (activeActions > 0 || !canRefresh(store)) return false;
  const checked = store.lastCheckedMs();
  return checked === null || now() - checked > FORECAST_CHECK_MS;
}

async function refresh(store) {
  try {
    return await store.refresh();
  } catch (error) {
    // Offline, the pinned runs (and the tile cache) keep serving.
    console.warn('forecast refresh failed; keeping the pinned runs', error);
    return [];
  }
}

/**
 * Re-read latest.json when the last check is older than FORECAST_CHECK_MS and
 * no action is running. Resolves to the layers whose run changed.
 */
export async function refreshForecastIfStale({ store = forecastStore(), now = Date.now } = {}) {
  return isStale(store, now) ? refresh(store) : [];
}

/** A deleted run, or a GRIB plan made on runs the store has since replaced. */
function runReplaced(error) {
  return Boolean(forecastRunGone(error)) || error?.code === 'forecast-updated';
}

/**
 * Run a user action that reads forecast tiles, on fresh runs. The action
 * receives `{ changed }`: the layers whose run was swapped just before it, so
 * a page that planned on the old runs can plan again.
 */
export async function withFreshForecast(action, { store = forecastStore(), now = Date.now } = {}) {
  // Decided synchronously, so an action starting in the same tick as another
  // sees it running. Actions that start during a refresh share it.
  let changed = isStale(store, now) ? await refresh(store) : [];
  for (let attempt = 0; ; attempt++) {
    activeActions += 1;
    let failure;
    try {
      return await action({ changed });
    } catch (error) {
      failure = error;
    } finally {
      activeActions -= 1;
    }
    if (!runReplaced(failure)) throw failure;
    if (attempt > 0 || activeActions > 0 || !canRefresh(store)) throw new ForecastUpdatedError({ cause: failure });
    changed = await store.refresh().catch(() => []);
    const gone = forecastRunGone(failure);
    const replaced = gone ? store.manifestFor(gone.layer)?.run_id !== gone.runId : changed.length > 0;
    if (!replaced) throw new ForecastUpdatedError({ cause: failure });
  }
}
