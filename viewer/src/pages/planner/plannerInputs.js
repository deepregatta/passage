import { localDateTimeToIso } from '../../lib/format.js';

/** Which inputs a planner result was made from, and whether it still matches.
 * Pure functions over the planner draft; the controller decides what to clear. */

export const POLAR_PERCENT_MIN = 50;
export const POLAR_PERCENT_MAX = 120;
/** A whole percent from 50 to 120; anything else (empty, fractional, out of range) never reaches the router. */
export const validPolarPercent = (value) => Number.isInteger(value) && value >= POLAR_PERCENT_MIN && value <= POLAR_PERCENT_MAX;

/** Persist the routing inputs with each result so restored drafts can be checked too.
 * The percentage is a fourth element only when it is not 100: a key stored before it
 * existed (three elements) is the key of a 100 % route, and still compares equal. */
export const routingInputKey = ({ endpoints, polarId, departureLocal, polarPercent = 100 }) => JSON.stringify([
  endpoints.map(({ lat, lng }) => [lat, lng]), polarId, localDateTimeToIso(departureLocal),
  ...(polarPercent === 100 ? [] : [polarPercent]),
]);

/** Everything a status or error message was about: a message that outlives any of
 * these changing no longer describes the page, so it stops being shown. */
export const draftSignature = ({ mode, endpoints, waypoints, polarId, departureLocal, speeds, polarPercent = 100 }) =>
  JSON.stringify([mode, endpoints, waypoints, polarId, departureLocal, speeds, polarPercent]);

/** The percentage a key records: a three-element key was made at 100. */
const percentOfKey = (key) => (key.length === 4 ? key[3] : 100);

/**
 * Which of boat, boat speed, departure and route points differ between a discarded
 * result's key and the current draft. Empty for a key without that provenance.
 * @returns {Array<'points' | 'boat' | 'speed' | 'departure'>}
 */
export function changedRoutingInputs(previousKey, draft) {
  let before;
  try { before = JSON.parse(previousKey); } catch { return []; }
  if (!Array.isArray(before) || (before.length !== 3 && before.length !== 4)) return [];
  const now = JSON.parse(routingInputKey(draft));
  const changed = [];
  if (JSON.stringify(before[0]) !== JSON.stringify(now[0])) changed.push('points');
  if (before[1] !== now[1]) changed.push('boat');
  if (percentOfKey(before) !== percentOfKey(now)) changed.push('speed');
  if (before[2] !== now[2]) changed.push('departure');
  return changed;
}

/** What a computed route says about the boat speed it was routed with, read from its
 * own provenance so a saved or restored route shows what it was computed with.
 * Nothing at 100 % or when the route does not record it. */
export function polarPercentNote(route) {
  const scaling = route?.provenance?.routing_request?.polar_scaling;
  if (!Number.isFinite(scaling)) return null;
  const percent = Math.round(scaling * 100);
  return percent === 100 ? null : `Routed at ${percent}% of the boat polar speeds`;
}

/** What to tell the sailor when a computed route was thrown away. */
export function staleRouteMessage(changed) {
  if (changed.length === 0) return null;
  if (changed.length > 1) return 'Route inputs changed — recompute the route';
  return {
    boat: 'Boat changed — recompute the route',
    speed: 'Boat speed changed — recompute the route',
    departure: 'Departure changed — recompute the route',
    points: 'Route points changed — recompute the route',
  }[changed[0]];
}

const roundPoint = ({ lat, lng }) => [lat, lng];

/** What a departure comparison was run for, apart from the departure itself. */
export const scanBasis = ({ mode, endpoints, waypoints, polarId, speeds, polarPercent = 100 }) => JSON.stringify(
  mode === 'compute'
    ? [mode, endpoints.map(roundPoint), polarId, polarPercent]
    : [mode, waypoints.map(roundPoint), speeds.slow, speeds.nominal, speeds.fast],
);

/**
 * A comparison stays valid while the route inputs it was run for are unchanged
 * and the departure is the one it was anchored at or one of its candidates (picking
 * a time from the grid is how the sailor moves along it) and the sailor's limits are
 * the ones it was ranked against. A comparison saved without a basis predates this
 * check and is left alone, as is one whose limits revision is unknown on either side
 * (a comparison from before it was recorded, limits not loaded yet).
 */
export function scanIsCurrent(scan, draft) {
  if (!scan?.basis) return true;
  if (scan.basis !== scanBasis(draft)) return false;
  if (scan.profileRevision && draft.profileRevision && scan.profileRevision !== draft.profileRevision) return false;
  const departureMs = Date.parse(localDateTimeToIso(draft.departureLocal) ?? '');
  if (!Number.isFinite(departureMs)) return false;
  return departureMs === scan.anchorMs
    || (scan.candidates ?? []).some((candidate) => Date.parse(candidate.departure_utc) === departureMs);
}
