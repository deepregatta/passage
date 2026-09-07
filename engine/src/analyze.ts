/**
 * Browser-safe analysis orchestration: the SAME pipeline the CLI runs, callable
 * from the viewer. In production this is per-user compute in the user's browser —
 * weather comes from precomputed forecast tiles on R2 (docs/forecast-tile-format.md),
 * downloaded per-route and cached locally; routing and audit never leave the browser.
 */

import { assembleFindings } from './findings.js';
import { renderBriefing, type Briefing } from './briefing.js';
import { buildPlume, writeSnapshot, type Plume, type SnapshotStore } from './snapshot.js';
import { deriveLegs, legMidpoints } from './route.js';
import { computeSchedules, parseUtc, toIso } from './eta.js';
import { passageMaxHours, routeBbox } from './fetch/liveGrids.js';
import type { ForecastStore } from './forecast/store.js';
import { ENGINE_VERSION } from './version.js';
import type { Findings, LimitsProfile, Route, SynopticFeatures, WarningsInput } from './types.js';

export interface AnalyzeOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  /** the only weather source: precomputed forecast tiles (or a fixture store in tests) */
  store: ForecastStore;
  warnings?: WarningsInput;
  /** prepared CMEMS current grid override; when absent the store's currents layer is used */
  currentGrid?: import('./grids.js').RegionGrid;
  /** HW/LW predictions + named tidal gates */
  tides?: import('./hazards/tides.js').TidesDoc;
  gates?: import('./hazards/tides.js').GateDef[];
  /** synoptic features from the prepared run — powers the weather story */
  synoptic?: SynopticFeatures;
  now?: () => number;
  onProgress?: (step: string) => void;
  /**
   * Widen the assessment window to at least this range (ISO dates). A departure
   * scan passes one window covering every candidate so all candidates read the
   * same tiles and hit the shared tile cache.
   */
  dateWindow?: { startDate: string; endDate: string };
}

/**
 * Audit sampling cell: leg-midpoint forecasts snap to this grid so that
 * near-identical routes (departure-scan candidates re-routed per departure)
 * resolve to the same sample coordinates and share cached tiles. 0.25° is the
 * native GFS/ECMWF resolution — snapping loses no model detail, and makes the
 * tile lookup an exact grid-point read.
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
  const { route, profile, departureUtc, store } = options;
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
  const startMs = parseUtc(`${startDate}T00:00Z`);
  const endMs = parseUtc(`${endDate}T00:00Z`) + 24 * 3600_000;
  const points = midpoints.map((p) => ({
    lat: snapToAuditCell(p.lat),
    lon: snapToAuditCell(p.lon),
  }));

  progress('reading forecast run manifest');
  await store.init();
  const layers = store.describe();

  progress('reading deterministic forecast tiles');
  const det = await store.getPointForecasts(points, startMs, endMs);
  const memberCount = layers.ensemble?.member_count;
  progress(memberCount ? `reading ${memberCount}-member ensemble tiles` : 'checking ensemble tiles');
  const ens = await store.getEnsembleForecasts(points, startMs, endMs);
  progress('reading wave tiles');
  const marine = await store.getWaveForecasts(points, startMs, endMs);
  progress('reading hazard and model-comparison tiles');
  const multi = await store.getHazardForecasts(points, startMs, endMs);

  let currentGrid = options.currentGrid;
  if (!currentGrid) {
    progress('reading current tiles');
    const start = legs[0]!.from;
    const finish = legs[legs.length - 1]!.to;
    try {
      currentGrid =
        (await store.getCurrentGrid(
          routeBbox(start, finish),
          departureUtc,
          passageMaxHours(start, finish),
        )) ?? undefined;
    } catch {
      currentGrid = undefined; // currents degrade gracefully; coverage reports it
    }
  }

  progress('evaluating against your limits');
  const nowMs = (options.now ?? Date.now)();
  const findings = assembleFindings({
    route,
    profile,
    departureUtc,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    ...(ens ? { legEnsembles: ens.forecasts, ensembleMeta: ens.meta } : {}),
    ...(marine ? { legMarine: marine.forecasts, marineMeta: marine.meta } : {}),
    ...(multi ? { multiModel: multi } : {}),
    ...(options.warnings ? { warnings: options.warnings } : {}),
    ...(currentGrid ? { currentGrid } : {}),
    ...(options.tides ? { tides: options.tides } : {}),
    ...(options.gates ? { gates: options.gates } : {}),
    ...(options.synoptic ? { synoptic: options.synoptic } : {}),
    engineVersion: ENGINE_VERSION,
    nowMs,
  });
  const briefing = renderBriefing(findings, options.synoptic);
  const plume = buildPlume(findings, ens?.forecasts ?? [], profile.max_gust_kt, multi?.byModel);
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
