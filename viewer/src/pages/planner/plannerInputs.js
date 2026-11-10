import { localDateTimeToIso } from '../../lib/format.js';

/** Which inputs a planner result was made from, and whether it still matches.
 * Pure functions over the planner draft; the controller decides what to clear. */

/** Persist the routing inputs with each result so restored drafts can be checked too. */
export const routingInputKey = ({ endpoints, polarId, departureLocal }) => JSON.stringify([
  endpoints.map(({ lat, lng }) => [lat, lng]), polarId, localDateTimeToIso(departureLocal),
]);

/** Everything a status or error message was about: a message that outlives any of
 * these changing no longer describes the page, so it stops being shown. */
export const draftSignature = ({ mode, endpoints, waypoints, polarId, departureLocal, speeds }) =>
  JSON.stringify([mode, endpoints, waypoints, polarId, departureLocal, speeds]);

/**
 * Which of boat, departure and route points differ between a discarded result's
 * key and the current draft. Empty for a key without that provenance.
 * @returns {Array<'points' | 'boat' | 'departure'>}
 */
export function changedRoutingInputs(previousKey, draft) {
  let before;
  try { before = JSON.parse(previousKey); } catch { return []; }
  if (!Array.isArray(before) || before.length !== 3) return [];
  const now = JSON.parse(routingInputKey(draft));
  const changed = [];
  if (JSON.stringify(before[0]) !== JSON.stringify(now[0])) changed.push('points');
  if (before[1] !== now[1]) changed.push('boat');
  if (before[2] !== now[2]) changed.push('departure');
  return changed;
}

/** What to tell the sailor when a computed route was thrown away. */
export function staleRouteMessage(changed) {
  if (changed.length === 0) return null;
  if (changed.length > 1) return 'Route inputs changed — recompute the route';
  return {
    boat: 'Boat changed — recompute the route',
    departure: 'Departure changed — recompute the route',
    points: 'Route points changed — recompute the route',
  }[changed[0]];
}

const roundPoint = ({ lat, lng }) => [lat, lng];

/** What a departure comparison was run for, apart from the departure itself. */
export const scanBasis = ({ mode, endpoints, waypoints, polarId, speeds }) => JSON.stringify(
  mode === 'compute'
    ? [mode, endpoints.map(roundPoint), polarId]
    : [mode, waypoints.map(roundPoint), speeds.slow, speeds.nominal, speeds.fast],
);

/**
 * A comparison stays valid while the route inputs it was run for are unchanged
 * and the departure is the one it was anchored at or one of its candidates (picking
 * a time from the grid is how the sailor moves along it). A comparison saved
 * without a basis predates this check and is left alone.
 */
export function scanIsCurrent(scan, draft) {
  if (!scan?.basis) return true;
  if (scan.basis !== scanBasis(draft)) return false;
  const departureMs = Date.parse(localDateTimeToIso(draft.departureLocal) ?? '');
  if (!Number.isFinite(departureMs)) return false;
  return departureMs === scan.anchorMs
    || (scan.candidates ?? []).some((candidate) => Date.parse(candidate.departure_utc) === departureMs);
}
