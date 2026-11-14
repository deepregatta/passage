import type { ForecastStore } from '../forecast/store.js';
import type { RegionGrid } from '../grids.js';
import type { GateDef, TidesDoc } from '../hazards/tides.js';
import type { EnsemblePointForecast, HazardPointForecast, PointForecast, TileRequestMeta, WavePointForecast } from '../forecast/types.js';
import type { LimitsProfile, Route, SynopticFeatures, WarningsInput } from '../types.js';

export interface AssembleOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  /**
   * One forecast per audit sample point, index-aligned with
   * auditSamplePoints(deriveLegs(route)) (auditSampling.ts): every point of
   * every leg, in order. Engine semantics `passage-audit-4`; checks saved
   * earlier archived one forecast per leg as `legForecasts` and are never
   * recomputed.
   */
  pointForecasts: PointForecast[];
  requestMeta: TileRequestMeta[];
  /** Pinned run descriptions also control the briefing's next-run schedule. */
  forecastRuns?: ReturnType<ForecastStore['describe']>;
  /** ensemble forecasts per audit sample point, index-aligned as `pointForecasts` */
  pointEnsembles?: EnsemblePointForecast[];
  ensembleMeta?: TileRequestMeta;
  /** wave forecasts per audit sample point, index-aligned as `pointForecasts` */
  pointMarine?: WavePointForecast[];
  marineMeta?: TileRequestMeta;
  /** per-model deterministic forecasts for hazards + disagreement (GFS + ECMWF layers), per audit sample point */
  multiModel?: { byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] };
  /** official marine warnings (live or emulated inputs) */
  warnings?: WarningsInput;
  /** prepared CMEMS surface-current region grid */
  currentGrid?: RegionGrid;
  currentProvenance?: Record<string, unknown>;
  inputRecords?: Array<Record<string, unknown>>;
  /** tidal gates: HW/LW predictions + named-gate timing rules */
  tides?: TidesDoc;
  gates?: GateDef[];
  /** prepared synoptic system tracks used for conservative route attribution */
  synoptic?: SynopticFeatures;
  engineVersion: string;
  /** injected clock (ms) for byte-stable goldens */
  nowMs: number;
}
