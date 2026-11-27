/**
 * The window the planner routes a passage on. The route box (routeBbox) pads the two ends by
 * 0.5° or a quarter of the passage, and often does not hold the way round a headland or an
 * island: Land's End between Falmouth and Padstow, Cape Finisterre between Vigo and La Coruña.
 * There the ends' water runs off the edge of the box's land window (seaWayInWindow 'beyond'),
 * and the route is searched on a larger window, with a horizon long enough for the way round.
 * Pure: the caller loads each window's land mask (maskFor).
 */

import { passageHoursForNm, type RouteBbox } from '../fetch/liveGrids.js';
import { seaWay, seaWayInWindow, type RoutingLandMask } from './landmask.js';

/**
 * How far past the route box, in degrees on every side, the larger windows reach, tried in this
 * order: the first that joins the ends is the one routed on.
 */
export const ROUTE_WINDOW_GROWTH_DEG: readonly number[] = Object.freeze([1, 2, 4, 8, 16]);

/**
 * The speed along the way by sea that a larger window's horizon allows for, in knots: half the
 * straight line's 4 kt (passageMaxHours). A way round a headland usually holds a beat; in a
 * uniform 14 kt wind the routes found on larger windows made 3.0 kt along it at the slowest and
 * 5.1 kt in the median (2026-11-27, 517 passages and winds), so 2 kt leaves room for lighter or
 * shifting real wind. The horizon
 * never takes a route past the forecast: the router reads no wind past the wind grid's last
 * hour, and the planner reads the wind to at most the end of the forecast.
 */
export const WAY_ROUND_SPEED_KT = 2;

/**
 * The room kept round the way by sea in the window routed on, in degrees: the route box's own
 * least pad. A window only as large as the way round needs keeps the router's graph fine (its
 * node spacing is the window's span / 150) and the forecast read small.
 */
export const ROUTE_WINDOW_MARGIN_DEG = 0.5;

/** `bbox` grown by `padDeg` on every side, within the globe (latitude ±90°, longitude ±180°). */
export function grownRouteBbox(bbox: RouteBbox, padDeg: number): RouteBbox {
  return {
    minLat: Math.max(-90, bbox.minLat - padDeg),
    maxLat: Math.min(90, bbox.maxLat + padDeg),
    minLon: Math.max(-180, bbox.minLon - padDeg),
    maxLon: Math.min(180, bbox.maxLon + padDeg),
  };
}

export interface RoutingWindowOptions {
  /** the route box, and its land mask, on which both ends were snapped */
  bbox: RouteBbox;
  landMask: RoutingLandMask;
  start: { lat: number; lon: number };
  finish: { lat: number; lon: number };
  /** the search horizon on the route box (passageMaxHours) */
  maxHours: number;
  /** the land mask of a larger window, as the caller loads the route box's */
  maskFor: (bbox: RouteBbox) => RoutingLandMask | Promise<RoutingLandMask>;
}

export interface RoutingWindow {
  /** where the router searches: the forecast is read over this box */
  bbox: RouteBbox;
  landMask: RoutingLandMask;
  maxHours: number;
  /** how far past the route box the land mask reaches, in degrees (0: the route box's own) */
  grownDeg: number;
}

/**
 * The window to route the snapped ends on:
 *
 * - the route box itself, unchanged, when its window joins the ends or proves them apart;
 * - else the first larger window (ROUTE_WINDOW_GROWTH_DEG) that joins them, cut down to the route
 *   box and the shortest way by sea between the ends (seaWay) with ROUTE_WINDOW_MARGIN_DEG round
 *   it when that shortens the window's longer side (the graph's node spacing is that side / 150),
 *   and the horizon of that way at WAY_ROUND_SPEED_KT when it is longer than `maxHours`;
 * - when a larger window proves them apart (one end's water is enclosed in it), the route box
 *   for the search with that window's land mask, so that the router says closed water without
 *   any forecast read for the larger box;
 * - when even the largest window neither joins nor proves them apart, the route box unchanged:
 *   the router then fails with its generic message, never closed water.
 */
export async function routingWindow(options: RoutingWindowOptions): Promise<RoutingWindow> {
  const { bbox, landMask, start, finish, maxHours, maskFor } = options;
  const routeBox: RoutingWindow = { bbox, landMask, maxHours, grownDeg: 0 };
  if (seaWayInWindow(landMask, start, finish) !== 'beyond') return routeBox;
  let previous = bbox;
  for (const padDeg of ROUTE_WINDOW_GROWTH_DEG) {
    const grown = grownRouteBbox(bbox, padDeg);
    if (sameBox(grown, previous)) continue;
    previous = grown;
    const mask = await maskFor(grown);
    const way = seaWayInWindow(mask, start, finish);
    if (way === 'beyond') continue;
    if (way === 'closed') return { ...routeBox, landMask: mask, grownDeg: padDeg };
    const found = { bbox: grown, landMask: mask, maxHours, grownDeg: padDeg };
    const path = seaWay(mask, start, finish);
    if (!path) return found;
    found.maxHours = Math.max(maxHours, passageHoursForNm(path.nm, WAY_ROUND_SPEED_KT));
    const room = grownRouteBbox(path, ROUTE_WINDOW_MARGIN_DEG);
    const window = {
      minLat: Math.max(grown.minLat, Math.min(bbox.minLat, room.minLat)),
      maxLat: Math.min(grown.maxLat, Math.max(bbox.maxLat, room.maxLat)),
      minLon: Math.max(grown.minLon, Math.min(bbox.minLon, room.minLon)),
      maxLon: Math.min(grown.maxLon, Math.max(bbox.maxLon, room.maxLon)),
    };
    // Only a cut that shortens the window's longer side makes the graph finer; else the room stays.
    if (span(window) >= span(grown)) return found;
    const windowMask = await maskFor(window);
    // It holds every cell of the way, so it joins the ends; were it not to, the larger window stays.
    if (seaWayInWindow(windowMask, start, finish) !== 'joined') return found;
    return { ...found, bbox: window, landMask: windowMask };
  }
  return routeBox;
}

const span = (box: RouteBbox) => Math.max(box.maxLat - box.minLat, box.maxLon - box.minLon);

const sameBox = (a: RouteBbox, b: RouteBbox) =>
  a.minLat === b.minLat && a.maxLat === b.maxLat && a.minLon === b.minLon && a.maxLon === b.maxLon;
