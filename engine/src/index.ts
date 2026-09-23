/**
 * @deepweather/engine — per-user analysis engine.
 *
 * Browser-safe core: no DOM, no Node APIs outside src/io/ and src/cli.ts.
 * Shared route-independent preparation lives in Python; small route-local
 * routing grids can also be assembled live in the browser.
 */

export { preparedSynopticCoverage, CHANNEL_PREPARED_COVERAGE } from './synopticCoverage.js';

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
export { routeBbox, passageMaxHours, planGrid } from './fetch/liveGrids.js';
export type { RouteBbox, GridPlan } from './fetch/liveGrids.js';
export { GridSampler, alongCourseKt, currentSetDeg, currentSpeedKt } from './grids.js';
export type { RegionGrid, GridSample } from './grids.js';
export { computeRoute } from './routing/isochrone.js';
export type { RoutingRequest, RoutingResult } from './routing/isochrone.js';
export { boatSpeedKt } from './routing/polar.js';
export type { Polar } from './routing/polar.js';
export { isLand, segmentCrossesLand } from './routing/landmask.js';
export type { LandMask } from './routing/landmask.js';
export { windowLandMask, snapToSea } from './routing/landmaskPack.js';
export type { PackedLandMaskMetadata, GeoBbox } from './routing/landmaskPack.js';
export { assessGates } from './hazards/tides.js';
export type { TidesDoc, GateDef, GateAssessment } from './hazards/tides.js';
export { diffFindings } from './diff.js';
export type { Changes, ChangeEntry } from './diff.js';
export { scanDepartures, candidateDepartures } from './window.js';
export type { WindowScan, WindowCandidate } from './window.js';
export { decodeTile } from './forecast/tileCodec.js';
export type { TileHeader, TileVariable, DecodedTile, TimeAxis } from './forecast/tileCodec.js';
export { TileForecastStore } from './forecast/tileStore.js';
export { HttpTileTransport, gunzip } from './forecast/httpTransport.js';
export { ScenarioBundleStore } from './forecast/scenarioStore.js';
export { MemoryTileCache } from './forecast/store.js';
export type {
  ForecastStore,
  TileTransport,
  TileCache,
  LatestDoc,
  LatestLayer,
  RunManifest,
  LayerInfo,
} from './forecast/store.js';
export type {
  PointForecast,
  EnsemblePointForecast,
  WavePointForecast,
  HazardPointForecast,
  CurrentPointForecast,
  TileRequestMeta,
} from './forecast/types.js';
export {
  TILE_DEG,
  tileIdFor,
  tileOrigin,
  tilesForBbox,
  axisTimesMs,
  nearestGridIndex,
  resampleToHourly,
} from './forecast/tileMath.js';
export type { Bbox, TileOrigin } from './forecast/tileMath.js';
export * from './types.js';
export { eventKeyForSystem, assignEventKeys, matchSystems } from './events.js';
export { encodeGrib2Message, gribRound, latticeCornersMicro } from './export/grib2.js';
export type { Grib2Field, GribLattice, GribLevel, LonConvention } from './export/grib2.js';
export { GRIB_DATASETS, GRIB_EXPORT_NOTICE, MS_TO_KT, gribDataset } from './export/gribDatasets.js';
export type {
  GribDatasetId,
  GribDatasetKind,
  GribDatasetSpec,
  GribVariableSpec,
} from './export/gribDatasets.js';
export { planGribExport, gribLattice, gribFileName, latticeBounds } from './export/exportPlan.js';
export type {
  GribAvailability,
  GribCheckpointRequest,
  GribDatasetPlan,
  GribExportPlan,
  GribExportRequest,
  GribManifests,
  GribPlannedStep,
  GribPlannedTile,
  GribStep,
} from './export/exportPlan.js';
export {
  runGribExport,
  gribExportSourceFromStore,
  GribExportError,
  FORECAST_UPDATED_MESSAGE,
} from './export/exportGrib.js';
export type {
  GribCheckpoint,
  GribCheckpointStep,
  GribExportErrorCode,
  GribExportFile,
  GribExportOptions,
  GribExportProgress,
  GribExportSource,
} from './export/exportGrib.js';
