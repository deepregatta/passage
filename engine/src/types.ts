/** Shared engine types, mirroring contracts/*.schema.json. */

export interface Waypoint {
  id: string;
  name?: string;
  lat: number;
  lon: number;
}

export interface SpeedsKt {
  slow: number;
  nominal: number;
  fast: number;
}

export interface Route {
  schema_version: number;
  route_id: string;
  name: string;
  mode: 'fixed' | 'user' | 'computed';
  waypoints: Waypoint[];
  speeds_kt?: SpeedsKt;
  polar_ref?: string;
  polar_scaling?: number;
  provenance?: Record<string, unknown>;
}

export interface Leg {
  leg_id: string;
  from: Waypoint;
  to: Waypoint;
  distance_nm: number;
  bearing_deg_true: number;
  /** cumulative distance from route start to leg END, nm */
  dist_end_nm: number;
}

export interface SamplePoint {
  point_id: string;
  leg_id: string;
  lat: number;
  lon: number;
  dist_from_start_nm: number;
}

export interface LimitsProfile {
  schema_version: number;
  profile_id: string;
  label: string;
  declared: true;
  max_sustained_kt: { default: number; upwind?: number; reach?: number; downwind?: number };
  max_gust_kt: number;
  max_wave_height_m?: number;
  max_steepness?: number;
  cross_sea_flag?: boolean;
  min_visibility_nm?: number | null;
  night_ok?: boolean;
  scenario_fraction_floor?: number;
  approaching_ratio?: number;
}

export type PointOfSail = 'upwind' | 'reach' | 'downwind';

export type VerdictState = 'within' | 'approaching' | 'exceeds' | 'insufficient' | 'warning_active';

export type SourceKind =
  | 'deterministic'
  | 'ensemble'
  | 'currents'
  | 'tides'
  | 'warning'
  | 'synoptic'
  | 'emulated';

/** contracts/warnings.schema.json */
export interface WarningsDoc {
  schema_version: number;
  fetched_at: string;
  source: { mode: 'live' | 'fixture' | 'synthetic'; name?: string };
  feed_status: 'ok' | 'unavailable' | 'parse-degraded';
  bulletins: Array<{
    zone_id: string;
    zone_name?: string;
    kind: string;
    severity?: string | null;
    valid_from: string;
    valid_to: string;
    raw_text: string;
    parse_confidence?: number;
  }>;
  coverage_note?: string;
}

export interface WarningsInput {
  doc: WarningsDoc;
  /** marine-zone ids this route crosses (config/route-zones.json) */
  routeZoneIds: string[];
  /** reference recorded in findings.inputs (path or feed id) */
  ref: string;
}

export interface SynopticTrackPoint {
  step_h?: number;
  valid_time: string;
  lat: number;
  lon: number;
  center_hpa: number;
}

export interface SynopticFeatures {
  schema_version?: number;
  run_id: string;
  generated_at?: string;
  systems: Array<{
    system_id: string;
    kind: 'low' | 'high';
    track: SynopticTrackPoint[];
    deepening_hpa_per_24h?: number | null;
    motion?: { dir_deg: number; speed_kt: number } | null;
  }>;
  regimes: Array<{ regime_id: string; rule_id: string }>;
  route_transitions?: unknown[];
  chart_captions?: Array<Record<string, unknown>>;
}

export type CoverageStatus =
  | 'assessed'
  | 'assessed_emulated'
  | 'partially_assessed'
  | 'not_assessed';

export interface CapabilityCoverage {
  capability: string;
  status: CoverageStatus;
  detail?: string;
  evidence_ids?: string[];
}

export interface CausalEvent {
  event_id: string;
  event_key?: string;
  name: string;
  kind: 'low' | 'high' | 'front' | 'regime' | 'gate' | 'wind_against_current';
  system_id?: string;
  route_intersection?: {
    leg_id: string;
    window_start: string;
    window_end: string;
    /** difference between slow and fast ETA at the end of the affected leg */
    eta_sensitivity: number;
  };
  consequence: {
    register_plain: string;
    register_pro: string;
    evidence_ids: string[];
  };
}

export interface Evidence {
  evidence_id: string;
  rule_id: string;
  model: string | null;
  run: string | null;
  leg_id: string | null;
  valid_time: string | null;
  value: unknown;
  limit: unknown;
  units: string | null;
  source_kind: SourceKind;
  member_fraction?: { exceed: number; total: number };
  bulletin_ref?: {
    source: string;
    issued_at: string;
    valid_from: string;
    valid_to: string;
    zone_ids: string[];
  };
}

export type ConditionStatus = 'ok' | 'approaching' | 'exceeded' | 'unknown';

export interface WaveHour {
  hs_m: number | null;
  period_s: number | null;
  /** H/L with deep-water L = gT²/2π */
  steepness: number | null;
  wind_wave_h_m: number | null;
  swell_h_m: number | null;
  cross_sea_deg: number | null;
  cross_sea_significant: boolean;
  wind_against_swell: boolean;
}

export interface LegHour {
  valid_time: string;
  wind_kt: number | null;
  gust_kt: number | null;
  wind_dir_deg: number | null;
  twa_deg: number | null;
  point_of_sail: PointOfSail | null;
  limit_status: {
    sustained: ConditionStatus;
    gust: ConditionStatus;
    wave?: ConditionStatus;
    steepness?: ConditionStatus;
    visibility?: ConditionStatus;
  };
  /** raw ensemble scenario-exceedance counts vs declared limits */
  exceedance?: {
    sustained: { exceed: number; total: number } | null;
    gust: { exceed: number; total: number } | null;
  };
  /** sea state (deterministic wave model only — no wave ensembles) */
  waves?: WaveHour | null;
  cape_jkg?: number | null;
  squall_potential?: 'low' | 'elevated' | 'high' | null;
  visibility_nm?: number | null;
  fog_risk?: boolean;
  /** max-min sustained wind across deterministic models, kt */
  model_spread_kt?: number | null;
  /** surface current at the leg midpoint (CMEMS region grid) */
  current?: {
    u_kt: number;
    v_kt: number;
    speed_kt: number;
    set_deg: number;
    along_kt: number;
    cross_kt: number;
    wind_against_current: boolean;
  } | null;
}

export interface LegFinding {
  leg_id: string;
  name: string;
  distance_nm: number;
  bearing_deg_true: number;
  eta_range: { slow: string; nominal: string; fast: string };
  enter_range: { slow: string; nominal: string; fast: string };
  sog_kt: SpeedsKt;
  hours: LegHour[];
  /** where conditions were sampled (leg midpoint) — traceability */
  sample_point: { lat: number; lon: number };
  /** hours where deterministic models diverge beyond tolerance */
  divergent_hours?: Array<{ valid_time: string; values: Record<string, number>; spread_kt: number }>;
}

export interface FindingsEvent {
  kind: string;
  leg_id?: string;
  window?: { from: string; to: string };
  refs: string[];
}

export interface GateResult {
  gate_id: string;
  name: string;
  leg_id: string;
  distance_nm: number;
  reference_port: string;
  transit: { from: string; to: string };
  favorable: Array<{ from: string; to: string }>;
  status: 'ok' | 'marginal' | 'conflict';
  rule_text: string;
}

export interface Findings {
  schema_version: number;
  snapshot_id: string;
  route_id: string;
  profile_id: string;
  departure_utc: string;
  engine_version: string;
  generated_at: string;
  inputs: {
    prepared_run_id: string | null;
    synoptic_run_id?: string | null;
    /** provenance of every tile-layer read (exact run ids and cycles) */
    forecast_tiles: Array<Record<string, unknown>>;
    warnings_ref: string | null;
    route_hash: string;
    profile_hash: string;
  };
  legs: LegFinding[];
  events: FindingsEvent[];
  verdict: {
    state: VerdictState;
    driver_evidence_id: string | null;
    warning_override: { active: boolean; bulletin_ref: string | null };
  };
  evidence: Evidence[];
  coverage?: CapabilityCoverage[];
  causal_events?: CausalEvent[];
  /** named tidal-gate assessments */
  gates?: GateResult[];
  unsupported_hazards: string[];
}
