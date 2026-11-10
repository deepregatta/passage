import { placeLabel } from '../../lib/format.js';

// Kept in JSX so the viewer translation scanner covers these shared labels.

const legNumber = (legId) => {
  const match = /^L(\d+)$/.exec(legId ?? '');
  return match ? Number(match[1]) : null;
};

const parenthesised = (text) => `(${text})`;

const shortName = (name) => placeLabel(name.split('→')[1]?.trim().split(',')[0] ?? name.slice(0, 24));

/** "near Plymouth breakwater": where a leg ends, for sentences like "limit near …". */
export const legPlace = (findings, legId) => {
  const leg = findings.legs.find((l) => l.leg_id === legId);
  return leg ? `near ${shortName(leg.name)}` : legId;
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
  if (!leg) return number === null ? String(legId ?? '') : `leg ${number}`;
  const place = bare ? shortName(leg.name) : legPlace(findings, legId);
  return number === null ? place : `${place} ${parenthesised(`leg ${number}`)}`;
};

export function routeTitle(findings) {
  const first = findings.legs[0];
  const last = findings.legs[findings.legs.length - 1];
  const from = placeLabel(first?.name.split('→')[0]?.trim().split(',')[0] ?? findings.route_id);
  const to = placeLabel(last?.name.split('→')[1]?.trim().split(',')[0] ?? '');
  return to ? `${from} → ${to}` : from;
}
