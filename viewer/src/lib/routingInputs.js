import { forecastRunGone, passageMaxHours, polarFromRelease, routeBbox, snapToSea } from '@deepweather/engine';
import { landMaskForBbox } from './landMask.js';
import { forecastStore, friendlyForecastError } from './forecastStore.js';

/** deterministic tile horizon (GFS 240 h); scans beyond it fail with a clear message */
export const FORECAST_HOURS = 240;

const POLARS_UNAVAILABLE = 'Boat polars are unavailable right now. Use Draw my route instead.';

/** One boat's polar, read at request time from /api/polars/<id> (a Pages
 * Function over the pinned deep-polars release); this site never ships polar
 * files. The engine converts the release entry to the router's shape. */
async function loadPolar(polarId) {
  let response;
  try {
    response = await fetch(`/api/polars/${encodeURIComponent(polarId)}`);
  } catch (error) {
    throw new Error(POLARS_UNAVAILABLE, { cause: error });
  }
  if (response.status === 429) throw new Error('Too many boat polar requests. Wait a minute and try again.');
  if (response.status === 404) throw new Error('This boat is no longer in the polar list. Choose your boat again.');
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return polarFromRelease(await response.json());
  } catch (error) {
    throw new Error(POLARS_UNAVAILABLE, { cause: error });
  }
}

export async function loadRoutingInputs({
  start,
  finish,
  polarId,
  departureIso,
  scanning = false,
  onProgress = () => {},
  now = Date.now,
  store = forecastStore(),
}) {
  const polar = await loadPolar(polarId);

  const bbox = routeBbox(start, finish);
  const maxHours = passageMaxHours(start, finish);
  const departureMs = Date.parse(departureIso);
  const remaining = Math.floor((now() + FORECAST_HOURS * 3600_000 - departureMs) / 3600_000);
  const hours = Math.min((scanning ? 120 : 0) + maxHours + 6, remaining);
  if (!Number.isFinite(departureMs) || hours < 12) {
    throw new Error('This departure is beyond the forecast horizon');
  }

  onProgress('loading coastline');
  let landMask;
  try {
    landMask = await landMaskForBbox(bbox);
  } catch (error) {
    throw new Error(
      error instanceof Error && /coastline|decompress/i.test(error.message)
        ? error.message
        : "Couldn't load the coastline data needed for safe routing",
      { cause: error },
    );
  }
  const snappedStart = snapToSea(landMask, start);
  const snappedFinish = snapToSea(landMask, finish);
  if (!snappedStart || !snappedFinish) {
    throw new Error('Click a point in open water near both ends of the passage');
  }

  onProgress('loading forecast tiles');
  let windGrid;
  try {
    windGrid = await store.getWindGrid(bbox, departureIso, hours);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // a deleted run: withFreshForecast refreshes and retries
    if (/Antimeridian|too large/i.test(message) || forecastRunGone(error)) throw error;
    throw friendlyForecastError(error);
  }

  onProgress('loading current tiles');
  const currentGrid = await store.getCurrentGrid(bbox, departureIso, hours).catch((error) => {
    if (forecastRunGone(error)) throw error;
    return null;
  });
  const notes = [windGrid.under_resolved_note, currentGrid?.under_resolved_note].filter(Boolean);
  if (!currentGrid) notes.push('Currents unavailable right now. This route uses wind alone.');

  return {
    polar,
    windGrid,
    currentGrid,
    landMask,
    maxHours,
    start: { ...start, ...snappedStart },
    finish: { ...finish, ...snappedFinish },
    notes,
  };
}
