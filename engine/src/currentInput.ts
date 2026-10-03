import { computeRouteSchedules, parseUtc } from './eta.js';
import { passageMaxHours, routeBbox } from './fetch/liveGrids.js';
import { GridSampler, type RegionGrid } from './grids.js';
import { contentHash } from './hash.js';
import { forecastRunGone, type ForecastStore } from './forecast/store.js';
import { deriveLegs, legMidpoints } from './route.js';
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

/** One source for the entire action, including all successful scan routes. No blending. */
export async function resolveCurrentInput(
  candidates: Candidate[], store: ForecastStore, prepared?: RegionGrid,
  preparedProvenance?: Record<string, unknown>,
): Promise<CurrentInput> {
  if (!candidates.length) return {};
  if (prepared && candidates.every(candidate => currentGridCovers(prepared, candidate))) {
    return { grid: prepared, provenance: {
      ...preparedProvenance, current_source: 'prepared', content_digest: contentHash(prepared), digest_algorithm: 'fnv1a64',
    } };
  }
  const points = candidates.flatMap(candidate => candidate.route.waypoints);
  const bbox = routeBbox(
    { lat: Math.min(...points.map(p => p.lat)), lon: Math.min(...points.map(p => p.lon)) },
    { lat: Math.max(...points.map(p => p.lat)), lon: Math.max(...points.map(p => p.lon)) },
  );
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
    ...(prepared ? { fallback_reason: 'prepared grid does not cover every route/time sample', rejected_prepared_run_id: prepared.run_id,
      rejected_prepared_input: preparedProvenance ?? { content_digest: contentHash(prepared), digest_algorithm: 'fnv1a64' } } : {}),
  } };
}
