import { computeRouteSchedules, parseUtc } from './eta.js';
import { passageMaxHours, routeBbox, type RouteBbox } from './fetch/liveGrids.js';
import { GridSampler, type RegionGrid } from './grids.js';
import { contentHash } from './hash.js';
import { forecastRunGone, type ForecastStore } from './forecast/store.js';
import { deriveLegs, legMidpoints } from './route.js';
import { CurrentGapError } from './routing/isochrone.js';
import type { Route } from './types.js';

export interface CurrentInput {
  grid?: RegionGrid;
  provenance?: Record<string, unknown>;
}

interface Candidate { route: Route; departureUtc: string }

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

// Hashing a regional grid costs a noticeable fraction of a second. A frozen
// grid (every action's inputs are deep-frozen) cannot change, so its digest is
// computed once for the progress check, admission and the input record.
const frozenDigests = new WeakMap<RegionGrid, string>();
function gridDigest(grid: RegionGrid): string {
  const frozen = [grid, grid.u_kt, grid.v_kt, grid.time_axis, grid.source].every(part => Object.isFrozen(part));
  if (!frozen) return contentHash(grid);
  let digest = frozenDigests.get(grid);
  if (digest === undefined) frozenDigests.set(grid, digest = contentHash(grid));
  return digest;
}

// Recorded as `fallback_reason` when an action does not use a prepared grid.
const NOT_COVERED = 'prepared grid does not cover every route/time sample';
const COMPUTED_ELSEWHERE = 'route was computed on another current grid';
const COMPUTED_ON_TILES = 'route was computed on tile currents';
const COMPUTED_WITHOUT = 'route was computed without currents';
const PREPARED_UNAVAILABLE = 'prepared grid the route was computed on is unavailable';
const NOT_A_CURRENT_GRID = 'prepared grid is not a surface current grid';
const DEPARTURE_OUTSIDE = 'prepared grid does not cover every departure time';
const ROUTER_GAP = 'router read a point or time outside the prepared grid';

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
    return { grid: prepared, provenance: {
      ...preparedProvenance, current_source: 'prepared', content_digest: preparedDigest(), digest_algorithm: 'fnv1a64',
    } };
  }
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
    ...(prepared ? rejectedPrepared(prepared, preparedProvenance, mismatch ?? NOT_COVERED)
      : mismatch === PREPARED_UNAVAILABLE ? { fallback_reason: PREPARED_UNAVAILABLE } : {}),
  } };
}

function rejectedPrepared(prepared: RegionGrid, preparedProvenance: Record<string, unknown> | undefined, reason: string) {
  return { fallback_reason: reason, rejected_prepared_run_id: prepared.run_id,
    rejected_prepared_input: preparedProvenance ?? { content_digest: contentHash(prepared), digest_algorithm: 'fnv1a64' } };
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
  route: (departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) => T;
}): Map<string, RoutingOutcome<T>> {
  const { departures, currentInput } = options;
  const grid = currentInput.grid;
  const prepared = currentInput.provenance?.current_source === 'prepared' ? grid : undefined;
  const results = new Map<string, RoutingOutcome<T>>();
  const outside = () => ({ error: new Error(OUTSIDE_SELECTED_CURRENT) });
  const digest = prepared ? gridDigest(prepared) : null;
  for (const departureUtc of departures) {
    if (currentInput.provenance?.current_source === 'prepared' && (!prepared || !axisCovers(prepared, departureUtc))) {
      results.set(departureUtc, outside());
      continue;
    }
    try {
      const result = options.route(departureUtc, prepared ?? grid, Boolean(prepared));
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
      if (prepared && currentGap(error)) results.set(departureUtc, outside());
      else if (abortsAction(error)) throw error;
      else results.set(departureUtc, { error });
    }
  }
  return results;
}

/**
 * One current source for a Compute or a computed scan, by the audit's rule.
 * The prepared grid is used only when (1) its time axis holds every departure,
 * (2) the router, in strict-current mode, never reads a point or time the grid
 * lacks, and (3) every routed candidate then passes the audit's own coverage
 * test (`currentGridCovers`). Any gap routes every departure again on the tile
 * grid: no route mixes grids, and no action mixes routes from two grids.
 * Routes on the prepared grid record it in `routing_request`, so their Check
 * admits that grid and a route computed on tiles is checked on tiles.
 */
export function selectRoutingCurrent<T extends { route: Route }>(options: {
  departures: string[];
  /** Routes one departure; `strictCurrent` must reach RoutingRequest.strictCurrent. */
  route: (departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean) => T;
  tileGrid?: RegionGrid | null;
  prepared?: RegionGrid;
  preparedProvenance?: Record<string, unknown>;
}): RoutingCurrentSelection<T> {
  const { departures, prepared, preparedProvenance } = options;
  // Routes every departure on one grid; on the prepared grid, stops at the first gap with its reason.
  const routeAll = (grid: RegionGrid | undefined, strict: boolean) => {
    const results = new Map<string, RoutingOutcome<T>>();
    for (const departureUtc of departures) {
      try {
        const result = options.route(departureUtc, grid, strict);
        if (strict && !currentGridCovers(grid!, { route: result.route, departureUtc })) return NOT_COVERED;
        results.set(departureUtc, { result });
      } catch (error) {
        if (strict && currentGap(error)) return ROUTER_GAP;
        if (abortsAction(error)) throw error;
        results.set(departureUtc, { error });
      }
    }
    return results;
  };
  let rejection: string | null = null;
  if (prepared) {
    if (prepared.kind !== 'surface_current') rejection = NOT_A_CURRENT_GRID;
    else if (!departures.length || !departures.every(d => axisCovers(prepared, d))) rejection = DEPARTURE_OUTSIDE;
  }
  if (prepared && !rejection) {
    const results = routeAll(prepared, true);
    if (typeof results === 'string') rejection = results;
    else {
      const digest = gridDigest(prepared);
      for (const [departureUtc, outcome] of results) {
        if (!outcome.result) continue;
        const { route } = outcome.result;
        results.set(departureUtc, { result: { ...outcome.result, route: { ...route, provenance: { ...route.provenance,
          routing_request: { ...routingRequest(route), current_source: 'prepared', current_digest: digest } } } } });
      }
      return { results, currentInput: { grid: prepared, provenance: {
        ...preparedProvenance, current_source: 'prepared', selection_reason: ROUTING_SELECTION_REASON,
        content_digest: digest, digest_algorithm: 'fnv1a64',
      } } };
    }
  }
  const grid = options.tileGrid ?? undefined;
  return { results: routeAll(grid, false) as Map<string, RoutingOutcome<T>>, currentInput: { grid, provenance: {
    source: 'tiles', current_source: 'tiles', selection_reason: ROUTING_SELECTION_REASON,
    content_digest: grid ? contentHash(grid) : null, digest_algorithm: 'fnv1a64',
    ...(prepared ? rejectedPrepared(prepared, preparedProvenance, rejection ?? NOT_COVERED) : {}),
  } } };
}
