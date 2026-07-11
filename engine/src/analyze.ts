/**
 * Browser-safe analysis orchestration: the SAME pipeline the CLI runs, callable
 * from the viewer. In production this is per-user compute in the user's browser —
 * Open-Meteo is fetched from the user's own IP, prepared shared data from R2.
 */

import { assembleFindings } from './findings.js';
import { renderBriefing, type Briefing } from './briefing.js';
import { buildPlume, writeSnapshot, type Plume, type SnapshotStore } from './snapshot.js';
import { deriveLegs, legMidpoints } from './route.js';
import { computeSchedules, parseUtc, toIso } from './eta.js';
import {
  fetchEnsembleForecasts,
  fetchMarineForecasts,
  fetchMultiModelForecasts,
  fetchPointForecasts,
  type CacheStore,
  type OpenMeteoOptions,
} from './fetch/openMeteo.js';
import { ENGINE_VERSION } from './version.js';
import type { Findings, LimitsProfile, Route, WarningsInput } from './types.js';

export interface AnalyzeOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  warnings?: WarningsInput;
  /** injected transport (tests/fixtures); defaults to live Open-Meteo */
  fetchFn?: typeof fetch;
  cache?: CacheStore;
  now?: () => number;
  /** per-API base URL overrides (fixture mode) */
  baseUrls?: Partial<Record<'forecast' | 'ensemble' | 'marine' | 'multimodel', string>>;
  onProgress?: (step: string) => void;
}

export interface AnalyzeResult {
  findings: Findings;
  briefing: Briefing;
  plume: Plume;
}

export async function runAnalysis(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { route, profile, departureUtc } = options;
  if (!route.speeds_kt) throw new Error('Route needs speeds_kt (polar ETAs land with routing)');
  const progress = options.onProgress ?? (() => {});

  const legs = deriveLegs(route);
  const midpoints = legMidpoints(legs);
  const schedules = computeSchedules(legs, route.speeds_kt, departureUtc);
  const startDate = toIso(parseUtc(departureUtc)).slice(0, 10);
  const endDate = toIso(
    parseUtc(schedules[schedules.length - 1]!.exit.slow) + 24 * 3600_000,
  ).slice(0, 10);
  const points = midpoints.map((p) => ({ lat: p.lat, lon: p.lon }));

  const opts = (api: keyof NonNullable<AnalyzeOptions['baseUrls']>): OpenMeteoOptions => ({
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.baseUrls?.[api] ? { baseUrl: options.baseUrls[api] } : {}),
  });

  progress('fetching deterministic forecast');
  const det = await fetchPointForecasts(points, startDate, endDate, opts('forecast'));
  progress('fetching 51-member ensemble');
  const ens = await fetchEnsembleForecasts(points, startDate, endDate, opts('ensemble'));
  progress('fetching wave model');
  const marine = await fetchMarineForecasts(points, startDate, endDate, opts('marine'));
  progress('fetching model comparison');
  const multi = await fetchMultiModelForecasts(points, startDate, endDate, opts('multimodel'));

  progress('evaluating against your limits');
  const nowMs = (options.now ?? Date.now)();
  const findings = assembleFindings({
    route,
    profile,
    departureUtc,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    legEnsembles: ens.forecasts,
    ensembleMeta: ens.meta,
    legMarine: marine.forecasts,
    marineMeta: marine.meta,
    multiModel: multi,
    ...(options.warnings ? { warnings: options.warnings } : {}),
    engineVersion: ENGINE_VERSION,
    nowMs,
  });
  const briefing = renderBriefing(findings);
  const plume = buildPlume(findings, ens.forecasts, profile.max_gust_kt, multi.byModel);
  return { findings, briefing, plume };
}

export async function persistSnapshot(
  store: SnapshotStore,
  result: AnalyzeResult,
  route: Route,
  nowMs: number,
): Promise<string> {
  const { snapshot_id } = await writeSnapshot(
    store,
    result.findings,
    result.briefing,
    { route, plume: result.plume },
    nowMs,
  );
  return snapshot_id;
}
