/**
 * @deepweather/engine — per-user analysis engine.
 *
 * Browser-safe core: no DOM, no Node APIs outside src/io/ and src/cli.ts.
 * Everything route-independent, authenticated, or gridded lives in the Python
 * `analysis/` package instead; this engine consumes its prepared artifacts.
 */

export { ENGINE_VERSION } from './version.js';

export { runAnalysis, persistSnapshot } from './analyze.js';
export type { AnalyzeOptions, AnalyzeResult } from './analyze.js';
export { deriveLegs, deriveSamplePoints, legMidpoints, totalDistanceNm } from './route.js';
export { computeSchedules, parseUtc, toIso } from './eta.js';
export { parseGpx } from './gpx.js';
export { renderBriefing } from './briefing.js';
export type { Briefing, BriefingSection } from './briefing.js';
export { buildPlume, writeSnapshot } from './snapshot.js';
export type { Plume, SnapshotStore } from './snapshot.js';
export { MemoryCacheStore } from './fetch/openMeteo.js';
export type { CacheStore } from './fetch/openMeteo.js';
export { GridSampler, alongCourseKt, currentSetDeg, currentSpeedKt } from './grids.js';
export type { RegionGrid, GridSample } from './grids.js';
export { diffFindings } from './diff.js';
export type { Changes, ChangeEntry } from './diff.js';
export { scanDepartures, candidateDepartures } from './window.js';
export type { WindowScan, WindowCandidate } from './window.js';
export * from './types.js';
