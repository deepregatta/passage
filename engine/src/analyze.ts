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
import type { Findings, LimitsProfile, Route, SynopticFeatures, WarningsInput } from './types.js';

export interface AnalyzeOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  warnings?: WarningsInput;
  /** prepared CMEMS current grid (loaded by the caller: fs in CLI, /data fetch in browser) */
  currentGrid?: import('./grids.js').RegionGrid;
  /** HW/LW predictions + named tidal gates (M10) */
  tides?: import('./hazards/tides.js').TidesDoc;
  gates?: import('./hazards/tides.js').GateDef[];
  /** synoptic features from the prepared run (M8) — powers the weather story */
  synoptic?: SynopticFeatures;
  /** injected transport (tests/fixtures); defaults to live Open-Meteo */
  fetchFn?: typeof fetch;
  cache?: CacheStore;
  now?: () => number;
  /** per-API base URL overrides (fixture mode) */
  baseUrls?: Partial<Record<'forecast' | 'ensemble' | 'marine' | 'multimodel', string>>;
  onProgress?: (step: string) => void;
  /**
   * Widen the fetch window to at least this range (ISO dates). A departure scan
   * passes one window covering every candidate so all candidates share the same
   * request URLs and hit the scan-wide cache instead of Open-Meteo's quota.
   */
  dateWindow?: { startDate: string; endDate: string };
}

/**
 * Audit sampling cell: leg-midpoint forecasts snap to this grid so that
 * near-identical routes (departure-scan candidates re-routed per departure)
 * resolve to the same sample coordinates and share cached responses.
 * 0.25° is the native ECMWF IFS resolution — snapping loses no model detail.
 */
const AUDIT_CELL_DEG = 0.25;

function snapToAuditCell(value: number): number {
  return Math.round(value / AUDIT_CELL_DEG) * AUDIT_CELL_DEG;
}

export interface AnalyzeResult {
  findings: Findings;
  briefing: Briefing;
  plume: Plume;
  snapshotInputs: {
    warnings?: WarningsInput['doc'];
    synoptic?: SynopticFeatures;
    tides?: import('./hazards/tides.js').TidesDoc;
  };
}

export async function runAnalysis(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { route, profile, departureUtc } = options;
  if (!route.speeds_kt) throw new Error('Route needs speeds_kt (polar ETAs land with routing)');
  const progress = options.onProgress ?? (() => {});

  const legs = deriveLegs(route);
  const midpoints = legMidpoints(legs);
  const schedules = computeSchedules(legs, route.speeds_kt, departureUtc);
  const derivedStart = toIso(parseUtc(departureUtc)).slice(0, 10);
  const derivedEnd = toIso(
    parseUtc(schedules[schedules.length - 1]!.exit.slow) + 24 * 3600_000,
  ).slice(0, 10);
  // ISO dates compare lexicographically; the override may only widen the window
  const startDate =
    options.dateWindow && options.dateWindow.startDate < derivedStart
      ? options.dateWindow.startDate
      : derivedStart;
  const endDate =
    options.dateWindow && options.dateWindow.endDate > derivedEnd
      ? options.dateWindow.endDate
      : derivedEnd;
  const points = midpoints.map((p) => ({
    lat: snapToAuditCell(p.lat),
    lon: snapToAuditCell(p.lon),
  }));

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
    ...(options.currentGrid ? { currentGrid: options.currentGrid } : {}),
    ...(options.tides ? { tides: options.tides } : {}),
    ...(options.gates ? { gates: options.gates } : {}),
    ...(options.synoptic ? { synoptic: options.synoptic } : {}),
    engineVersion: ENGINE_VERSION,
    nowMs,
  });
  const briefing = renderBriefing(findings, options.synoptic);
  const plume = buildPlume(findings, ens.forecasts, profile.max_gust_kt, multi.byModel);
  return {
    findings,
    briefing,
    plume,
    snapshotInputs: {
      ...(options.warnings ? { warnings: options.warnings.doc } : {}),
      ...(options.synoptic ? { synoptic: options.synoptic } : {}),
      ...(options.tides ? { tides: options.tides } : {}),
    },
  };
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
    { route, plume: result.plume, ...result.snapshotInputs },
    nowMs,
  );
  return snapshot_id;
}
