/**
 * Minimal weather router: time-dependent
 * Dijkstra over a sea grid — earliest-arrival labels whose level sets are the
 * isochrones. Chosen over frontier-pruning isochrone expansion after that
 * approach demonstrably stalled on U-shaped land detours (wall-gap fixture:
 * outward hulls cannot retract, convergent hulls pin against the wall, and
 * upwind returns lose every bucket contest). Dijkstra is provably optimal on
 * the graph and fast enough for the browser. Land checks use the supplied
 * mask and its segment sampler; they are not a navigation safety guarantee.
 *
 * Routing is route ACQUISITION: the computed route carries its leg timing into the audit,
 * flagged as inheriting polar uncertainty.
 */

import { alongCourseComponentKt, windFromDeg } from '../vectors.js';
import { bearingDegTrue, haversineNm, wrap180 } from '../geo.js';
import { parseUtc, toIso } from '../eta.js';
import { GridSampler, type RegionGrid } from '../grids.js';
import { boatSpeedKt, type Polar } from './polar.js';
import { isLand, seaJoinsPoints, segmentCrossesLand, type RoutingLandMask } from './landmask.js';
import type { Route, Waypoint } from '../types.js';

export interface RoutingRequest {
  start: { lat: number; lon: number; name?: string };
  finish: { lat: number; lon: number; name?: string };
  departureUtc: string;
  polar: Polar;
  /** scales every polar speed (crew/sea-state factor); 1 = table values */
  polarScaling?: number;
  windGrid: RegionGrid;
  currentGrid?: RegionGrid;
  /**
   * Without it a missing current sample counts as no current. With it the
   * router stops with CurrentGapError instead, so a route is never part one
   * grid and part zero current (used for prepared grids).
   */
  strictCurrent?: boolean;
  /**
   * Confines the search to this lat/lon box (selectRoutingCurrent passes a
   * prepared current grid's box): a graph node outside it is never expanded
   * and never joins an end, and both ends must lie inside it, or the router
   * throws SearchBoundsError. The graph itself (extent, resolution, node
   * positions) is unchanged, and until the search would expand a node outside
   * the box (travel on from it to any neighbour) or join one to an end, it runs
   * exactly as without it, so a route the box never held back is the route
   * computed without it, byte for byte. A route the box held back
   * records the area searched (`routing_request.search_bounds`), and a search
   * the box held back that finds no route throws SearchBoundsError instead of
   * the usual routing error.
   */
  searchBounds?: SearchBounds;
  /** The 0.05° outline window, or the fine routing-index window (routingLandMask). */
  landMask?: RoutingLandMask;
  /** graph resolution in degrees; default adapts to the crossing size */
  resolutionDeg?: number;
  maxHours?: number;
  /** diagnostic hook: settled-node count + best arrival so far, every ~500 pops */
  debug?: (info: { settled: number; bestToGoNm: number; hoursOut: number }) => void;
}

export interface RoutingResult {
  route: Route;
  arrival_utc: string;
  duration_h: number;
  distance_nm: number;
  avg_sog_kt: number;
  /** settled graph nodes — a cost indicator */
  steps_used: number;
}

const MIN_SOG_KT = 0.3;
/** How many rings of graph nodes around an endpoint may connect to it. */
const ENDPOINT_RINGS = 7;

/** A strict-current search read a point or time the current grid does not cover. */
export class CurrentGapError extends Error {
  readonly code = 'current-gap';
  /**
   * @param beyondTimeAxis true when the read was at a time outside the grid's
   *   time axis (the passage outlasts the grid), false when it was at a time the
   *   grid covers (a place without a value). A departure comparison leaves out
   *   only the departures whose passage outlasts the grid.
   */
  constructor(readonly beyondTimeAxis = false) {
    super('The current grid does not cover every point and time the router reads');
    this.name = 'CurrentGapError';
  }
}

export interface SearchBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * A search confined by RoutingRequest.searchBounds could not run inside them:
 * an end lies outside the box (`endpoint-outside`), or no route was found
 * after the box held the search back (`no-route`).
 */
export class SearchBoundsError extends Error {
  readonly code = 'search-bounds';
  constructor(readonly reason: 'endpoint-outside' | 'no-route') {
    super(reason === 'endpoint-outside'
      ? 'The start or finish is outside the area the route may search'
      : 'No route found inside the area the route may search');
    this.name = 'SearchBoundsError';
  }
}

/**
 * No route was found, and on the land mask no sea joins the start and the finish edge to
 * edge (the router's land check refuses any leg touching a land cell, so no route can exist
 * on that mask). The mask is the coarse coastline outline: a strait or channel too narrow to
 * be in it closes the water here although boats can sail it. Found only after a search has
 * failed, by a flood fill over the mask (seaJoinsPoints); never thrown when
 * searchBounds held the search back (SearchBoundsError keeps that case: its callers retry
 * without the box, and that run reports this error).
 */
export class ClosedWaterError extends Error {
  readonly code = 'closed-water';
  /** @param fine whether the mask was the fine routing-index window (its own wording, owner-approved 2026-11-26) */
  constructor(fine = false) {
    super(fine
      ? 'No route found: on the outline of the coast the router uses, no open water joins the start and the finish. ' +
        'A channel between them is too narrow for it or dries at low tide. Use Draw my route instead.'
      : 'No route found: on the coarse outline of the coast, no open water joins the start and the finish. ' +
        'A strait or channel between them is too narrow to be in it. Use Draw my route instead.');
    this.name = 'ClosedWaterError';
  }
}

/** One regular grid of graph nodes: node offset + i * nlon + j at (lats[i], lons[j]). */
interface GraphLayer {
  lat0: number;
  lon0: number;
  res: number;
  nlat: number;
  nlon: number;
  offset: number;
  lats: number[];
  lons: number[];
  rowIn: boolean[];
  colIn: boolean[];
}

/**
 * End patches, on the fine routing index only, in two tiers round each end: node spacing in
 * fine cells and how far a tier reaches from its end, in fine cells. Nodes sit on fine cell
 * centres, never on cell edges. Measured on the nweu tiles (2026-11-26):
 * - inner, a node in every cell (1/480°, about 230 m by 150 m at 50°N) out to 0.15°: a graph
 *   of 1/240° threads the 0.7 km lane of the Goulet de Brest off the wind, and only with its
 *   nodes on centres; beating through it in a westerly needs a node in every cell;
 * - outer, every fourth cell (1/120°) out to 0.5°: the main grid of a long passage (span/150,
 *   0.03° to 0.1°) cannot carry a route from the inner tier's edge through the narrow water
 *   beyond it (Spithead and the Nab from Cowes, the Iroise from the Goulet).
 */
export const END_PATCH_TIERS: ReadonlyArray<{ strideCells: number; halfCells: number }> = [
  { strideCells: 4, halfCells: 240 },
  { strideCells: 1, halfCells: 72 },
];

/** Whether one of `points` lies in a fine routing-index cell of the mask. */
function inFineCell(mask: RoutingLandMask, points: Array<{ lat: number; lon: number }>): boolean {
  if (mask.kind !== 'land_cells' || !mask.fine_index_id || !mask.fineAt) return false;
  return points.some((p) => {
    const i = Math.round((p.lat - mask.lat0) / mask.dlat);
    const j = Math.round((p.lon - mask.lon0) / mask.dlon);
    return i >= 0 && i < mask.nlat && j >= 0 && j < mask.nlon && mask.fineAt!(i, j);
  });
}

/** Whether every point of `path`, and every point of each leg between them, lies in a fine routing-index cell. */
function allInFineCells(mask: RoutingLandMask, path: Array<{ lat: number; lon: number }>): boolean {
  if (mask.kind !== 'land_cells' || !mask.fine_index_id || !mask.fineAt) return false;
  const fineAt = mask.fineAt;
  const at = (lat: number, lon: number) => {
    const i = Math.round((lat - mask.lat0) / mask.dlat);
    const j = Math.round((lon - mask.lon0) / mask.dlon);
    return i >= 0 && i < mask.nlat && j >= 0 && j < mask.nlon && fineAt(i, j);
  };
  if (!path.every((p) => at(p.lat, p.lon))) return false;
  // Each leg sampled at half a cell: the fine tiles are whole 10° squares, so a leg leaving them does so for many cells.
  const step = Math.min(mask.dlat, mask.dlon) / 2;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!;
    const b = path[k]!;
    const n = Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon)) / step);
    for (let s = 1; s < n; s++) {
      if (!at(a.lat + ((b.lat - a.lat) * s) / n, a.lon + ((b.lon - a.lon) * s) / n)) return false;
    }
  }
  return true;
}

/** Whether an end lies in a fine routing-index cell: the only case end patches are made for. */
const endInFineCell = inFineCell;

/**
 * The fine grids of one tier (END_PATCH_TIERS) the router adds around its ends: one around each
 * end that lies in a fine routing-index cell (a LandCellMask whose fineAt says so), two that
 * overlap or touch merged into one, each clipped to the graph extent. None on any other mask.
 */
function endPatchBoxes(
  mask: RoutingLandMask,
  ends: Array<{ lat: number; lon: number }>,
  extent: { lat0: number; lat1: number; lon0: number; lon1: number },
  tier: { strideCells: number; halfCells: number },
): Array<{ lat0: number; lon0: number; res: number; nlat: number; nlon: number }> {
  if (mask.kind !== 'land_cells' || !mask.fine_index_id || !mask.fineAt || mask.dlat !== mask.dlon) return [];
  const fineAt = mask.fineAt;
  const S = tier.strideCells;
  const H = tier.halfCells;
  // Boxes of mask cells [i0, i1] x [j0, j1], each holding its end's cell on a node row and column.
  const boxes: Array<{ i0: number; i1: number; j0: number; j1: number }> = [];
  for (const p of ends) {
    const i = Math.round((p.lat - mask.lat0) / mask.dlat);
    const j = Math.round((p.lon - mask.lon0) / mask.dlon);
    if (!(i >= 0 && i < mask.nlat && j >= 0 && j < mask.nlon) || !fineAt(i, j)) continue;
    boxes.push({ i0: i - H, i1: i + H, j0: j - H, j1: j + H });
  }
  if (boxes.length === 2) {
    const [a, b] = boxes as [typeof boxes[0], typeof boxes[0]];
    if (a.i0 <= b.i1 + S && b.i0 <= a.i1 + S && a.j0 <= b.j1 + S && b.j0 <= a.j1 + S) {
      boxes.splice(0, 2, { i0: Math.min(a.i0, b.i0), i1: Math.max(a.i1, b.i1), j0: Math.min(a.j0, b.j0), j1: Math.max(a.j1, b.j1) });
    }
  }
  const out = [];
  for (const box of boxes) {
    // Clip to the mask and the graph extent, keeping the node lattice of the box.
    const lo = (first: number, min: number) => first + Math.max(0, Math.ceil((min - first) / S)) * S;
    const i0 = lo(box.i0, Math.max(0, Math.ceil((extent.lat0 - mask.lat0) / mask.dlat - 1e-9)));
    const j0 = lo(box.j0, Math.max(0, Math.ceil((extent.lon0 - mask.lon0) / mask.dlon - 1e-9)));
    const i1 = Math.min(box.i1, mask.nlat - 1, Math.floor((extent.lat1 - mask.lat0) / mask.dlat + 1e-9));
    const j1 = Math.min(box.j1, mask.nlon - 1, Math.floor((extent.lon1 - mask.lon0) / mask.dlon + 1e-9));
    const nlat = Math.floor((i1 - i0) / S) + 1;
    const nlon = Math.floor((j1 - j0) / S) + 1;
    if (nlat < 2 || nlon < 2) continue;
    out.push({ lat0: mask.lat0 + i0 * mask.dlat, lon0: mask.lon0 + j0 * mask.dlon, res: S * mask.dlat, nlat, nlon });
  }
  return out;
}

/** 16-direction neighborhood: angular resolution ~22.5° */
const NEIGHBORS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];
/** The longest graph edge in grid cells (√5): the longest step of a last leg from another finish node. */
const LONGEST_EDGE_CELLS = Math.max(...NEIGHBORS.map(([di, dj]) => Math.hypot(di, dj)));
/**
 * After the snapped finish node's last leg failed and no other finish node has joined yet,
 * how far past that node's settle time the search goes on before it gives up: a finish
 * node it has not settled by then (reachable only dead upwind, or not at all) no longer
 * holds it to the full horizon.
 */
const ALTERNATIVE_END_WINDOW_MS = 6 * 3600_000;

/**
 * Route `request`. On the fine routing index, when the main grid finds no route (no node near
 * an end joins it, or the search fails) and an end lies in a fine cell, the search runs again
 * with fine end patches (END_PATCH_*): a harbour, a river mouth or a narrows that the main grid
 * is too coarse to thread. A route the main grid finds is never searched again, and closed
 * water, a search held back by searchBounds and a current gap are final.
 */
export function computeRoute(request: RoutingRequest): RoutingResult {
  try {
    return routeOnGraph(request, false);
  } catch (error) {
    const final = error instanceof ClosedWaterError || error instanceof SearchBoundsError || error instanceof CurrentGapError;
    if (final || !(error instanceof Error) || !request.landMask || !endInFineCell(request.landMask, [request.start, request.finish])) throw error;
    if (!/^No route found within|^No sea node near/.test(error.message)) throw error;
    return routeOnGraph(request, true);
  }
}

function routeOnGraph(request: RoutingRequest, withEndPatches: boolean): RoutingResult {
  const { start, finish, polar, windGrid, currentGrid, landMask } = request;
  const departureMs = parseUtc(request.departureUtc);
  const scaling = request.polarScaling ?? 1;
  const maxMs = (request.maxHours ?? 48) * 3600_000;
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new Error('Routing horizon must be finite and nonnegative');
  if (!Number.isFinite(scaling) || scaling <= 0) throw new Error('Polar scaling must be finite and positive');
  const deadlineMs = departureMs + maxMs;
  // Set once searchBounds holds the search back: a node outside it would otherwise be expanded or join an end.
  let clipped = false;
  // Only on a failure: a flood fill over the land mask says whether any sea joins the two ends.
  const noRoute = () => {
    if (clipped) return new SearchBoundsError('no-route');
    if (landMask && !seaJoinsPoints(landMask, startPoint, finishPoint, graphReachesBeyondMask())) {
      return new ClosedWaterError(landMask.kind === 'land_cells' && landMask.fine_index_id !== null);
    }
    return new Error(`No route found within ${request.maxHours ?? 48} h (wind coverage, land, or no-go conditions)`);
  };
  // The graph can reach past the mask (an end near or outside its edge grows the graph to include it),
  // where every cell counts as sea: then water round the window is water the router could use.
  const graphReachesBeyondMask = () => {
    if (!landMask) return false;
    const eps = 1e-9;
    return lat0 < landMask.lat0 - eps || lat1 > landMask.lat0 + (landMask.nlat - 1) * landMask.dlat + eps ||
      lon0 < landMask.lon0 - eps || lon1 > landMask.lon0 + (landMask.nlon - 1) * landMask.dlon + eps;
  };

  if (landMask && (isLand(landMask, start.lat, start.lon) || isLand(landMask, finish.lat, finish.lon))) {
    throw new Error('Start or finish is on land');
  }

  // graph extent: the whole routable area, not a rhumb-line corridor — coastal
  // detours can be far off-axis. Use the wind grid's coverage (intersected with
  // the land mask's extent when present), grown to include the endpoints.
  const windLat1 = windGrid.lat0 + (windGrid.nlat - 1) * windGrid.dlat;
  const windLon1 = windGrid.lon0 + (windGrid.nlon - 1) * windGrid.dlon;
  let lat0 = windGrid.lat0;
  let lat1 = windLat1;
  let lon0 = windGrid.lon0;
  let lon1 = windLon1;
  if (landMask) {
    lat0 = Math.max(lat0, landMask.lat0);
    lat1 = Math.min(lat1, landMask.lat0 + (landMask.nlat - 1) * landMask.dlat);
    lon0 = Math.max(lon0, landMask.lon0);
    lon1 = Math.min(lon1, landMask.lon0 + (landMask.nlon - 1) * landMask.dlon);
  }
  const pad = 0.1;
  lat0 = Math.min(lat0, start.lat - pad, finish.lat - pad);
  lat1 = Math.max(lat1, start.lat + pad, finish.lat + pad);
  lon0 = Math.min(lon0, start.lon - pad, finish.lon - pad);
  lon1 = Math.max(lon1, start.lon + pad, finish.lon + pad);
  const res =
    request.resolutionDeg ?? Math.max(0.02, Math.max(lat1 - lat0, lon1 - lon0) / 150);
  const nlat = Math.max(3, Math.round((lat1 - lat0) / res) + 1);
  const nlon = Math.max(3, Math.round((lon1 - lon0) / res) + 1);

  // Search on the coordinates we can actually emit: rounding a grid node
  // only after routing can move an otherwise valid coastal edge onto land.
  const rounded = (value: number) => Math.round(value * 10000) / 10000;
  const bounds = request.searchBounds;
  // The graph's layers: the main grid (layer 0, node i * nlon + j), then on the fine routing index
  // the end patches round an end that lies in a fine cell (endPatchBoxes), tier by tier from the
  // coarsest (END_PATCH_TIERS). Each patch is joined to the level above it (the coarser tier's
  // patches, or the main grid) by one link from each node of that level inside it to its nearest
  // patch node: a node has at most one link up and one down.
  const layer = (la0: number, lo0: number, step: number, rows: number, cols: number, offset: number): GraphLayer => {
    const lats = Array.from({ length: rows }, (_, i) => rounded(la0 + i * step));
    const lons = Array.from({ length: cols }, (_, j) => rounded(lo0 + j * step));
    return {
      lat0: la0, lon0: lo0, res: step, nlat: rows, nlon: cols, offset, lats, lons,
      // The rows and columns inside searchBounds (all of them without it).
      rowIn: lats.map((lat) => !bounds || (lat >= bounds.minLat && lat <= bounds.maxLat)),
      colIn: lons.map((lon) => !bounds || (lon >= bounds.minLon && lon <= bounds.maxLon)),
    };
  };
  const layers = [layer(lat0, lon0, res, nlat, nlon, 0)];
  const main = layers[0]!;
  // levels[0] is the main grid; levels[t + 1] the patches of tier t.
  const levels: GraphLayer[][] = [[main]];
  for (const tier of landMask && withEndPatches ? END_PATCH_TIERS : []) {
    const level: GraphLayer[] = [];
    for (const box of endPatchBoxes(landMask!, [start, finish], { lat0, lat1, lon0, lon1 }, tier)) {
      const last = layers.at(-1)!;
      const P = layer(box.lat0, box.lon0, box.res, box.nlat, box.nlon, last.offset + last.nlat * last.nlon);
      layers.push(P);
      level.push(P);
    }
    if (level.length > 0) levels.push(level);
  }
  const nodeCount = layers.at(-1)!.offset + layers.at(-1)!.nlat * layers.at(-1)!.nlon;
  const layerOfNode = new Uint8Array(nodeCount);
  for (let k = 1; k < layers.length; k++) layerOfNode.fill(k, layers[k]!.offset);
  const layerOf = (node: number) => layers[layerOfNode[node]!]!;
  const latAt = (node: number) => { const L = layerOf(node); return L.lats[Math.floor((node - L.offset) / L.nlon)]!; };
  const lonAt = (node: number) => { const L = layerOf(node); return L.lons[(node - L.offset) % L.nlon]!; };
  const pointAt = (node: number) => ({ lat: latAt(node), lon: lonAt(node) });
  const searchable = (node: number) => {
    const L = layerOf(node);
    const local = node - L.offset;
    return L.rowIn[Math.floor(local / L.nlon)]! && L.colIn[local % L.nlon]!;
  };
  // up[node] / down[node]: the node of the coarser / finer level it is joined to, or -1; null with no patches.
  const up = layers.length > 1 ? new Int32Array(nodeCount).fill(-1) : null;
  const down = layers.length > 1 ? new Int32Array(nodeCount).fill(-1) : null;
  for (let t = 1; t < levels.length; t++) {
    for (const P of levels[t]!) {
      const pLat1 = P.lat0 + (P.nlat - 1) * P.res;
      const pLon1 = P.lon0 + (P.nlon - 1) * P.res;
      for (const Q of levels[t - 1]!) {
        for (let i = 0; i < Q.nlat; i++) {
          const lat = Q.lats[i]!;
          if (lat < P.lat0 || lat > pLat1) continue;
          for (let j = 0; j < Q.nlon; j++) {
            const lon = Q.lons[j]!;
            if (lon < P.lon0 || lon > pLon1) continue;
            const pi = Math.max(0, Math.min(P.nlat - 1, Math.round((lat - P.lat0) / P.res)));
            const pj = Math.max(0, Math.min(P.nlon - 1, Math.round((lon - P.lon0) / P.res)));
            const a = Q.offset + i * Q.nlon + j;
            const b = P.offset + pi * P.nlon + pj;
            if (down![a] !== -1 || up![b] !== -1) continue;
            down![a] = b;
            up![b] = a;
          }
        }
      }
    }
  }
  /** The k-th neighbour of `node` at (i, j) of layer L: the 16 grid directions, then its links up and down; -1 for none. */
  const neighbourCount = NEIGHBORS.length + (up ? 2 : 0);
  const neighbour = (L: GraphLayer, i: number, j: number, node: number, k: number): number => {
    if (k === NEIGHBORS.length) return up![node]!;
    if (k === NEIGHBORS.length + 1) return down![node]!;
    const [di, dj] = NEIGHBORS[k]!;
    const ni = i + di;
    const nj = j + dj;
    if (ni < 0 || ni >= L.nlat || nj < 0 || nj >= L.nlon) return -1;
    return L.offset + ni * L.nlon + nj;
  };
  /** The layer an end connects to: the finest patch holding it, else the main grid. */
  const endLayer = (p: { lat: number; lon: number }) => layers.slice(1).reverse().find((P) =>
    p.lat >= P.lat0 && p.lat <= P.lat0 + (P.nlat - 1) * P.res && p.lon >= P.lon0 && p.lon <= P.lon0 + (P.nlon - 1) * P.res) ?? main;

  const wind = new GridSampler(windGrid);
  const current = currentGrid ? new GridSampler(currentGrid) : null;
  // Includes the endpoint connections, which previously had zero travel time.
  const travel = (from: { lat: number; lon: number }, to: { lat: number; lon: number }, t: number) => {
    const dist = haversineNm(from.lat, from.lon, to.lat, to.lon);
    if (dist === 0) return { arrivalMs: t, waterNm: 0 };
    const w = wind.sample(from.lat, from.lon, t);
    if (!w) return null;
    const heading = bearingDegTrue(from.lat, from.lon, to.lat, to.lon);
    const stw = boatSpeedKt(polar, Math.hypot(w.u_kt, w.v_kt),
      Math.abs(wrap180(windFromDeg(w.u_kt, w.v_kt) - heading))) * scaling;
    const sampled = current?.sample(from.lat, from.lon, t);
    if (sampled === null && request.strictCurrent) throw new CurrentGapError(current!.outsideTimeAxis(t));
    const c = sampled ?? { u_kt: 0, v_kt: 0 };
    const sog = stw + alongCourseComponentKt(c, heading);
    if (stw < MIN_SOG_KT || sog < MIN_SOG_KT) return null;
    const hours = dist / sog;
    const arrivalMs = t + hours * 3600_000;
    return arrivalMs <= deadlineMs ? { arrivalMs, waterNm: stw * hours } : null;
  };

  const nearestNode = (L: GraphLayer, p: { lat: number; lon: number }): [number, number] => [
    Math.max(0, Math.min(L.nlat - 1, Math.round((p.lat - L.lat0) / L.res))),
    Math.max(0, Math.min(L.nlon - 1, Math.round((p.lon - L.lon0) / L.res))),
  ];

  /** The node an end joins: in its layer, the nearest node or one in the rings round it. */
  const snap = (p: { lat: number; lon: number }, fromStart = false): number => {
    const L = endLayer(p);
    const [bi, bj] = nearestNode(L, p);
    let hasSeaConnection = false;
    const connects = (i: number, j: number) => {
      const node = { lat: L.lats[i]!, lon: L.lons[j]! };
      if (landMask && segmentCrossesLand(landMask, p, node)) return false;
      hasSeaConnection = true;
      if (fromStart && travel(p, node, departureMs) === null) return false;
      if (L.rowIn[i] && L.colIn[j]) return true;
      clipped = true;
      return false;
    };
    if (!connects(bi, bj)) {
      // A sea node can still be across a peninsula or a thin wall. Search
      // nearby rings for a node with a checked connection to the endpoint.
      for (let r = 1; r <= ENDPOINT_RINGS; r++) {
        for (let di = -r; di <= r; di++) {
          for (let dj = -r; dj <= r; dj++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = bi + di;
            const j = bj + dj;
            if (i < 0 || i >= L.nlat || j < 0 || j >= L.nlon) continue;
            if (connects(i, j)) return L.offset + i * L.nlon + j;
          }
        }
      }
      if (hasSeaConnection) throw noRoute();
      throw new Error('No sea node near start/finish');
    }
    return L.offset + bi * L.nlon + bj;
  };

  const startPoint = { lat: rounded(start.lat), lon: rounded(start.lon) };
  const finishPoint = { lat: rounded(finish.lat), lon: rounded(finish.lon) };
  const insideBounds = (p: { lat: number; lon: number }) => !bounds ||
    (p.lat >= bounds.minLat && p.lat <= bounds.maxLat && p.lon >= bounds.minLon && p.lon <= bounds.maxLon);
  if (!insideBounds(startPoint) || !insideBounds(finishPoint)) throw new SearchBoundsError('endpoint-outside');
  if (landMask && (isLand(landMask, startPoint.lat, startPoint.lon) || isLand(landMask, finishPoint.lat, finishPoint.lon))) {
    throw new Error('Start or finish is on land');
  }
  const startId = snap(startPoint, true);
  const finishId = snap(finishPoint);
  const connection = travel(startPoint, pointAt(startId), departureMs);
  if (!connection) throw noRoute();

  // earliest arrival labels + binary heap
  const arrival = new Float64Array(nodeCount).fill(Infinity);
  const parent = new Int32Array(nodeCount).fill(-1);
  const waterDistance = new Float64Array(nodeCount);
  arrival[startId] = connection.arrivalMs;
  waterDistance[startId] = connection.waterNm;

  const heap: Array<{ t: number; node: number }> = [{ t: connection.arrivalMs, node: startId }];
  const push = (t: number, node: number) => {
    heap.push({ t, node });
    let k = heap.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up]!.t <= heap[k]!.t) break;
      [heap[up], heap[k]] = [heap[k]!, heap[up]!];
      k = up;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]!.t < heap[m]!.t) m = l;
        if (r < heap.length && heap[r]!.t < heap[m]!.t) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };

  const settled = new Uint8Array(nodeCount);
  let settledCount = 0;
  let terminal: ReturnType<typeof travel> = null;
  // The finish-node state below is the loop's own (no closure writes it): the hot loop keeps it local.
  // The graph node the route reaches the finish from: the snapped finish node, unless its last leg fails.
  let endId = finishId;
  // Only after the snapped finish node's last leg failed: 1 for each other finish node not settled yet.
  let pendingEnds: Uint8Array | null = null;
  let pendingCount = 0;
  // When the search stops: never until alternative finish nodes open, then the snapped node's settle
  // time plus ALTERNATIVE_END_WINDOW_MS, and once one has joined, its arrival (no node settled from
  // then on arrives earlier).
  let stopAtMs = Infinity;

  /**
   * The last leg from graph node (i, j), left at `t`, to the finish: straight, in equal steps
   * no longer than the longest graph edge, each read at its own start and time like an edge.
   * Null when a step cannot be sailed or arrives past the deadline.
   */
  const legToFinish = (node: number, t: number) => {
    const from = pointAt(node);
    const step = layerOf(node).res;
    const steps = Math.max(1, Math.ceil(
      Math.hypot((finishPoint.lat - from.lat) / step, (finishPoint.lon - from.lon) / step) / LONGEST_EDGE_CELLS));
    let at = from;
    let arrivalMs = t;
    let waterNm = 0;
    for (let k = 1; k <= steps; k++) {
      const to = k === steps ? finishPoint : {
        lat: from.lat + ((finishPoint.lat - from.lat) * k) / steps,
        lon: from.lon + ((finishPoint.lon - from.lon) * k) / steps,
      };
      const step = travel(at, to, arrivalMs);
      if (!step) return null;
      arrivalMs = step.arrivalMs;
      waterNm += step.waterNm;
      at = to;
    }
    return { arrivalMs, waterNm };
  };

  /** The leg joining another finish node, settled at `t`, to the finish; null when it cannot. */
  const endLeg = (node: number, t: number) => {
    // Like snap(), a node outside searchBounds never joins an end: the box held the route back,
    // unless the node has no wind then (its leg could not have been sailed: as the clip branch).
    if (!searchable(node)) {
      if (wind.sample(latAt(node), lonAt(node), t) !== null) clipped = true;
      return null;
    }
    return legToFinish(node, t);
  };

  /**
   * The snapped finish node's last leg cannot be sailed when the search reaches it (no-go,
   * no wind there, or past the deadline), or the search ended without reaching it. Every
   * other node snap() would accept for the finish (within ENDPOINT_RINGS, with a land-free
   * leg to it) becomes a finish node: those already settled are joined now at their own
   * settle time, in settle order (`best`); the rest are marked pending (1) to be joined when
   * the search settles them. The route ends through the finish node arriving first (on a
   * tie, the one settled first).
   */
  const openAlternativeEnds = () => {
    const F = endLayer(finishPoint);
    const [bi, bj] = nearestNode(F, finishPoint);
    const pending = new Uint8Array(nodeCount);
    let count = 0;
    const settledEnds: number[] = [];
    for (let i = Math.max(0, bi - ENDPOINT_RINGS); i <= Math.min(F.nlat - 1, bi + ENDPOINT_RINGS); i++) {
      for (let j = Math.max(0, bj - ENDPOINT_RINGS); j <= Math.min(F.nlon - 1, bj + ENDPOINT_RINGS); j++) {
        const node = F.offset + i * F.nlon + j;
        if (node === finishId) continue;
        if (landMask && segmentCrossesLand(landMask, finishPoint, { lat: F.lats[i]!, lon: F.lons[j]! })) continue;
        if (settled[node]) {
          settledEnds.push(node);
        } else {
          pending[node] = 1;
          count += 1;
        }
      }
    }
    // A settled node's label is its settle time, and nodes settle in time order (equal times: by index).
    settledEnds.sort((a, b) => arrival[a]! - arrival[b]! || a - b);
    let best: { leg: NonNullable<ReturnType<typeof travel>>; node: number } | null = null;
    for (const node of settledEnds) {
      const leg = endLeg(node, arrival[node]!);
      if (leg && (!best || leg.arrivalMs < best.leg.arrivalMs)) best = { leg, node };
    }
    return { pending, count, best };
  };
  // The neighbour `to` (-1: none) that expanding `node` would travel to: in the graph, unsettled, sea,
  // and not across land. Expanding a node reads the weather (and current) there only for such a neighbour.
  const expandsTo = (node: number, to: number) => {
    if (to < 0) return false;
    if (settled[to]) return false;
    const toLat = latAt(to);
    const toLon = lonAt(to);
    if (landMask && isLand(landMask, toLat, toLon)) return false;
    // Even adjacent sea nodes can straddle land in a finer-resolution mask.
    return !(landMask && segmentCrossesLand(landMask, pointAt(node), { lat: toLat, lon: toLon }));
  };

  while (heap.length) {
    const { t, node } = pop();
    if (settled[node]) continue;
    if (t > deadlineMs) break;
    if (t >= stopAtMs) break;
    const L = layerOf(node);
    const i = Math.floor((node - L.offset) / L.nlon);
    const j = (node - L.offset) % L.nlon;
    // Outside searchBounds, a node the search would expand is never expanded: from here the bounds
    // confine the route. One whose expansion reads nothing (a dead end, or no wind there, so travel()
    // stops before the current) is settled and expanded as before: it moves nothing.
    let expands = false;
    if (!searchable(node) && wind.sample(L.lats[i]!, L.lons[j]!, t) !== null) {
      for (let k = 0; k < neighbourCount && !expands; k++) expands = expandsTo(node, neighbour(L, i, j, node, k));
    }
    if (expands) {
      settled[node] = 1;
      clipped = true;
      if (pendingEnds?.[node]) {
        pendingEnds[node] = 0;
        if (--pendingCount === 0) break;
      }
      continue;
    }
    settled[node] = 1;
    settledCount += 1;
    if (node === finishId) {
      terminal = travel(pointAt(finishId), finishPoint, t);
      if (terminal) break;
      const opened = openAlternativeEnds();
      pendingEnds = opened.pending;
      pendingCount = opened.count;
      stopAtMs = t + ALTERNATIVE_END_WINDOW_MS;
      if (opened.best) {
        terminal = opened.best.leg;
        endId = opened.best.node;
        stopAtMs = terminal.arrivalMs;
      }
      // Search on (expanding this node too) only while a finish node is still to settle.
      if (pendingCount === 0) break;
    } else if (pendingEnds?.[node]) {
      pendingEnds[node] = 0;
      const leg = endLeg(node, t);
      if (leg && (!terminal || leg.arrivalMs < terminal.arrivalMs)) {
        terminal = leg;
        endId = node;
        stopAtMs = leg.arrivalMs;
      }
      if (--pendingCount === 0) break;
    }

    const fromLat = L.lats[i]!;
    const fromLon = L.lons[j]!;

    for (let k = 0; k < neighbourCount; k++) {
      const nid = neighbour(L, i, j, node, k);
      if (!expandsTo(node, nid)) continue;
      const toLat = latAt(nid);
      const toLon = lonAt(nid);

      const edge = travel({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, t);
      if (!edge) continue;
      const { arrivalMs } = edge;
      if (arrivalMs < arrival[nid]!) {
        arrival[nid] = arrivalMs;
        waterDistance[nid] = waterDistance[node]! + edge.waterNm;
        parent[nid] = node;
        push(arrivalMs, nid);
      }
    }

    if (request.debug && settledCount % 500 === 0) {
      request.debug({
        settled: settledCount,
        bestToGoNm: Math.round(haversineNm(fromLat, fromLon, finish.lat, finish.lon) * 10) / 10,
        hoursOut: Math.round(((t - departureMs) / 3600_000) * 10) / 10,
      });
    }
  }

  // The search ended before settling the snapped finish node (the deadline came first, or it
  // cannot be reached): join the other finish nodes it did settle, as above.
  if (!terminal && !pendingEnds && !settled[finishId]) {
    const { best } = openAlternativeEnds();
    if (best) {
      terminal = best.leg;
      endId = best.node;
    }
  }

  if (!terminal || terminal.arrivalMs > deadlineMs) throw noRoute();

  // backtrack over grid nodes
  const gridPath: Array<{ lat: number; lon: number; timeMs: number; waterNm: number }> = [];
  for (let n = endId; n !== -1; n = parent[n]!) {
    gridPath.unshift({ lat: latAt(n), lon: lonAt(n), timeMs: arrival[n]!, waterNm: waterDistance[n]! });
  }

  // Keep the checked endpoint-to-grid connections. Replacing the first/last
  // grid nodes can create unchecked legs, even when both snap to one node.
  const path = [
    { ...startPoint, timeMs: departureMs, waterNm: 0 },
    ...gridPath,
    { ...finishPoint, timeMs: terminal.arrivalMs, waterNm: waterDistance[endId]! + terminal.waterNm },
  ].filter((p, k, points) => k === 0 ||
    p.lat !== points[k - 1]!.lat || p.lon !== points[k - 1]!.lon);
  // Keep real corners regardless of waypoint count. Check each shortcut from
  // the last retained point so consecutive removals cannot cut across land.
  const kept = [path[0]!];
  for (let k = 1; k < path.length - 1; k++) {
    const p = path[k]!;
    const prev = path[k - 1]!;
    const next = path[k + 1]!;
    const straightOn =
      Math.abs(wrap180(bearingDegTrue(prev.lat, prev.lon, p.lat, p.lon) -
        bearingDegTrue(p.lat, p.lon, next.lat, next.lon))) < 12;
    if (!straightOn || (landMask && segmentCrossesLand(landMask, kept.at(-1)!, next))) {
      kept.push(p);
    }
  }
  kept.push(path.at(-1)!);
  if (kept.length < 2 || terminal.arrivalMs <= departureMs) throw noRoute();

  const waypoints: Waypoint[] = kept.map((n, k) => ({
    id: `wp${k + 1}`,
    ...(k === 0 && start.name ? { name: start.name } : {}),
    ...(k === kept.length - 1 && finish.name ? { name: finish.name } : {}),
    lat: rounded(n.lat),
    lon: rounded(n.lon),
  }));

  // Rounding can move a checked point onto land or change the sampled leg.
  // Fail closed for the actual emitted coordinates, including two-point paths.
  if (landMask && waypoints.some((to, k) => k > 0 &&
    segmentCrossesLand(landMask, waypoints[k - 1]!, to))) {
    throw noRoute();
  }

  let distance = 0;
  for (let k = 1; k < kept.length; k++) {
    distance += haversineNm(kept[k - 1]!.lat, kept[k - 1]!.lon, kept[k]!.lat, kept[k]!.lon);
  }
  const durationH = (terminal.arrivalMs - departureMs) / 3600_000;
  const avgSog = distance / durationH;
  const avgStw = (waterDistance[endId]! + terminal.waterNm) / durationH;

  const route: Route = {
    schema_version: 1,
    route_id: `computed-${request.departureUtc.slice(0, 13).replace(/[-T:]/g, '')}-${polar.polar_id}`,
    name: `${start.name ?? 'Start'} → ${finish.name ?? 'Finish'} (computed)`,
    mode: 'computed',
    waypoints,
    // Through-water speeds remain available if this geometry is reused as a
    // drawn route. Routed audits use the per-leg durations below, including current.
    speeds_kt: {
      slow: Math.round(avgStw * 0.85 * 10) / 10,
      nominal: Math.round(avgStw * 10) / 10,
      fast: Math.round(avgStw * 1.15 * 10) / 10,
    },
    timing: {
      basis: 'routed', departure_utc: new Date(departureMs).toISOString(),
      legs: kept.slice(1).map((point, i) => {
        const prev = kept[i]!;
        const duration = point.timeMs - prev.timeMs;
        return {
          leg_id: `L${i + 1}`,
          duration_ms: { slow: duration / 0.85, nominal: duration, fast: duration / 1.15 },
          through_water_kt: (point.waterNm - prev.waterNm) * 3600_000 / duration,
          speed_over_ground_kt: haversineNm(prev.lat, prev.lon, point.lat, point.lon) * 3600_000 / duration,
        };
      }),
    },
    provenance: {
      engine_version: 'grid-dijkstra-v1',
      routing_request: {
        departure: request.departureUtc,
        polar_id: polar.polar_id,
        polar_scaling: scaling,
        wind_run: windGrid.run_id,
        current_run: currentGrid?.run_id ?? null,
        resolution_deg: Math.round(res * 1000) / 1000,
        // Only when the whole route (every point and every leg) lies in fine routing-index cells:
        // that index; and with end patches, their node spacing. A route partly outside the index
        // avoided only the 0.05° outline there, and says so.
        ...(landMask?.kind === 'land_cells' && allInFineCells(landMask, path) ? { land_index: landMask.fine_index_id } : {}),
        ...(layers.length > 1 ? { end_resolution_deg: Math.round(Math.min(...layers.slice(1).map((P) => P.res)) * 1e6) / 1e6 } : {}),
        // Only when searchBounds held the search back: the extent of the graph nodes it could use.
        ...(clipped ? { search_bounds: {
          minLat: rounded(lat0 + main.rowIn.indexOf(true) * res), maxLat: rounded(lat0 + main.rowIn.lastIndexOf(true) * res),
          minLon: rounded(lon0 + main.colIn.indexOf(true) * res), maxLon: rounded(lon0 + main.colIn.lastIndexOf(true) * res),
        } } : {}),
      },
      polar_ref: polar.polar_id,
      computed_at: toIso(Date.now()),
    },
  };

  return {
    route,
    arrival_utc: toIso(terminal.arrivalMs),
    duration_h: Math.round(durationH * 10) / 10,
    distance_nm: Math.round(distance * 10) / 10,
    avg_sog_kt: Math.round(avgSog * 100) / 100,
    steps_used: settledCount,
  };
}
