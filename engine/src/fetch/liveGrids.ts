/**
 * Route-local grid geometry: bounding boxes, passage-duration budgets, and the
 * regular-lattice planner used by routing. Grid DATA comes from the
 * ForecastStore (precomputed tiles); these helpers only decide the geometry.
 */

import { haversineNm } from '../geo.js';

export interface RouteBbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface GridPlan extends RouteBbox {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  points: Array<{ lat: number; lon: number }>;
  under_resolved_note?: string;
}

const TIDY_STEPS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0];

function assertBbox(bbox: RouteBbox): void {
  if (
    bbox.minLat > bbox.maxLat ||
    bbox.minLon > bbox.maxLon ||
    bbox.minLon < -180 ||
    bbox.maxLon > 180 ||
    bbox.maxLon - bbox.minLon > 180
  ) {
    throw new Error('Antimeridian-crossing routes are not supported yet');
  }
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
  const estimate = Math.ceil(haversineNm(start.lat, start.lon, finish.lat, finish.lon) / 4);
  return Math.max(48, Math.min(240, estimate));
}

export function planGrid(
  bbox: RouteBbox,
  options: { targetPoints?: number; maxResolutionDeg?: number; minResolutionDeg?: number } = {},
): GridPlan {
  assertBbox(bbox);
  const target = options.targetPoints ?? 200;
  const minRes = options.minResolutionDeg ?? 0.15;
  const maxRes = options.maxResolutionDeg ?? 1.0;
  const candidates = TIDY_STEPS.filter((step) => step >= minRes && step <= maxRes);
  if (!candidates.length) throw new Error('No supported grid resolution in the requested range');

  let chosen: { step: number; nlat: number; nlon: number } | null = null;
  for (const step of candidates) {
    const nlat = Math.max(2, Math.ceil((bbox.maxLat - bbox.minLat) / step) + 1);
    const nlon = Math.max(2, Math.ceil((bbox.maxLon - bbox.minLon) / step) + 1);
    if (nlat * nlon <= target) {
      chosen = { step, nlat, nlon };
      break;
    }
  }
  if (!chosen) {
    throw new Error('This passage area is too large for live routing; choose a shorter crossing');
  }

  // Anchor at the upper bounds so the regular lattice covers the requested
  // box without producing invalid coordinates above 90°/180°.
  const lat0 = bbox.maxLat - (chosen.nlat - 1) * chosen.step;
  const lon0 = bbox.maxLon - (chosen.nlon - 1) * chosen.step;
  const points: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < chosen.nlat; i++) {
    const lat = lat0 + i * chosen.step;
    for (let j = 0; j < chosen.nlon; j++) {
      const lon = lon0 + j * chosen.step;
      points.push({ lat, lon });
    }
  }
  return {
    ...bbox,
    lat0,
    lon0,
    dlat: chosen.step,
    dlon: chosen.step,
    nlat: chosen.nlat,
    nlon: chosen.nlon,
    points,
    under_resolved_note:
      chosen.step > 0.25
        ? `Forecast grid coarsened to ${chosen.step}° to keep this crossing within the browser point budget.`
        : undefined,
  };
}
