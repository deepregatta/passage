/**
 * Route-local bounding boxes, passage-duration budgets and grid disclosures.
 * ForecastStore builds routing lattices from precomputed tiles; these helpers
 * do not fetch data or plan a separate lattice.
 */

import { haversineNm } from '../geo.js';

export interface RouteBbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export function routeBbox(
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number },
): RouteBbox {
  if (Math.abs(finish.lon - start.lon) > 180) {
    throw new Error('Antimeridian-crossing routes are not supported yet');
  }
  const latSpan = Math.abs(finish.lat - start.lat);
  const lonSpan = Math.abs(finish.lon - start.lon);
  const latPad = Math.max(0.5, 0.25 * latSpan);
  const lonPad = Math.max(0.5, 0.25 * lonSpan);
  return {
    minLat: Math.max(-90, Math.min(start.lat, finish.lat) - latPad),
    maxLat: Math.min(90, Math.max(start.lat, finish.lat) + latPad),
    minLon: Math.max(-180, Math.min(start.lon, finish.lon) - lonPad),
    maxLon: Math.min(180, Math.max(start.lon, finish.lon) + lonPad),
  };
}

export function passageMaxHours(
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number },
): number {
  return passageHoursForNm(haversineNm(start.lat, start.lon, finish.lat, finish.lon));
}

/** The search horizon for a passage of `nm` nautical miles: at `speedKt` (4 kt), 48 h to 240 h. */
export function passageHoursForNm(nm: number, speedKt = 4): number {
  return Math.max(48, Math.min(240, Math.ceil(nm / speedKt)));
}

/** Shared disclosure; callers retain their own coarsening trigger and resolution precision. */
export function coarsenedGridNote(resolutionDeg: number): string {
  return `Forecast grid coarsened to ${resolutionDeg}° to keep this crossing within the browser point budget.`;
}
