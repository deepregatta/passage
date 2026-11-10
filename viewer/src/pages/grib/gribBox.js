// The GRIB box's corners and edges, for the keyboard and the typed fields.
// Every result goes through gribArea, so it snaps like a drawn box.
import { gribArea } from '../../lib/gribExport.js';

/** Arrow keys move a focused corner this far; Shift + arrow, the big step. */
export const GRIB_NUDGE_DEG = 0.1;
export const GRIB_NUDGE_BIG_DEG = 1;

/** The four corners, each with the opposite one that stays put while it moves. */
export const GRIB_CORNERS = [
  { id: 'nw', label: 'Move north-west corner', at: (a) => ({ lat: a.maxLat, lon: a.minLon }), opposite: (a) => ({ lat: a.minLat, lon: a.maxLon }) },
  { id: 'ne', label: 'Move north-east corner', at: (a) => ({ lat: a.maxLat, lon: a.maxLon }), opposite: (a) => ({ lat: a.minLat, lon: a.minLon }) },
  { id: 'se', label: 'Move south-east corner', at: (a) => ({ lat: a.minLat, lon: a.maxLon }), opposite: (a) => ({ lat: a.maxLat, lon: a.minLon }) },
  { id: 'sw', label: 'Move south-west corner', at: (a) => ({ lat: a.minLat, lon: a.minLon }), opposite: (a) => ({ lat: a.maxLat, lon: a.maxLon }) },
];

const MOVES = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

/** The box after an arrow key on one corner, or null for any other key. */
export function nudgeGribCorner(area, cornerId, key, big = false) {
  const move = MOVES[key];
  const corner = GRIB_CORNERS.find((c) => c.id === cornerId);
  if (!move || !corner) return null;
  const step = big ? GRIB_NUDGE_BIG_DEG : GRIB_NUDGE_DEG;
  const from = corner.at(area);
  return gribArea({ lat: from.lat + move[0] * step, lon: from.lon + move[1] * step }, corner.opposite(area));
}

const HEMISPHERES = { lat: { N: 1, S: -1 }, lon: { E: 1, W: -1, O: -1 } };
const LIMITS = { lat: 90, lon: 180 };

/**
 * A typed latitude or longitude: decimal degrees, south and west negative,
 * or a positive value with a hemisphere letter ("12.5S", "9.5 W", French "O").
 * A comma works as the decimal mark. Null when it cannot be read or is out of range.
 */
export function parseGribCoordinate(text, axis) {
  const match = /^([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([A-Za-z])?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  let value = Number(match[1].replace(',', '.'));
  if (match[2]) {
    const sign = HEMISPHERES[axis][match[2].toUpperCase()];
    if (!sign || /^[+-]/.test(match[1])) return null;
    value *= sign;
  }
  return Number.isFinite(value) && Math.abs(value) <= LIMITS[axis] ? value : null;
}
