import { computeRouteSchedules, parseUtc } from './eta.js';
import { passageMaxHours, routeBbox, type RouteBbox } from './fetch/liveGrids.js';
import { GridSampler, type RegionGrid } from './grids.js';
import { cachedContentHash, contentHash } from './hash.js';
import { forecastRunGone, type ForecastStore } from './forecast/store.js';
import { deriveLegs, legMidpoints } from './route.js';
import { CurrentGapError, SearchBoundsError, type SearchBounds } from './routing/isochrone.js';
import type { Route } from './types.js';

export interface CurrentInput {
  grid?: RegionGrid;
  provenance?: Record<string, unknown>;
  /**
   * Set only for a departure comparison on a prepared grid that left departures
   * out because its time axis does not reach them (selectComparisonCurrent,
   * resolveComparisonCurrent). Never part of a Check's input or record.
   */
  coverage?: ComparisonCoverage;
}

/** Which departures of a comparison a prepared grid carried, when it did not carry them all. */
export interface ComparisonCoverage {
  /** The latest departure the grid fully covers (its whole passage to the slow arrival). */
  last_covered_utc: string;
  /** The departures left out because the grid's time axis does not reach them, in order. */
  not_covered: string[];
}

interface Candidate { route: Route; departureUtc: string }

/**
 * Why `currentGridCovers` would reject a candidate: `time` when every sample it
 * lacks is at a time outside the grid's time axis (its passage outlasts the
 * grid), `space` when any sample at a time the grid covers has no value (or the
 * grid cannot be used at all), null when it covers the candidate.
 */
export function coverageGap(grid: RegionGrid, candidate: Candidate): 'time' | 'space' | null {
  if (grid.kind !== 'surface_current') return 'space';
  try {
    const sampler = new GridSampler(grid);
    const points = legMidpoints(deriveLegs(candidate.route));
    const schedules = computeRouteSchedules(candidate.route, candidate.departureUtc,
      (lat, lon, time) => sampler.sample(lat, lon, time));
    if (!schedules.length) return 'space';
    let beyond = false;
    for (const [i, schedule] of schedules.entries()) {
      const point = points[i]!;
      for (const time of [parseUtc(schedule.enter.fast), parseUtc(schedule.exit.slow), ...schedule.occupancy_hours.map(parseUtc)]) {
        if (sampler.sample(point.lat, point.lon, time) !== null) continue;
        if (!sampler.outsideTimeAxis(time)) return 'space';
        beyond = true;
      }
    }
    return beyond ? 'time' : null;
  } catch { return 'space'; }
}

/** Admission uses the same midpoint/hour and current-adjusted ETA as the audit. */
export function currentGridCovers(grid: RegionGrid, candidate: Candidate): boolean {
  if (grid.kind !== 'surface_current') return false;
  try {
    const sampler = new GridSampler(grid);
    const points = legMidpoints(deriveLegs(candidate.route));
    const schedules = computeRouteSchedules(candidate.route, candidate.departureUtc,
      (lat, lon, time) => sampler.sample(lat, lon, time));
    return schedules.length > 0 && schedules.every((schedule, i) => {
      const point = points[i]!;
      const times = [parseUtc(schedule.enter.fast), parseUtc(schedule.exit.slow),
        ...schedule.occupancy_hours.map(parseUtc)];
      return times.every(time => sampler.sample(point.lat, point.lon, time) !== null);
    });
  } catch { return false; }
}

// Hashing a regional grid costs a noticeable fraction of a second. A deep-frozen
// grid (the viewer freezes the prepared grid when it loads it, and every action's
// inputs are deep-frozen) cannot change, so its digest is computed once per grid
// object: for the input record, the progress check, routing and admission alike.
// A grid that could still change is hashed every time (cachedContentHash).
const gridDigest = (grid: RegionGrid): string => cachedContentHash(grid);

// Recorded as `fallback_reason` when an action does not use a prepared grid.
const NOT_COVERED = 'prepared grid does not cover every route/time sample';
const COMPUTED_ELSEWHERE = 'route was computed on another current grid';
const COMPUTED_ON_TILES = 'route was computed on tile currents';
const COMPUTED_WITHOUT = 'route was computed without currents';
const PREPARED_UNAVAILABLE = 'prepared grid the route was computed on is unavailable';
const NOT_A_CURRENT_GRID = 'prepared grid is not a surface current grid';
const DEPARTURE_OUTSIDE = 'prepared grid does not cover every departure time';
const ROUTER_GAP = 'router read a point or time outside the prepared grid';
const NO_ROUTE_INSIDE = 'no route found inside the prepared grid';
// Departure comparisons only (selectComparisonCurrent, resolveComparisonCurrent).
const FEWER_THAN_HALF = 'prepared grid covers fewer than half of the departure times';
const FIRST_NOT_ROUTED = 'first departure time has no route on the prepared grid';

/**
 * A departure comparison uses a prepared grid that does not reach all its
 * departures only when the grid fully covers at least this share of the
 * departures asked for (rounded up: 11 of a comparison's 21), the first one
 * included. Below it, every departure uses tile currents.
 */
export const MIN_COVERED_SHARE = 0.5;
/** How many departures of `requested` a prepared grid must fully cover (MIN_COVERED_SHARE). */
export const minCoveredDepartures = (requested: number): number => Math.ceil(requested * MIN_COVERED_SHARE);

/**
 * Why a departure of a comparison (or of its refinement) is not assessed: the
 * comparison runs on a prepared current grid that does not reach it.
 */
export const OUTSIDE_SCAN_CURRENT = 'This departure time leaves the current grid used by the rest of the comparison.';

/** The prepared-grid stamp a route computed on that grid carries (see selectRoutingCurrent). */
function routingRequest(route: Route): Record<string, unknown> | null {
  const request = route.provenance?.routing_request;
  return request && typeof request === 'object' ? request as Record<string, unknown> : null;
}

/**
 * A computed route is audited on a prepared grid only if it was routed on that
 * same grid. Returns why not, or null when the route admits it (or was drawn).
 * `digest` is null when no prepared grid is available to this audit.
 */
function routingMismatch(candidate: Candidate, digest: (() => string) | null): string | null {
  const request = routingRequest(candidate.route);
  if (!request) return null;
  if (request.current_source === 'prepared') {
    if (!digest) return PREPARED_UNAVAILABLE;
    return request.current_digest === digest() ? null : COMPUTED_ELSEWHERE;
  }
  return request.current_run == null ? COMPUTED_WITHOUT : COMPUTED_ON_TILES;
}

/** The audit's admission of a prepared grid for one route: routing source, then coverage. */
export function preparedCurrentAdmits(grid: RegionGrid, candidate: Candidate): boolean {
  return routingMismatch(candidate, () => gridDigest(grid)) === null && currentGridCovers(grid, candidate);
}

/** The box of the current tiles an audit reads when no prepared grid covers its routes. */
export function currentGridBbox(routes: Route[]): RouteBbox {
  const points = routes.flatMap(route => route.waypoints);
  return routeBbox(
    { lat: Math.min(...points.map(p => p.lat)), lon: Math.min(...points.map(p => p.lon)) },
    { lat: Math.max(...points.map(p => p.lat)), lon: Math.max(...points.map(p => p.lon)) },
  );
}

/** One source for the entire action, including all successful scan routes. No blending. */
export async function resolveCurrentInput(
  candidates: Candidate[], store: ForecastStore, prepared?: RegionGrid,
  preparedProvenance?: Record<string, unknown>,
): Promise<CurrentInput> {
  if (!candidates.length) return {};
  let digest: string | undefined;
  const preparedDigest = () => (digest ??= gridDigest(prepared!));
  const mismatch = candidates.map(candidate => routingMismatch(candidate, prepared ? preparedDigest : null))
    .find(reason => reason !== null) ?? null;
  if (prepared && !mismatch && candidates.every(candidate => currentGridCovers(prepared, candidate))) {
    return preparedInput(prepared, preparedProvenance, preparedDigest());
  }
  return tileCurrentInput(candidates, store, prepared, preparedProvenance, mismatch);
}

function preparedInput(prepared: RegionGrid, preparedProvenance: Record<string, unknown> | undefined, digest: string): CurrentInput {
  return { grid: prepared, provenance: {
    ...preparedProvenance, current_source: 'prepared', content_digest: digest, digest_algorithm: 'fnv1a64',
  } };
}

/**
 * The current input of a drawn-route comparison (scanDepartures without a
 * current input): as resolveCurrentInput, except that a prepared grid whose
 * time axis ends before some departures' passages do is still used when it
 * fully covers the first departure and at least MIN_COVERED_SHARE of the
 * departures asked for (`departures`, of which `candidates` are those with a
 * usable schedule), and nothing in it is missing at a time it covers. The
 * departures it does not reach are then listed in `coverage` (the comparison
 * does not assess them). Otherwise every departure uses tiles, for the reason
 * resolveCurrentInput records, or "fewer than half" for the share rule.
 */
export async function resolveComparisonCurrent(
  candidates: Candidate[], departures: readonly string[], store: ForecastStore, prepared?: RegionGrid,
  preparedProvenance?: Record<string, unknown>,
): Promise<CurrentInput> {
  if (!prepared || !candidates.length || prepared.kind !== 'surface_current') {
    return resolveCurrentInput(candidates, store, prepared, preparedProvenance);
  }
  let digest: string | undefined;
  const preparedDigest = () => (digest ??= gridDigest(prepared));
  if (candidates.some(candidate => routingMismatch(candidate, preparedDigest) !== null)) {
    return resolveCurrentInput(candidates, store, prepared, preparedProvenance);
  }
  const gaps = candidates.map(candidate => coverageGap(prepared, candidate));
  if (gaps.every(gap => gap === null)) return preparedInput(prepared, preparedProvenance, preparedDigest());
  const first = candidates.findIndex(candidate => candidate.departureUtc === departures[0]);
  // A place without a value, or the first departure not covered: tiles for every departure, as before.
  if (gaps.includes('space') || first < 0 || gaps[first] !== null) {
    return tileCurrentInput(candidates, store, prepared, preparedProvenance, NOT_COVERED);
  }
  const covered = candidates.filter((_, i) => gaps[i] === null);
  if (covered.length < minCoveredDepartures(departures.length)) {
    return tileCurrentInput(candidates, store, prepared, preparedProvenance, FEWER_THAN_HALF);
  }
  return { ...preparedInput(prepared, preparedProvenance, preparedDigest()), coverage: {
    last_covered_utc: covered[covered.length - 1]!.departureUtc,
    not_covered: candidates.filter((_, i) => gaps[i] === 'time').map(candidate => candidate.departureUtc),
  } };
}

/** The tile current input of an audit or drawn comparison, recording why a prepared grid was not used. */
async function tileCurrentInput(
  candidates: Candidate[], store: ForecastStore, prepared: RegionGrid | undefined,
  preparedProvenance: Record<string, unknown> | undefined, reason: string | null,
): Promise<CurrentInput> {
  const bbox = currentGridBbox(candidates.map(candidate => candidate.route));
  const startMs = Math.min(...candidates.map(c => parseUtc(c.departureUtc)));
  const endMs = Math.max(...candidates.map(c => {
    const schedules = computeRouteSchedules(c.route, c.departureUtc);
    return Math.max(parseUtc(schedules[schedules.length - 1]!.exit.slow),
      parseUtc(c.departureUtc) + passageMaxHours(c.route.waypoints[0]!, c.route.waypoints[c.route.waypoints.length - 1]!) * 3600_000);
  }));
  let grid: RegionGrid | undefined;
  try {
    grid = (await store.getCurrentGrid(bbox, new Date(startMs).toISOString(), Math.ceil((endMs - startMs) / 3600_000) + 1)) ?? undefined;
  } catch (error) {
    if (forecastRunGone(error) || (error as { code?: string })?.code === 'forecast-updated') throw error;
  }
  return { grid, provenance: {
    source: 'tiles',
    current_source: 'tiles',
    ...(grid ? { content_digest: contentHash(grid), digest_algorithm: 'fnv1a64' } : {}),
    ...(prepared ? rejectedPrepared(prepared, preparedProvenance, reason ?? NOT_COVERED)
      : reason === PREPARED_UNAVAILABLE ? { fallback_reason: PREPARED_UNAVAILABLE } : {}),
  } };
}

function rejectedPrepared(prepared: RegionGrid, preparedProvenance: Record<string, unknown> | undefined, reason: string) {
  return { fallback_reason: reason, rejected_prepared_run_id: prepared.run_id,
    rejected_prepared_input: preparedProvenance ?? { content_digest: gridDigest(prepared), digest_algorithm: 'fnv1a64' } };
}

const ROUTING_SELECTION_REASON = 'same current grid as scan routing';

export type RoutingOutcome<T> = { result: T; error?: undefined } | { result?: undefined; error: unknown };

export interface RoutingCurrentSelection<T> {
  /** The one current input for the action: hand it to every audit of these routes. */
  currentInput: CurrentInput;
  /** Each departure's route on that input, or the error routing it threw. */
  results: Map<string, RoutingOutcome<T>>;
}

const abortsAction = (error: unknown) =>
  Boolean(forecastRunGone(error)) || (error as { code?: string })?.code === 'forecast-updated';
// By code as well: a second copy of the engine module has its own class.
const currentGap = (error: unknown) =>
  error instanceof CurrentGapError || (error as { code?: string })?.code === 'current-gap';
const outsideBounds = (error: unknown): error is SearchBoundsError =>
  error instanceof SearchBoundsError || (error as { code?: string })?.code === 'search-bounds';

/** The far edge of one grid axis, kept on the inside of GridSampler's own coverage test. */
function axisEdge(origin: number, step: number, n: number): number {
  let far = origin + (n - 1) * step;
  for (let k = 0; k < 8 && (far - origin) / step > n - 1; k++) far -= step * Number.EPSILON * Math.max(1, Math.abs(far / step));
  return far;
}

/**
 * The lat/lon box of a grid, as RoutingRequest.searchBounds: every point
 * inside it is inside the grid for GridSampler (a sample there can still be
 * null: a cell without a value, or a time outside the axis).
 */
export function gridSearchBounds(grid: RegionGrid): SearchBounds {
  const lat1 = axisEdge(grid.lat0, grid.dlat, grid.nlat);
  const lon1 = axisEdge(grid.lon0, grid.dlon, grid.nlon);
  return { minLat: Math.min(grid.lat0, lat1), maxLat: Math.max(grid.lat0, lat1),
    minLon: Math.min(grid.lon0, lon1), maxLon: Math.max(grid.lon0, lon1) };
}

function axisCovers(grid: RegionGrid, departureUtc: string): boolean {
  const times = grid.time_axis.map(parseUtc);
  const at = parseUtc(departureUtc);
  return times.length > 0 && times.every(Number.isFinite) && Number.isFinite(at) && times[0]! <= at && at <= times[times.length - 1]!;
}

/** Why a departure added to a computed scan is not routed: its route would leave the scan's prepared grid. */
export const OUTSIDE_SELECTED_CURRENT = 'This departure time\'s route leaves the current grid used by the rest of the comparison.';

/**
 * Route more departures of an action whose current source is already chosen
 * (a refinement of a computed scan), on exactly that source and never another:
 * on a prepared grid in strict-current mode, with the audit's coverage test and
 * the same `routing_request` stamp as selectRoutingCurrent; a departure the
 * grid cannot carry fails with OUTSIDE_SELECTED_CURRENT instead of falling back
 * to tiles. On tiles (or no current), the same non-strict routing as the scan's.
 */
export function routeOnSelectedCurrent<T extends { route: Route }>(options: {
  departures: string[];
  currentInput: CurrentInput;
  route: (departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean, searchBounds?: SearchBounds) => T;
}): Map<string, RoutingOutcome<T>> {
  const { departures, currentInput } = options;
  const grid = currentInput.grid;
  const prepared = currentInput.provenance?.current_source === 'prepared' ? grid : undefined;
  const results = new Map<string, RoutingOutcome<T>>();
  const outside = () => ({ error: new Error(OUTSIDE_SELECTED_CURRENT) });
  const digest = prepared ? gridDigest(prepared) : null;
  const bounds = prepared ? gridSearchBounds(prepared) : undefined;
  for (const departureUtc of departures) {
    if (currentInput.provenance?.current_source === 'prepared' && (!prepared || !axisCovers(prepared, departureUtc))) {
      results.set(departureUtc, outside());
      continue;
    }
    try {
      const result = prepared ? options.route(departureUtc, prepared, true, bounds) : options.route(departureUtc, grid, false);
      if (!prepared) {
        results.set(departureUtc, { result });
        continue;
      }
      if (!currentGridCovers(prepared, { route: result.route, departureUtc })) {
        results.set(departureUtc, outside());
        continue;
      }
      results.set(departureUtc, { result: { ...result, route: { ...result.route, provenance: { ...result.route.provenance,
        routing_request: { ...routingRequest(result.route), current_source: 'prepared', current_digest: digest } } } } });
    } catch (error) {
      if (prepared && (currentGap(error) || outsideBounds(error))) results.set(departureUtc, outside());
      else if (abortsAction(error)) throw error;
      else results.set(departureUtc, { error });
    }
  }
  return results;
}

type RouteDeparture<T> = (departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean, searchBounds?: SearchBounds) => T;

export interface RoutingSelectionOptions<T> {
  departures: string[];
  /**
   * Routes one departure; `strictCurrent` must reach RoutingRequest.strictCurrent
   * and `searchBounds` RoutingRequest.searchBounds. A router that ignores the
   * bounds is not confined, and is admitted only where it never leaves the grid.
   */
  route: RouteDeparture<T>;
  tileGrid?: RegionGrid | null;
  prepared?: RegionGrid;
  preparedProvenance?: Record<string, unknown>;
}

/** A route computed on the prepared grid, stamped with it so that its Check admits that grid. */
function stampPrepared<T extends { route: Route }>(result: T, digest: string): T {
  const { route } = result;
  return { ...result, route: { ...route, provenance: { ...route.provenance,
    routing_request: { ...routingRequest(route), current_source: 'prepared', current_digest: digest } } } };
}

function onPrepared<T>(results: Map<string, RoutingOutcome<T>>, prepared: RegionGrid,
  preparedProvenance: Record<string, unknown> | undefined, digest: string, coverage?: ComparisonCoverage): RoutingCurrentSelection<T> {
  return { results, currentInput: { grid: prepared, provenance: {
    ...preparedProvenance, current_source: 'prepared', selection_reason: ROUTING_SELECTION_REASON,
    content_digest: digest, digest_algorithm: 'fnv1a64',
  }, ...(coverage ? { coverage } : {}) } };
}

/** Every departure routed on the tile grid over the router's normal area, not strict, recording why the prepared grid was not used. */
function onTiles<T>(options: RoutingSelectionOptions<T>, rejection: string | null): RoutingCurrentSelection<T> {
  const { departures, prepared, preparedProvenance } = options;
  const grid = options.tileGrid ?? undefined;
  const results = new Map<string, RoutingOutcome<T>>();
  for (const departureUtc of departures) {
    try {
      results.set(departureUtc, { result: options.route(departureUtc, grid, false) });
    } catch (error) {
      if (abortsAction(error)) throw error;
      results.set(departureUtc, { error });
    }
  }
  return { results, currentInput: { grid, provenance: {
    source: 'tiles', current_source: 'tiles', selection_reason: ROUTING_SELECTION_REASON,
    content_digest: grid ? contentHash(grid) : null, digest_algorithm: 'fnv1a64',
    ...(prepared ? rejectedPrepared(prepared, preparedProvenance, rejection ?? NOT_COVERED) : {}),
  } } };
}

/**
 * One current source for a Compute, by the audit's rule.
 * The prepared grid is used only when (1) its time axis holds every departure,
 * (2) the router, in strict-current mode and confined to the grid's box
 * (`searchBounds`: the intersection of its normal search area with the grid),
 * has both ends inside that box, never reads a point or time the grid lacks
 * and finds a route inside it, and (3) every routed candidate then passes the
 * audit's own coverage test (`currentGridCovers`). Anything else routes every
 * departure again on the tile grid, over the normal unclipped area: no route
 * mixes grids, and no action mixes routes from two grids. Routes on the
 * prepared grid record it in `routing_request`, so their Check admits that
 * grid and a route computed on tiles is checked on tiles; a route the box
 * confined also records the area it searched (`search_bounds`).
 * A departure comparison selects with selectComparisonCurrent instead.
 */
export function selectRoutingCurrent<T extends { route: Route }>(options: RoutingSelectionOptions<T>): RoutingCurrentSelection<T> {
  const { departures, prepared, preparedProvenance } = options;
  let rejection: string | null = null;
  if (prepared) {
    if (prepared.kind !== 'surface_current') rejection = NOT_A_CURRENT_GRID;
    else if (!departures.length || !departures.every(d => axisCovers(prepared, d))) rejection = DEPARTURE_OUTSIDE;
  }
  if (prepared && !rejection) {
    // Every departure on the prepared grid; the first gap moves the whole action to tiles, with its reason.
    const results = new Map<string, RoutingOutcome<T>>();
    const bounds = gridSearchBounds(prepared);
    for (const departureUtc of departures) {
      try {
        const result = options.route(departureUtc, prepared, true, bounds);
        if (!currentGridCovers(prepared, { route: result.route, departureUtc })) { rejection = NOT_COVERED; break; }
        results.set(departureUtc, { result });
      } catch (error) {
        if (currentGap(error)) { rejection = ROUTER_GAP; break; }
        // An end outside the grid is a point the router would read outside it.
        if (outsideBounds(error)) { rejection = error.reason === 'endpoint-outside' ? ROUTER_GAP : NO_ROUTE_INSIDE; break; }
        if (abortsAction(error)) throw error;
        results.set(departureUtc, { error });
      }
    }
    if (!rejection) {
      const digest = gridDigest(prepared);
      for (const [departureUtc, outcome] of results) {
        if (outcome.result) results.set(departureUtc, { result: stampPrepared(outcome.result, digest) });
      }
      return onPrepared(results, prepared, preparedProvenance, digest);
    }
  }
  return onTiles(options, rejection);
}

/**
 * One current source for a computed departure comparison (owner decision,
 * 2026-11-13: "let a departure comparison use the regional currents, covering
 * about 4 days instead of 5"). As selectRoutingCurrent, except that a prepared
 * grid whose time axis does not reach every departure is still used, for the
 * departures it fully covers, when:
 *
 * - it is a current grid and the first departure is inside its time axis;
 * - the first departure routes on it (strict, confined to its box) and passes
 *   the audit's coverage test: any failure there, of any kind, moves the whole
 *   comparison to tiles, with Compute's reason for it;
 * - nothing the router or the audit reads at a time the grid covers is missing
 *   (a place without a value would hit every departure): else tiles for all;
 * - at least MIN_COVERED_SHARE of the departures asked for are fully covered
 *   (routed on it and passing the coverage test): else tiles for all, "fewer
 *   than half". Decided before routing where it can be: a departure outside the
 *   axis is never routed, and routing stops once the share cannot be reached.
 *
 * A departure whose passage outlasts the axis, or that departs outside it, is
 * not assessed (OUTSIDE_SCAN_CURRENT) and is listed in `currentInput.coverage`;
 * one that finds no route inside the box, or no route at all, keeps its own
 * routing error and does not move the comparison to tiles. Every route on the
 * grid is stamped as Compute stamps it, so the first departure's route is
 * Compute's byte for byte except `computed_at` (the clock in its provenance),
 * and a picked departure's Check admits the same grid.
 * When the grid covers every departure the result is selectRoutingCurrent's,
 * except that a departure without a route inside the box no longer moves the
 * comparison to tiles. Never blends sources: no departure is assessed on tiles
 * while others are on the prepared grid.
 */
export function selectComparisonCurrent<T extends { route: Route }>(options: RoutingSelectionOptions<T>): RoutingCurrentSelection<T> {
  const { prepared, preparedProvenance } = options;
  if (!prepared) return onTiles(options, null);
  const outcome = routeComparisonOnPrepared(options, prepared);
  if (typeof outcome === 'string') return onTiles(options, outcome);
  return onPrepared(outcome.results, prepared, preparedProvenance, outcome.digest, outcome.coverage);
}

/** The prepared pass of selectComparisonCurrent: its routes, or why every departure goes to tiles. */
function routeComparisonOnPrepared<T extends { route: Route }>(options: RoutingSelectionOptions<T>, prepared: RegionGrid):
  string | { results: Map<string, RoutingOutcome<T>>; digest: string; coverage?: ComparisonCoverage } {
  const { departures } = options;
  if (prepared.kind !== 'surface_current') return NOT_A_CURRENT_GRID;
  if (!departures.length || !axisCovers(prepared, departures[0]!)) return DEPARTURE_OUTSIDE;
  const needed = minCoveredDepartures(departures.length);
  const inAxis = departures.map(departureUtc => axisCovers(prepared, departureUtc));
  let left = inAxis.filter(Boolean).length; // departures inside the axis not yet routed
  if (left < needed) return FEWER_THAN_HALF;
  const bounds = gridSearchBounds(prepared);
  let digest: string | undefined;
  const digestOf = () => (digest ??= gridDigest(prepared));
  const results = new Map<string, RoutingOutcome<T>>();
  const notCovered: string[] = [];
  let lastCovered: string | null = null;
  let covered = 0;
  const leaveOut = (departureUtc: string) => {
    notCovered.push(departureUtc);
    results.set(departureUtc, { error: new Error(OUTSIDE_SCAN_CURRENT) });
  };
  for (const [index, departureUtc] of departures.entries()) {
    const first = index === 0;
    if (!inAxis[index]) { leaveOut(departureUtc); continue; }
    if (covered + left < needed) return FEWER_THAN_HALF; // the share can no longer be reached: route no more
    left -= 1;
    try {
      const result = options.route(departureUtc, prepared, true, bounds);
      const gap = coverageGap(prepared, { route: result.route, departureUtc });
      if (gap === 'space' || (gap === 'time' && first)) return NOT_COVERED;
      if (gap === 'time') { leaveOut(departureUtc); continue; }
      results.set(departureUtc, { result: stampPrepared(result, digestOf()) });
      covered += 1;
      lastCovered = departureUtc;
    } catch (error) {
      if (currentGap(error)) {
        if (first || (error as { beyondTimeAxis?: boolean }).beyondTimeAxis !== true) return ROUTER_GAP;
        leaveOut(departureUtc);
        continue;
      }
      if (outsideBounds(error)) {
        // An end outside the grid is a point the router would read outside it.
        if (error.reason === 'endpoint-outside') return ROUTER_GAP;
        if (first) return NO_ROUTE_INSIDE;
        results.set(departureUtc, { error });
        continue;
      }
      if (abortsAction(error)) throw error;
      if (first) return FIRST_NOT_ROUTED;
      results.set(departureUtc, { error });
    }
  }
  if (covered < needed) return FEWER_THAN_HALF;
  return { results, digest: digestOf(), ...(notCovered.length ? { coverage: { last_covered_utc: lastCovered!, not_covered: notCovered } } : {}) };
}
