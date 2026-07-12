import {
  MemoryCacheStore,
  buildCurrentGrid,
  buildWindGrid,
  passageMaxHours,
  routeBbox,
  snapToSea,
} from '@deepweather/engine';
import { landMaskForBbox } from './landMask.js';

const gridCache = new MemoryCacheStore();
const FORECAST_HOURS = 15 * 24;

async function loadJson(url) {
  const response = await fetch(url);
  return response.ok ? response.json() : null;
}

function friendlyWindError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/too large|Antimeridian/i.test(message)) return new Error(message);
  if (/missing .*T|forecast horizon/i.test(message)) {
    return new Error('This departure is beyond the live forecast horizon');
  }
  return new Error("Couldn't fetch the live wind forecast — check your connection and try again");
}

export async function loadRoutingInputs({
  start,
  finish,
  polarId,
  departureIso,
  scanning = false,
  onProgress = () => {},
  now = Date.now,
  openMeteoOptions = {},
}) {
  const polar = await loadJson(`/data/polars/boats/${polarId}.json`).then(
    (doc) => doc ?? loadJson(`/data/config/polars/${polarId}.json`),
  );
  if (!polar) {
    throw new Error(`Boat polar “${polarId}” not found — regenerate and publish the ORC polar database`);
  }

  const bbox = routeBbox(start, finish);
  const maxHours = passageMaxHours(start, finish);
  const departureMs = Date.parse(departureIso);
  const remaining = Math.floor((now() + FORECAST_HOURS * 3600_000 - departureMs) / 3600_000);
  const hours = Math.min((scanning ? 120 : 0) + maxHours + 6, remaining);
  if (!Number.isFinite(departureMs) || hours < 12) {
    throw new Error('This departure is beyond the live forecast horizon');
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

  const options = { ...openMeteoOptions, cache: openMeteoOptions.cache ?? gridCache };
  onProgress('fetching forecast grid');
  let windGrid;
  try {
    windGrid = await buildWindGrid({ bbox, startIso: departureIso, hours, options });
  } catch (error) {
    throw friendlyWindError(error);
  }

  onProgress('fetching currents');
  const currentGrid = await buildCurrentGrid({ bbox, startIso: departureIso, hours, options });
  const notes = [windGrid.under_resolved_note, currentGrid?.under_resolved_note].filter(Boolean);
  if (!currentGrid) notes.push('Currents unavailable right now — routed on wind alone.');

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
