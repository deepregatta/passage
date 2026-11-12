import { forecastRunGone, passageMaxHours, polarFromRelease, routeBbox, snapToSea } from '@deepweather/engine';
import { landMaskForBbox } from './landMask.js';
import { forecastStore, friendlyForecastError } from './forecastStore.js';
import { preparedRun } from './preparedRun.js';
import { loadPreparedCurrent } from './preparedCurrent.js';

/** deterministic tile horizon (GFS 240 h); scans beyond it fail with a clear message */
export const FORECAST_HOURS = 240;
/** A routed departure needs at least this many forecast hours after it. */
export const ROUTING_MIN_HOURS = 12;

const CURRENTS_UNAVAILABLE = 'Currents unavailable right now. This route uses wind alone.';

/**
 * What a route result says about its inputs, for the current source the
 * route was computed on. A prepared grid's factory note is not shown here: the
 * Check records that grid, and its model is named in the briefing.
 * @param {{ under_resolved_note?: string | null } | null | undefined} windGrid
 * @param {{ under_resolved_note?: string | null } | null | undefined} currentGrid
 * @param {string} [currentSource]
 */
export function routingNotes(windGrid, currentGrid, currentSource = 'tiles') {
  if (currentSource === 'prepared') return [windGrid?.under_resolved_note].filter(Boolean);
  const notes = [windGrid?.under_resolved_note, currentGrid?.under_resolved_note].filter(Boolean);
  if (!currentGrid) notes.push(CURRENTS_UNAVAILABLE);
  return notes;
}

/**
 * The notes of a route computed on the current input a selection chose: the
 * loader's own notes for tiles, the wind note alone for a prepared grid.
 * @param {{ windGrid?: { under_resolved_note?: string | null }, notes?: string[] }} inputs
 * @param {{ provenance?: Record<string, unknown> }} currentInput
 */
export function selectedRoutingNotes(inputs, currentInput) {
  return currentInput.provenance?.current_source === 'prepared'
    ? routingNotes(inputs.windGrid, null, 'prepared') : inputs.notes;
}

/** The tile currents layer carries Copernicus GLO12 (briefing.ts publication schedule). */
const TILE_CURRENTS_MODEL = 'cmems_glo12';

/**
 * What a computed route records about the current grid it was routed on, for
 * the line under the route result: the model id (named with `modelName`, as
 * in the briefing's Models and coverage panel), an emulated flag, and which
 * fixed caveat a prepared grid's resolution note calls for. Null when the
 * route was computed without currents.
 * @param {{ grid?: any, provenance?: Record<string, any> }} currentInput
 * @returns {{ source: string, model: string, emulated: boolean, caveat: 'subsampled' | 'coarse' | null } | null}
 */
export function routingCurrentSummary(currentInput) {
  const grid = currentInput?.grid;
  if (!grid) return null;
  const record = currentInput.provenance ?? {};
  const source = record.current_source === 'prepared' ? 'prepared' : 'tiles';
  const dataset = grid.source?.dataset_id;
  const model = source === 'prepared'
    ? record.model ?? dataset ?? 'currents'
    : /^(\S+) tiles \(/.exec(dataset ?? '')?.[1] ?? TILE_CURRENTS_MODEL;
  const note = source === 'prepared' ? grid.under_resolved_note : null;
  return {
    source, model,
    emulated: grid.source?.mode === 'synthetic' || record.source_kind === 'emulated',
    // The factory note is English free text: the result shows a fixed, translated sentence instead.
    caveat: !note ? null : /^stride-subsampled/i.test(note) ? 'subsampled' : 'coarse',
  };
}

/**
 * One departure's routing outcome from a selection: its result, or the error
 * routing it threw. A departure the selection never routed fails cleanly.
 * @template T
 * @param {Map<string, { result?: T, error?: unknown }>} results
 * @param {string} departureUtc
 * @returns {T}
 */
export function routedOutcome(results, departureUtc) {
  const outcome = results.get(departureUtc);
  if (!outcome) throw new Error('This departure could not be routed.');
  if (!outcome.result) throw outcome.error;
  return outcome.result;
}

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
  // Compute reads the prepared current grid here; a scan uses its action's.
  prepared = false,
}) {
  const polar = await loadPolar(polarId);

  const bbox = routeBbox(start, finish);
  const maxHours = passageMaxHours(start, finish);
  const departureMs = Date.parse(departureIso);
  const remaining = Math.floor((now() + FORECAST_HOURS * 3600_000 - departureMs) / 3600_000);
  const hours = Math.min((scanning ? 120 : 0) + maxHours + 6, remaining);
  if (!Number.isFinite(departureMs) || hours < ROUTING_MIN_HOURS) {
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
  const notes = routingNotes(windGrid, currentGrid);

  let preparedCurrent;
  if (prepared) {
    onProgress('loading prepared data');
    preparedCurrent = await loadPreparedCurrent((await preparedRun({ refresh: true })).doc);
  }

  return {
    polar,
    windGrid,
    currentGrid,
    landMask,
    maxHours,
    ...(preparedCurrent ? { preparedCurrent } : {}),
    start: { ...start, ...snappedStart },
    finish: { ...finish, ...snappedFinish },
    notes,
  };
}
