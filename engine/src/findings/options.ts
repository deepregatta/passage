import type { RegionGrid } from '../grids.js';
import type { GateDef, TidesDoc } from '../hazards/tides.js';
import type { EnsemblePointForecast, HazardPointForecast, PointForecast, TileRequestMeta, WavePointForecast } from '../forecast/types.js';
import type { LimitsProfile, Route, SynopticFeatures, WarningsInput } from '../types.js';

export interface AssembleOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  /** one forecast per leg (midpoint), index-aligned with derived legs */
  legForecasts: PointForecast[];
  requestMeta: TileRequestMeta[];
  /** ensemble forecasts per leg midpoint; index-aligned with legs */
  legEnsembles?: EnsemblePointForecast[];
  ensembleMeta?: TileRequestMeta;
  /** wave forecasts per leg midpoint */
  legMarine?: WavePointForecast[];
  marineMeta?: TileRequestMeta;
  /** per-model deterministic forecasts for hazards + disagreement (GFS + ECMWF layers) */
  multiModel?: { byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] };
  /** official marine warnings (live or emulated inputs) */
  warnings?: WarningsInput;
  /** prepared CMEMS surface-current region grid */
  currentGrid?: RegionGrid;
  /** tidal gates: HW/LW predictions + named-gate timing rules */
  tides?: TidesDoc;
  gates?: GateDef[];
  /** prepared synoptic system tracks used for conservative route attribution */
  synoptic?: SynopticFeatures;
  engineVersion: string;
  /** injected clock (ms) for byte-stable goldens */
  nowMs: number;
}
