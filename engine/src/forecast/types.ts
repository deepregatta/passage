/**
 * Point-forecast shapes consumed by the findings assembler, and the request
 * metadata recorded in findings provenance. Data comes from precomputed PFT1
 * forecast tiles (docs/forecast-tiles-spec.md) — run ids and cycles are exact,
 * never inferred.
 */

export interface PointForecast {
  lat: number;
  lon: number;
  times: string[];
  wind_kt: Array<number | null>;
  gust_kt: Array<number | null>;
  wind_dir_deg: Array<number | null>;
}

export interface EnsemblePointForecast {
  lat: number;
  lon: number;
  times: string[];
  /** [member][timeIdx], member 0 = control */
  wind_kt_members: Array<Array<number | null>>;
  gust_kt_members: Array<Array<number | null>>;
}

export interface WavePointForecast {
  lat: number;
  lon: number;
  times: string[];
  hs_m: Array<number | null>;
  period_s: Array<number | null>;
  dir_deg: Array<number | null>;
  wind_wave_h_m: Array<number | null>;
  wind_wave_period_s: Array<number | null>;
  wind_wave_dir_deg: Array<number | null>;
  swell_h_m: Array<number | null>;
  swell_period_s: Array<number | null>;
  swell_dir_deg: Array<number | null>;
}

export interface HazardPointForecast {
  lat: number;
  lon: number;
  times: string[];
  wind_kt: Array<number | null>;
  gust_kt: Array<number | null>;
  wind_dir_deg: Array<number | null>;
  visibility_m: Array<number | null>;
  cape_jkg: Array<number | null>;
  temp_c: Array<number | null>;
  dew_point_c: Array<number | null>;
  precip_mm: Array<number | null>;
}

export interface CurrentPointForecast {
  lat: number;
  lon: number;
  times: string[];
  current_kt: Array<number | null>;
  current_dir_deg: Array<number | null>;
}

/** Provenance of one tile-layer read, recorded in findings.inputs.forecast_tiles. */
export interface TileRequestMeta {
  source: 'tiles' | 'fixture';
  layer: string;
  model: string;
  run_id: string;
  /** exact provider cycle, e.g. "2026-07-13T06:00Z" — not inferred */
  cycle: string;
  resolution_deg: number;
  member_count?: number;
  tiles: string[];
  fetched_at: string;
  /** how many of `tiles` were served from the local cache */
  cached_tiles: number;
  points: number;
}
