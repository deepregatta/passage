import { cleanPassageName } from '@deepweather/engine';
import { placeLabel } from '../../lib/format.js';

// Kept in JSX so the viewer translation scanner covers these shared labels.

const legNumber = (legId) => {
  const match = /^L(\d+)$/.exec(legId ?? '');
  return match ? Number(match[1]) : null;
};

const parenthesised = (text) => `(${text})`;

/** Where a leg ends, from its name (check content): shown as a name, so cleaned by the one rule; '' when nothing is left. */
const shortName = (name) => {
  const text = cleanPassageName(name); // '' for anything that is not text
  return cleanPassageName(placeLabel(text.split('→')[1]?.trim().split(',')[0] ?? text.slice(0, 24)));
};

/** "near Plymouth breakwater": where a leg ends, for sentences like "limit near …". */
export const legPlace = (findings, legId) => {
  const leg = findings.legs.find((l) => l.leg_id === legId);
  const place = leg ? shortName(leg.name) : '';
  return place ? `near ${place}` : legId;
};

/**
 * The one way prose names a leg: place first, then the leg number in
 * parentheses ("near Plymouth breakwater (leg 6)"; `bare` drops "near":
 * "Plymouth breakwater (leg 6)"). Never the raw "L6" id. Use it at the first
 * mention on a surface; later mentions can use legPlace.
 */
export const legLabel = (findings, legId, { bare = false } = {}) => {
  const leg = findings.legs.find((l) => l.leg_id === legId);
  const number = legNumber(legId);
  const named = leg ? shortName(leg.name) : '';
  if (!named) return number === null ? String(legId ?? '') : `leg ${number}`;
  const place = bare ? named : legPlace(findings, legId);
  return number === null ? place : `${place} ${parenthesised(`leg ${number}`)}`;
};

/** The passage's title from its legs (check content): cleaned as any shown name is (engine cleanPassageName). */
export function routeTitle(findings) {
  const first = findings.legs[0];
  const last = findings.legs[findings.legs.length - 1];
  const from = placeLabel(first?.name.split('→')[0]?.trim().split(',')[0] ?? findings.route_id);
  const to = placeLabel(last?.name.split('→')[1]?.trim().split(',')[0] ?? '');
  return cleanPassageName(to ? `${from} → ${to}` : from);
}
