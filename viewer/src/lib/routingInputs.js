import { passageMaxHours, routeBbox, snapToSea } from '@deepweather/engine';
import { landMaskForBbox } from './landMask.js';
import { forecastStore, friendlyForecastError } from './forecastStore.js';

/** deterministic tile horizon (GFS 240 h); scans beyond it fail with a clear message */
const FORECAST_HOURS = 240;

async function loadJson(url) {
  const response = await fetch(url);
  return response.ok ? response.json() : null;
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
  const polar = await loadJson(`/data/polars/boats/${polarId}.json`).then(
    (doc) => doc ?? loadJson(`/data/config/polars/${polarId}.json`),
  );
  if (!polar) {
    throw new Error(`Boat polar “${polarId}” not found. Regenerate and publish the ORC polar database.`);
  }

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
    if (/Antimeridian|too large/i.test(message)) throw error;
    throw friendlyForecastError(error);
  }

  onProgress('loading current tiles');
  const currentGrid = await store.getCurrentGrid(bbox, departureIso, hours).catch(() => null);
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
