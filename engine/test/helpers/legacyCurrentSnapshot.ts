/**
 * The saved check pinned by `test/fixtures/legacy-current-snapshot/`: a two-leg
 * Cherbourg passage audited on a small hourly prepared current grid carrying the
 * IBI dataset id, written by the engine before checks recorded the current grid's
 * time step (commit f75248e). Values are invented. The engine is a parameter so the
 * fixture is generated from that commit's engine (`scripts/make-legacy-current-snapshot.ts`)
 * and the same check can be repeated with this one (`legacySnapshot.test.ts`).
 *
 * The fixture is legacy evidence: never regenerate it from a newer engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssembleOptions } from '../../src/findings/options.js';
import type { RegionGrid } from '../../src/grids.js';
import { alongEachLeg } from './samplePoints.js';

export const LEGACY_DEPARTURE = '2026-07-20T06:00:00Z';
export const LEGACY_NOW_MS = Date.parse('2026-07-19T18:00:00Z');
export const LEGACY_FILES = ['snapshot.json', 'findings.json', 'briefing.json', 'route.json', 'decision-inputs.json'] as const;

const HOUR = 3_600_000;

/** An hourly grid over the first two legs, rotating so the along-track current changes sign. */
function hourlyGrid(): RegionGrid {
  const nlat = 4, nlon = 6;
  const start = Date.parse('2026-07-20T05:00:00Z');
  const time_axis = Array.from({ length: 12 }, (_, h) => new Date(start + h * HOUR).toISOString().replace('.000Z', 'Z'));
  const u_kt: number[] = [];
  const v_kt: number[] = [];
  for (let t = 0; t < time_axis.length; t++) {
    const angle = (2 * Math.PI * t) / 12.4;
    for (let k = 0; k < nlat * nlon; k++) {
      u_kt.push(Math.round(1.6 * Math.cos(angle) * 100) / 100);
      v_kt.push(Math.round(0.6 * Math.sin(angle) * 100) / 100);
    }
  }
  return {
    schema_version: 1, kind: 'surface_current', run_id: 'cmems-ibi-20260719T19Z', generated_at: '2026-07-19T19:30:00Z',
    lat0: 49.5, lon0: -2.2, dlat: 0.1, dlon: 0.1, nlat, nlon, time_axis, u_kt, v_kt,
    source: { mode: 'live', dataset_id: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', resolution_deg: 0.1, fetched_at: '2026-07-19T19:20:00Z' },
  };
}

/** The audit options of the legacy check. `root` holds `config/`. */
export function legacyOptions(root: string, contentHash: (value: unknown) => string): AssembleOptions {
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const route = read('config/routes/cherbourg-plymouth.json');
  route.route_id = 'cherbourg-hague-legacy-current';
  route.passage_id = 'legacy-current-intent';
  route.waypoints = route.waypoints.slice(0, 3);
  const profile = read('config/profiles/default-limits.json');
  const times = Array.from({ length: 10 }, (_, h) => new Date(Date.parse(LEGACY_DEPARTURE) - HOUR + h * HOUR).toISOString().replace('.000Z', 'Z'));
  const forecast = (lat: number, lon: number) => ({
    lat, lon, times,
    wind_kt: times.map((_, h) => 10 + (h % 4)), gust_kt: times.map((_, h) => 15 + (h % 4)), wind_dir_deg: times.map(() => 250),
  });
  const grid = hourlyGrid();
  return {
    route, profile, departureUtc: LEGACY_DEPARTURE, nowMs: LEGACY_NOW_MS, engineVersion: '0.2.0',
    requestMeta: [{ source: 'fixture', layer: 'weather', model: 'scenario', run_id: 'scenario-legacy', cycle: 'scenario', resolution_deg: 0.25, tiles: [], fetched_at: '2026-07-19T18:00:00.000Z', cached_tiles: 0, points: 2 }],
    legForecasts: [forecast(49.69, -1.74), forecast(49.75, -1.94)],
    currentGrid: grid,
    currentProvenance: {
      source: 'prepared-artifact', layer: 'currents', model: grid.source.dataset_id, run_id: grid.run_id,
      fetched_at: grid.source.fetched_at, artifact_ref: 'runs/cmems-ibi-20260719T19Z/current_grid.json',
      current_source: 'prepared', content_digest: contentHash(grid), digest_algorithm: 'fnv1a64',
    },
  } as unknown as AssembleOptions;
}

/**
 * The same check's inputs in the shape this engine audits (one forecast per
 * audit sample point since engine semantics `passage-audit-4`): each leg's
 * series copied to every sample point of that leg. Only for repeating the
 * check with this engine; `legacyOptions` stays what the legacy engine read.
 */
export function legacyOptionsForThisEngine(root: string, contentHash: (value: unknown) => string): AssembleOptions {
  const { legForecasts, ...options } = legacyOptions(root, contentHash) as unknown as AssembleOptions & { legForecasts: AssembleOptions['pointForecasts'] };
  return { ...options, pointForecasts: alongEachLeg(options.route, legForecasts) };
}
