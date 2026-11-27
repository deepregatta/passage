// The window the planner routes a passage on, on the real 0.05° outline: a passage whose way
// round lies outside the route box is searched on a larger window, and closed water is said
// only when no larger window could join the ends. Also the outline's last column at 180°E.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { passageMaxHours, routeBbox, type RouteBbox } from '../src/fetch/liveGrids.js';
import type { RegionGrid } from '../src/grids.js';
import { ClosedWaterError, computeRoute } from '../src/routing/isochrone.js';
import { insideMask, isLand, seaWayInWindow, segmentCrossesLand, type RoutingLandMask } from '../src/routing/landmask.js';
import { snapEndsToSea, windowLandMask, type PackedLandMaskMetadata } from '../src/routing/landmaskPack.js';
import { ROUTE_WINDOW_GROWTH_DEG, grownRouteBbox, routingWindow } from '../src/routing/routingWindow.js';
import { polarFromRelease } from '../src/routing/deepPolars.js';
import { INVENTED_POLAR_ENTRY } from '../scripts/perf/scenarios.js';

type P = { lat: number; lon: number };
const HERE = dirname(fileURLToPath(import.meta.url));
const LAND = join(HERE, '..', '..', 'viewer', 'public', 'data', 'land');
const coarse = {
  bytes: new Uint8Array(gunzipSync(readFileSync(join(LAND, 'global-005.bin.gz')))),
  metadata: JSON.parse(readFileSync(join(LAND, 'global-005.json'), 'utf8')) as PackedLandMaskMetadata,
};
const outline = (bbox: RouteBbox) => windowLandMask(coarse.bytes, coarse.metadata, bbox);

// The bench's invented cruiser, computed from a formula: no polar data enters this repository.
const POLAR = polarFromRelease(INVENTED_POLAR_ENTRY);
const DEPARTURE = '2026-07-20T06:00:00Z';

/** A uniform 14 kt wind from `fromDeg` over the box, one value per hour. */
function uniformWind(bbox: RouteBbox, fromDeg: number, hours: number): RegionGrid {
  const rad = (fromDeg * Math.PI) / 180;
  const u = Math.round(-14 * Math.sin(rad) * 100) / 100;
  const v = Math.round(-14 * Math.cos(rad) * 100) / 100;
  const lat0 = Math.max(-90, Math.floor(bbox.minLat) - 1);
  const lon0 = Math.floor(bbox.minLon) - 1;
  const nlat = Math.ceil((Math.min(90, bbox.maxLat + 1) - lat0) / 0.25) + 1;
  const nlon = Math.ceil((bbox.maxLon + 1 - lon0) / 0.25) + 1;
  const time_axis = Array.from({ length: hours }, (_, h) =>
    new Date(Date.parse(DEPARTURE) + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const size = hours * nlat * nlon;
  return {
    schema_version: 1, kind: 'wind10m', run_id: 'synthetic-uniform', generated_at: DEPARTURE,
    lat0, lon0, dlat: 0.25, dlon: 0.25, nlat, nlon, time_axis,
    u_kt: Array(size).fill(u), v_kt: Array(size).fill(v), source: { mode: 'synthetic' },
  };
}

/** The planner's steps: the route box, snap both ends on it, then the window to route on. */
async function plan(start: P, finish: P) {
  const bbox = routeBbox(start, finish);
  const landMask = outline(bbox);
  const { start: from, finish: to } = snapEndsToSea(landMask, start, finish);
  if (!from || !to) throw new Error('an end has no water near it');
  const maxHours = passageMaxHours(start, finish);
  const window = await routingWindow({ bbox, landMask, start: from, finish: to, maxHours, maskFor: outline });
  return { routeBox: bbox, routeBoxMask: landMask, from, to, straightHours: maxHours, ...window };
}

const routeOn = (bbox: RouteBbox, landMask: RoutingLandMask, from: P, to: P, maxHours: number, fromDeg: number) =>
  computeRoute({
    start: from, finish: to, departureUtc: DEPARTURE, polar: POLAR,
    windGrid: uniformWind(bbox, fromDeg, maxHours + 2), landMask, maxHours,
  });

const failure = (run: () => unknown): Error => {
  try { run(); } catch (error) { return error as Error; }
  throw new Error('expected a failure');
};

const legsOnLand = (landMask: RoutingLandMask, waypoints: P[]) =>
  waypoints.slice(1).filter((point, k) => segmentCrossesLand(landMask, waypoints[k]!, point));

const GENERIC = /^No route found within \d+ h \(wind coverage, land, or no-go conditions\)$/;

// The third review's cases: on the route box the ends' water runs off the edge of the window
// (Land's End, Cape Finisterre, the south of Taiwan, Cape Leeuwin, the Sea of Japan), and the
// router used to call it closed water.
const WAY_ROUND_OUTSIDE: Array<[string, P, P, number[]]> = [
  ['Falmouth to Padstow, round Land’s End', { lat: 50.15, lon: -5.05 }, { lat: 50.56, lon: -4.95 }, [250, 90]],
  ['the Bristol Channel to Plymouth, round Land’s End', { lat: 51.40, lon: -3.40 }, { lat: 50.33, lon: -4.15 }, [250, 0, 90]],
  ['Vigo to La Coruña, round Cape Finisterre', { lat: 42.24, lon: -8.73 }, { lat: 43.37, lon: -8.39 }, [0, 180]],
  ['the east coast of Taiwan to the Taiwan Strait, round its south', { lat: 23.503, lon: 121.681 }, { lat: 22.848, lon: 119.937 }, [250]],
  ['off Mandurah to the south coast of Western Australia, round Cape Leeuwin', { lat: -32.768, lon: 115.527 }, { lat: -35.100, lon: 117.161 }, [250]],
];
// Hokkaido to Sakhalin, round the Sea of Japan and La Pérouse Strait: the route box no longer calls it
// closed water, but on the larger window the graph (0.065° between nodes over 9.7° of latitude) does
// not thread the straits in this wind, a limit of the router's graph on a long passage, not of the window.
const HOKKAIDO_TO_SAKHALIN: [string, P, P, number[]] =
  ['Hokkaido to Sakhalin', { lat: 41.5818, lon: 141.0632 }, { lat: 48.0464, lon: 142.7128 }, [90]];

describe('a passage whose way round lies outside the route box', () => {
  it.each([...WAY_ROUND_OUTSIDE, HOKKAIDO_TO_SAKHALIN])('%s: the route box does not call it closed water', async (_label, start, finish, winds) => {
    const { routeBox, routeBoxMask, from, to, straightHours } = await plan(start, finish);
    expect(seaWayInWindow(routeBoxMask, from, to)).toBe('beyond');
    const error = failure(() => routeOn(routeBox, routeBoxMask, from, to, straightHours, winds[0]!));
    expect(error).not.toBeInstanceOf(ClosedWaterError);
    expect(error.message).toMatch(GENERIC);
  }, 120_000);

  it.each(WAY_ROUND_OUTSIDE)('%s computes on the larger window the planner chooses', async (_label, start, finish, winds) => {
    const { routeBox, bbox, landMask, from, to, maxHours, straightHours, grownDeg } = await plan(start, finish);
    expect(ROUTE_WINDOW_GROWTH_DEG).toContain(grownDeg);
    // The window holds the route box, and lies inside the first larger window that joined the ends.
    const outer = grownRouteBbox(routeBox, grownDeg);
    expect(bbox.minLat <= routeBox.minLat && bbox.maxLat >= routeBox.maxLat && bbox.minLon <= routeBox.minLon && bbox.maxLon >= routeBox.maxLon).toBe(true);
    expect(bbox.minLat >= outer.minLat && bbox.maxLat <= outer.maxLat && bbox.minLon >= outer.minLon && bbox.maxLon <= outer.maxLon).toBe(true);
    expect(seaWayInWindow(landMask, from, to)).toBe('joined');
    expect(maxHours).toBeGreaterThanOrEqual(straightHours);
    for (const fromDeg of winds) {
      const { route } = routeOn(bbox, landMask, from, to, maxHours, fromDeg);
      expect(route.waypoints.filter((p) => !insideMask(landMask, p.lat, p.lon))).toEqual([]);
      expect(legsOnLand(landMask, route.waypoints)).toEqual([]);
    }
  }, 120_000);
});

describe('the window the planner chooses', () => {
  it('keeps the route box, its mask and its horizon when the box joins the ends', async () => {
    const start = { lat: 50.766, lon: -1.298 }, finish = { lat: 49.66, lon: -1.62 };
    const { routeBox, routeBoxMask, bbox, landMask, maxHours, straightHours, grownDeg } = await plan(start, finish);
    expect(grownDeg).toBe(0);
    expect(bbox).toBe(routeBox);
    expect(landMask).toBe(routeBoxMask);
    expect(maxHours).toBe(straightHours);
  });

  it('still says closed water where one end’s water is enclosed: the sounds behind the Outer Banks to the open Atlantic', async () => {
    // The outline closes the inlets of the sounds; their water lies wholly inside a window 1° larger
    // than the route box. The search keeps the route box: no forecast is read for the larger one.
    const { routeBox, routeBoxMask, bbox, landMask, from, to, maxHours } = await plan({ lat: 36.091, lon: -75.974 }, { lat: 36.946, lon: -75.793 });
    expect(seaWayInWindow(routeBoxMask, from, to)).toBe('beyond');
    expect(bbox).toBe(routeBox);
    expect(seaWayInWindow(landMask, from, to)).toBe('closed');
    expect(failure(() => routeOn(bbox, landMask, from, to, maxHours, 250))).toBeInstanceOf(ClosedWaterError);
  }, 120_000);

  it('gives the generic failure, never closed water, when the way round lies beyond the largest window', async () => {
    // Belize to the Gulf of Fonseca: the outline has no Panama Canal, so the way round is Cape Horn.
    const { routeBox, bbox, landMask, from, to, maxHours, grownDeg } = await plan({ lat: 16.400, lon: -88.341 }, { lat: 12.207, lon: -87.047 });
    expect(grownDeg).toBe(0);
    expect(bbox).toBe(routeBox);
    const largest = outline(grownRouteBbox(routeBox, ROUTE_WINDOW_GROWTH_DEG.at(-1)!));
    expect(seaWayInWindow(largest, from, to)).toBe('beyond');
    const error = failure(() => routeOn(bbox, landMask, from, to, maxHours, 250));
    expect(error).not.toBeInstanceOf(ClosedWaterError);
    expect(error.message).toMatch(GENERIC);
  }, 120_000);
});

describe('the outline at 180°E', () => {
  // The outline's last column is centred at 179.95°E; the cell centred at 180°E is its first
  // column, at -180°. A window reaching 180°E holds that cell, so an end east of 179.975°E routes.
  it('a window reaching 180°E holds the cell centred there, read from the -180° column', () => {
    const mask = outline({ minLat: 60, maxLat: 70, minLon: 178, maxLon: 180 });
    expect(insideMask(mask, 64.5, 179.99)).toBe(true);
    expect(insideMask(mask, 64.5, 180)).toBe(true);
    const west = outline({ minLat: 60, maxLat: 70, minLon: -180, maxLon: -179 });
    for (let lat = 60; lat <= 70; lat += 0.05) expect(isLand(mask, lat, 180)).toBe(isLand(west, lat, -180));
  });

  it.each([
    ['Fiji, east of 179.975°E', { lat: -16.8, lon: 179.99 }, { lat: -17.5, lon: 179.3 }],
    ['Fiji, at 180°E', { lat: -16.8, lon: 180 }, { lat: -17.5, lon: 179.3 }],
    ['the Bering Sea, 64.5°N 179.99°E', { lat: 64.5, lon: 179.99 }, { lat: 63.5, lon: 178.5 }],
  ])('%s routes', (_label, start, finish) => {
    const bbox = routeBbox(start, finish);
    const landMask = outline(bbox);
    const { start: from, finish: to } = snapEndsToSea(landMask, start, finish);
    const maxHours = passageMaxHours(from!, to!);
    const { route } = routeOn(bbox, landMask, from!, to!, maxHours, 250);
    expect(legsOnLand(landMask, route.waypoints)).toEqual([]);
  }, 120_000);
});
