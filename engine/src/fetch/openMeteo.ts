/**
 * Open-Meteo point-forecast client (browser-safe: global fetch, injected cache).
 *
 * Discipline vendored from coachregatta analysis/src/coachregatta_analysis/weather.py
 * (2026-07-11): cache keyed on rounded cell + model + window, exponential backoff on
 * 429/5xx, batched multi-point requests.
 *
 * Note: Open-Meteo does not expose the model run id; we record fetched_at and an
 * inferred cycle (marked as inferred). Exact cycles arrive with the prepared-run
 * pipeline (M8, ECMWF open data).
 */

export interface PointForecast {
  lat: number;
  lon: number;
  times: string[];
  wind_kt: Array<number | null>;
  gust_kt: Array<number | null>;
  wind_dir_deg: Array<number | null>;
}

export interface ForecastRequestMeta {
  api: 'forecast';
  model: string;
  request_digest: string;
  fetched_at: string;
  run_inferred: string;
  cached: boolean;
  points: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface OpenMeteoOptions {
  model?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  cache?: CacheStore;
  /** injected clock for deterministic tests */
  now?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** cached forecasts older than this are re-fetched (new runs supersede) */
  cacheMaxAgeMs?: number;
}

const HOURLY_VARS = ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m'] as const;
const ENSEMBLE_VARS = ['wind_speed_10m', 'wind_gusts_10m'] as const;
const DEFAULT_MODEL = 'ecmwf_ifs025';

import { fnv1a64Hex } from '../hash.js';

export class MemoryCacheStore implements CacheStore {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

/** Shared fetch with cell cache + exponential backoff on 429/5xx. */
async function fetchCachedWithBackoff(
  url: string,
  cachePrefix: string,
  options: OpenMeteoOptions,
): Promise<{ raw: string; cached: boolean; digest: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const cache = options.cache ?? new MemoryCacheStore();
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 3 * 3600_000;

  const digest = fnv1a64Hex(url);
  const cacheKey = `${cachePrefix}_${digest}`;

  const cachedEntry = await cache.get(cacheKey);
  if (cachedEntry) {
    try {
      const entry = JSON.parse(cachedEntry) as { fetched_at: string; body: unknown };
      if (now() - Date.parse(entry.fetched_at) < cacheMaxAgeMs) {
        return { raw: JSON.stringify(entry.body), cached: true, digest };
      }
    } catch {
      // fall through to live fetch
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetchFn(url);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`Open-Meteo HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}: ${await response.text()}`);
    }
    const raw = await response.text();
    await cache.set(
      cacheKey,
      JSON.stringify({ fetched_at: new Date(now()).toISOString(), body: JSON.parse(raw) }),
    );
    return { raw, cached: false, digest };
  }
  throw lastError ?? new Error('Open-Meteo fetch failed');
}

export async function fetchPointForecasts(
  points: Array<{ lat: number; lon: number }>,
  startDate: string,
  endDate: string,
  options: OpenMeteoOptions = {},
): Promise<{ forecasts: PointForecast[]; meta: ForecastRequestMeta }> {
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? 'https://api.open-meteo.com/v1/forecast';
  const now = options.now ?? Date.now;

  const lats = points.map((p) => p.lat.toFixed(2));
  const lons = points.map((p) => p.lon.toFixed(2));
  const url =
    `${baseUrl}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${HOURLY_VARS.join(',')}&models=${model}` +
    `&wind_speed_unit=kn&timezone=UTC&start_date=${startDate}&end_date=${endDate}`;

  const { raw, cached, digest } = await fetchCachedWithBackoff(url, `om-forecast_${model}`, options);

  const parsed = JSON.parse(raw) as unknown;
  const locations = Array.isArray(parsed) ? parsed : [parsed];
  if (locations.length !== points.length) {
    throw new Error(
      `Open-Meteo returned ${locations.length} locations for ${points.length} requested points`,
    );
  }

  const forecasts: PointForecast[] = locations.map((loc: any, i: number) => {
    const hourly = loc?.hourly;
    if (!hourly?.time) throw new Error(`Open-Meteo response missing hourly block (point ${i})`);
    return {
      lat: points[i]!.lat,
      lon: points[i]!.lon,
      // Open-Meteo returns minute-precision local-less times ("2026-07-12T06:00", UTC by request)
      times: (hourly.time as string[]).map((t) => (t.endsWith('Z') ? t : `${t}:00Z`)),
      wind_kt: hourly.wind_speed_10m ?? [],
      gust_kt: hourly.wind_gusts_10m ?? [],
      wind_dir_deg: hourly.wind_direction_10m ?? [],
    };
  });

  return {
    forecasts,
    meta: {
      api: 'forecast',
      model,
      request_digest: digest,
      fetched_at: new Date(now()).toISOString(),
      run_inferred: inferEcmwfCycle(now()),
      cached,
      points: points.length,
    },
  };
}

export interface EnsemblePointForecast {
  lat: number;
  lon: number;
  times: string[];
  /** [member][timeIdx], member 0 = control */
  wind_kt_members: Array<Array<number | null>>;
  gust_kt_members: Array<Array<number | null>>;
}

export interface EnsembleRequestMeta {
  api: 'ensemble';
  model: string;
  members: number;
  request_digest: string;
  fetched_at: string;
  run_inferred: string;
  cached: boolean;
  points: number;
}

/**
 * Ensemble forecast (ECMWF ENS via Open-Meteo): 51 members (control + 50) with
 * wind speed AND gusts (verified live 2026-07-11). Used for raw scenario-exceedance
 * fractions — never presented as calibrated probabilities (brief §6).
 */
export async function fetchEnsembleForecasts(
  points: Array<{ lat: number; lon: number }>,
  startDate: string,
  endDate: string,
  options: OpenMeteoOptions = {},
): Promise<{ forecasts: EnsemblePointForecast[]; meta: EnsembleRequestMeta }> {
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? 'https://ensemble-api.open-meteo.com/v1/ensemble';
  const now = options.now ?? Date.now;

  const lats = points.map((p) => p.lat.toFixed(2));
  const lons = points.map((p) => p.lon.toFixed(2));
  const url =
    `${baseUrl}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${ENSEMBLE_VARS.join(',')}&models=${model}` +
    `&wind_speed_unit=kn&timezone=UTC&start_date=${startDate}&end_date=${endDate}`;

  const { raw, cached, digest } = await fetchCachedWithBackoff(url, `om-ensemble_${model}`, options);

  const parsed = JSON.parse(raw) as unknown;
  const locations = Array.isArray(parsed) ? parsed : [parsed];
  if (locations.length !== points.length) {
    throw new Error(
      `Open-Meteo ensemble returned ${locations.length} locations for ${points.length} points`,
    );
  }

  let memberCount = 0;
  const forecasts: EnsemblePointForecast[] = locations.map((loc: any, i: number) => {
    const hourly = loc?.hourly;
    if (!hourly?.time) throw new Error(`Ensemble response missing hourly block (point ${i})`);
    const windKeys = memberKeys(hourly, 'wind_speed_10m');
    const gustKeys = memberKeys(hourly, 'wind_gusts_10m');
    memberCount = Math.max(memberCount, windKeys.length);
    return {
      lat: points[i]!.lat,
      lon: points[i]!.lon,
      times: (hourly.time as string[]).map((t) => (t.endsWith('Z') ? t : `${t}:00Z`)),
      wind_kt_members: windKeys.map((k) => hourly[k] ?? []),
      gust_kt_members: gustKeys.map((k) => hourly[k] ?? []),
    };
  });

  return {
    forecasts,
    meta: {
      api: 'ensemble',
      model,
      members: memberCount,
      request_digest: digest,
      fetched_at: new Date(now()).toISOString(),
      run_inferred: inferEcmwfCycle(now()),
      cached,
      points: points.length,
    },
  };
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

export interface MultiModelRequestMeta {
  api: 'forecast-multimodel';
  models: string[];
  request_digest: string;
  fetched_at: string;
  run_inferred: string;
  cached: boolean;
  points: number;
}

const HAZARD_VARS = [
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'visibility',
  'cape',
  'temperature_2m',
  'dew_point_2m',
  'precipitation',
] as const;

export const DETERMINISTIC_MODELS = ['ecmwf_ifs025', 'gfs_global', 'icon_eu'] as const;

/**
 * Multi-model deterministic fetch: one request, per-model suffixed hourly keys
 * (verified live 2026-07-11: all vars present for all 3 models except ECMWF
 * visibility, which stays null and falls back to ICON-EU/GFS downstream).
 */
export async function fetchMultiModelForecasts(
  points: Array<{ lat: number; lon: number }>,
  startDate: string,
  endDate: string,
  options: OpenMeteoOptions = {},
): Promise<{ byModel: Record<string, HazardPointForecast[]>; meta: MultiModelRequestMeta }> {
  const models = [...DETERMINISTIC_MODELS];
  const baseUrl = options.baseUrl ?? 'https://api.open-meteo.com/v1/forecast';
  const now = options.now ?? Date.now;

  const lats = points.map((p) => p.lat.toFixed(2));
  const lons = points.map((p) => p.lon.toFixed(2));
  const url =
    `${baseUrl}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${HAZARD_VARS.join(',')}&models=${models.join(',')}` +
    `&wind_speed_unit=kn&timezone=UTC&start_date=${startDate}&end_date=${endDate}`;

  const { raw, cached, digest } = await fetchCachedWithBackoff(url, 'om-multimodel', options);
  const parsed = JSON.parse(raw) as unknown;
  const locations = Array.isArray(parsed) ? parsed : [parsed];
  if (locations.length !== points.length) {
    throw new Error(`Multi-model returned ${locations.length} locations for ${points.length}`);
  }

  const byModel: Record<string, HazardPointForecast[]> = {};
  for (const model of models) {
    byModel[model] = locations.map((loc: any, i: number) => {
      const hourly = loc?.hourly;
      if (!hourly?.time) throw new Error(`Multi-model response missing hourly (point ${i})`);
      const series = (base: string) => hourly[`${base}_${model}`] ?? hourly[base] ?? [];
      return {
        lat: points[i]!.lat,
        lon: points[i]!.lon,
        times: (hourly.time as string[]).map((t) => (t.endsWith('Z') ? t : `${t}:00Z`)),
        wind_kt: series('wind_speed_10m'),
        gust_kt: series('wind_gusts_10m'),
        wind_dir_deg: series('wind_direction_10m'),
        visibility_m: series('visibility'),
        cape_jkg: series('cape'),
        temp_c: series('temperature_2m'),
        dew_point_c: series('dew_point_2m'),
        precip_mm: series('precipitation'),
      };
    });
  }

  return {
    byModel,
    meta: {
      api: 'forecast-multimodel',
      models,
      request_digest: digest,
      fetched_at: new Date(now()).toISOString(),
      run_inferred: inferEcmwfCycle(now()),
      cached,
      points: points.length,
    },
  };
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

export interface MarineRequestMeta {
  api: 'marine';
  model: string;
  request_digest: string;
  fetched_at: string;
  cached: boolean;
  points: number;
  note: string;
}

const MARINE_VARS = [
  'wave_height',
  'wave_period',
  'wave_direction',
  'wind_wave_height',
  'wind_wave_period',
  'wind_wave_direction',
  'swell_wave_height',
  'swell_wave_period',
  'swell_wave_direction',
] as const;

/** Marine API: deterministic wave model only — no wave ensembles exist (brief §6.5). */
export async function fetchMarineForecasts(
  points: Array<{ lat: number; lon: number }>,
  startDate: string,
  endDate: string,
  options: OpenMeteoOptions = {},
): Promise<{ forecasts: WavePointForecast[]; meta: MarineRequestMeta }> {
  const baseUrl = options.baseUrl ?? 'https://marine-api.open-meteo.com/v1/marine';
  const now = options.now ?? Date.now;

  const lats = points.map((p) => p.lat.toFixed(2));
  const lons = points.map((p) => p.lon.toFixed(2));
  const url =
    `${baseUrl}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${MARINE_VARS.join(',')}&timezone=UTC&start_date=${startDate}&end_date=${endDate}`;

  const { raw, cached, digest } = await fetchCachedWithBackoff(url, 'om-marine', options);
  const parsed = JSON.parse(raw) as unknown;
  const locations = Array.isArray(parsed) ? parsed : [parsed];
  if (locations.length !== points.length) {
    throw new Error(`Marine returned ${locations.length} locations for ${points.length}`);
  }

  const forecasts: WavePointForecast[] = locations.map((loc: any, i: number) => {
    const hourly = loc?.hourly;
    if (!hourly?.time) throw new Error(`Marine response missing hourly (point ${i})`);
    return {
      lat: points[i]!.lat,
      lon: points[i]!.lon,
      times: (hourly.time as string[]).map((t) => (t.endsWith('Z') ? t : `${t}:00Z`)),
      hs_m: hourly.wave_height ?? [],
      period_s: hourly.wave_period ?? [],
      dir_deg: hourly.wave_direction ?? [],
      wind_wave_h_m: hourly.wind_wave_height ?? [],
      wind_wave_period_s: hourly.wind_wave_period ?? [],
      wind_wave_dir_deg: hourly.wind_wave_direction ?? [],
      swell_h_m: hourly.swell_wave_height ?? [],
      swell_period_s: hourly.swell_wave_period ?? [],
      swell_dir_deg: hourly.swell_wave_direction ?? [],
    };
  });

  return {
    forecasts,
    meta: {
      api: 'marine',
      model: 'best_match',
      request_digest: digest,
      fetched_at: new Date(now()).toISOString(),
      cached,
      points: points.length,
      note: 'deterministic wave model only — no wave ensembles available',
    },
  };
}

/** Member series keys in stable order: base (control), then _member01.._memberNN. */
function memberKeys(hourly: Record<string, unknown>, base: string): string[] {
  const members = Object.keys(hourly)
    .filter((k) => k.startsWith(`${base}_member`))
    .sort();
  return hourly[base] !== undefined ? [base, ...members] : members;
}

/**
 * Infer the most recent ECMWF cycle plausibly available on Open-Meteo
 * (cycles 00/06/12/18Z, ~8 h publication delay). Marked inferred — not authoritative.
 */
export function inferEcmwfCycle(nowMs: number): string {
  const DELAY_H = 8;
  const t = new Date(nowMs - DELAY_H * 3600_000);
  const cycleHour = Math.floor(t.getUTCHours() / 6) * 6;
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}T${String(cycleHour).padStart(2, '0')}Z (inferred)`;
}
