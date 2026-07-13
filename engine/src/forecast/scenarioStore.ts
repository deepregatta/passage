/**
 * Fixture-only ForecastStore over the synthetic scenario bundles produced by
 * `deepweather-analysis scenario` (forecast.json / ensemble.json / marine.json
 * / multimodel.json per scenario). These bundles predate the tile pipeline and
 * keep its per-location hourly JSON shape; this adapter is the ONLY place that
 * shape survives. Never used in production — the browser and CLI live paths
 * read PFT1 tiles via TileForecastStore.
 */

import { contentHash } from '../hash.js';
import type { RegionGrid } from '../grids.js';
import type { Bbox } from './tileMath.js';
import type { ForecastStore, LayerInfo } from './store.js';
import type {
  EnsemblePointForecast,
  HazardPointForecast,
  PointForecast,
  TileRequestMeta,
  WavePointForecast,
} from './types.js';

type BundleName = 'forecast' | 'ensemble' | 'marine' | 'multimodel';

export interface ScenarioBundleStoreOptions {
  /** returns the parsed bundle JSON, or null when the scenario lacks it */
  loadBundle: (name: BundleName) => Promise<unknown | null>;
  now?: () => number;
}

/** collapse duplicate 0.01°-rounded coordinates, mirroring how the bundles were captured */
function uniqueIndex(points: Array<{ lat: number; lon: number }>): number[] {
  const indexForKey = new Map<string, number>();
  let next = 0;
  return points.map((p) => {
    const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
    let idx = indexForKey.get(key);
    if (idx === undefined) {
      idx = next++;
      indexForKey.set(key, idx);
    }
    return idx;
  });
}

function locations(bundle: unknown): any[] {
  return Array.isArray(bundle) ? bundle : [bundle];
}

function normalizeTimes(times: string[]): string[] {
  return times.map((t) => (t.endsWith('Z') ? t : `${t}:00Z`));
}

/** member series keys in stable order: base (control), then _member01.._memberNN */
function memberKeys(hourly: Record<string, unknown>, base: string): string[] {
  const members = Object.keys(hourly)
    .filter((k) => k.startsWith(`${base}_member`))
    .sort();
  return hourly[base] !== undefined ? [base, ...members] : members;
}

export class ScenarioBundleStore implements ForecastStore {
  private loadBundle: ScenarioBundleStoreOptions['loadBundle'];
  private now: () => number;
  private bundles = new Map<BundleName, unknown | null>();
  private runIds = new Map<BundleName, string>();
  private initPromise: Promise<void> | null = null;

  constructor(options: ScenarioBundleStoreOptions) {
    this.loadBundle = options.loadBundle;
    this.now = options.now ?? Date.now;
  }

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      for (const name of ['forecast', 'ensemble', 'marine', 'multimodel'] as const) {
        const bundle = await this.loadBundle(name).catch(() => null);
        this.bundles.set(name, bundle);
        if (bundle) this.runIds.set(name, `scenario-${contentHash(bundle).slice(0, 8)}`);
      }
      if (!this.bundles.get('forecast')) {
        throw new Error('Scenario bundle missing forecast.json');
      }
    })();
    return this.initPromise;
  }

  describe(): Record<string, LayerInfo> {
    const out: Record<string, LayerInfo> = {};
    const layerFor: Record<BundleName, string> = {
      forecast: 'weather',
      ensemble: 'ensemble',
      marine: 'waves',
      multimodel: 'weather-multimodel',
    };
    for (const [name, bundle] of this.bundles) {
      if (!bundle) continue;
      const layer = layerFor[name];
      out[layer] = {
        layer,
        model: 'scenario',
        run_id: this.runIds.get(name)!,
        cycle: 'scenario',
        resolution_deg: 0.25,
        member_count: name === 'ensemble' ? this.ensembleMemberCount() : 1,
        published_at: new Date(this.now()).toISOString(),
      };
    }
    return out;
  }

  private ensembleMemberCount(): number {
    const bundle = this.bundles.get('ensemble');
    if (!bundle) return 0;
    const hourly = locations(bundle)[0]?.hourly ?? {};
    return memberKeys(hourly, 'wind_speed_10m').length;
  }

  private meta(name: BundleName, layer: string, points: number, members?: number): TileRequestMeta {
    return {
      source: 'fixture',
      layer,
      model: 'scenario',
      run_id: this.runIds.get(name) ?? 'scenario-missing',
      cycle: 'scenario',
      resolution_deg: 0.25,
      ...(members && members > 1 ? { member_count: members } : {}),
      tiles: [],
      fetched_at: new Date(this.now()).toISOString(),
      cached_tiles: 0,
      points,
    };
  }

  async getPointForecasts(
    points: Array<{ lat: number; lon: number }>,
    _startMs: number,
    _endMs: number,
  ): Promise<{ forecasts: PointForecast[]; meta: TileRequestMeta }> {
    await this.init();
    const locs = locations(this.bundles.get('forecast'));
    const forecasts = uniqueIndex(points).map((idx, i) => {
      const hourly = locs[Math.min(idx, locs.length - 1)]?.hourly ?? {};
      return {
        lat: points[i]!.lat,
        lon: points[i]!.lon,
        times: normalizeTimes(hourly.time ?? []),
        wind_kt: hourly.wind_speed_10m ?? [],
        gust_kt: hourly.wind_gusts_10m ?? [],
        wind_dir_deg: hourly.wind_direction_10m ?? [],
      };
    });
    return { forecasts, meta: this.meta('forecast', 'weather', points.length) };
  }

  async getEnsembleForecasts(
    points: Array<{ lat: number; lon: number }>,
    _startMs: number,
    _endMs: number,
  ): Promise<{ forecasts: EnsemblePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    const bundle = this.bundles.get('ensemble');
    if (!bundle) return null;
    const locs = locations(bundle);
    const forecasts = uniqueIndex(points).map((idx, i) => {
      const hourly = locs[Math.min(idx, locs.length - 1)]?.hourly ?? {};
      return {
        lat: points[i]!.lat,
        lon: points[i]!.lon,
        times: normalizeTimes(hourly.time ?? []),
        wind_kt_members: memberKeys(hourly, 'wind_speed_10m').map((k) => hourly[k] ?? []),
        gust_kt_members: memberKeys(hourly, 'wind_gusts_10m').map((k) => hourly[k] ?? []),
      };
    });
    return {
      forecasts,
      meta: this.meta('ensemble', 'ensemble', points.length, this.ensembleMemberCount()),
    };
  }

  async getWaveForecasts(
    points: Array<{ lat: number; lon: number }>,
    _startMs: number,
    _endMs: number,
  ): Promise<{ forecasts: WavePointForecast[]; meta: TileRequestMeta } | null> {
    await this.init();
    const bundle = this.bundles.get('marine');
    if (!bundle) return null;
    const locs = locations(bundle);
    const forecasts = uniqueIndex(points).map((idx, i) => {
      const hourly = locs[Math.min(idx, locs.length - 1)]?.hourly ?? {};
      return {
        lat: points[i]!.lat,
        lon: points[i]!.lon,
        times: normalizeTimes(hourly.time ?? []),
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
    return { forecasts, meta: this.meta('marine', 'waves', points.length) };
  }

  async getHazardForecasts(
    points: Array<{ lat: number; lon: number }>,
    _startMs: number,
    _endMs: number,
  ): Promise<{ byModel: Record<string, HazardPointForecast[]>; meta: TileRequestMeta[] } | null> {
    await this.init();
    const bundle = this.bundles.get('multimodel');
    if (!bundle) return null;
    const locs = locations(bundle);
    const hourly0 = locs[0]?.hourly ?? {};
    // model names are encoded as per-model suffixed keys (wind_speed_10m_<model>)
    const models = [
      ...new Set(
        Object.keys(hourly0)
          .filter((k) => k.startsWith('wind_speed_10m_') && !k.includes('_member'))
          .map((k) => k.replace('wind_speed_10m_', '')),
      ),
    ];
    if (!models.length) return null;
    const byModel: Record<string, HazardPointForecast[]> = {};
    for (const model of models) {
      byModel[model] = uniqueIndex(points).map((idx, i) => {
        const hourly = locs[Math.min(idx, locs.length - 1)]?.hourly ?? {};
        const series = (base: string) => hourly[`${base}_${model}`] ?? hourly[base] ?? [];
        return {
          lat: points[i]!.lat,
          lon: points[i]!.lon,
          times: normalizeTimes(hourly.time ?? []),
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
      meta: [this.meta('multimodel', 'weather-multimodel', points.length)],
    };
  }

  async getWindGrid(_bbox: Bbox, _startIso: string, _hours: number): Promise<RegionGrid> {
    throw new Error('Scenario bundles carry no routing grids');
  }

  async getCurrentGrid(): Promise<RegionGrid | null> {
    return null;
  }
}
