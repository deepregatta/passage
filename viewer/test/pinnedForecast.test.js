import { describe, expect, it, vi } from 'vitest';
import { TileForecastStore } from '@deepweather/engine';
import { pinForecastStore, pinnedCatalogue } from '../src/lib/pinnedForecast.js';
import { ForecastUpdatedError } from '../src/lib/forecastFreshness.js';

const manifest = (layer, runId, extra = {}) => ({
  schema_version: 1, run_id: runId, layer, model: `${layer}-model`, cycle: '2026-09-30T00:00Z', resolution_deg: 0.25,
  published_at: '2026-09-30T04:00:00Z', time_axis: { base: '2026-09-30T00:00Z', offsets_h: [0, 1] }, tiles: {}, ...extra,
});

/** A page store over an in-memory catalogue; `unreadable` run ids fail like a half-published manifest. */
function pageStore({ unreadable = [] } = {}) {
  const manifests = {
    'weather-new': manifest('weather', 'weather-new'),
    'weather-old': manifest('weather', 'weather-old'),
    'ensemble-1': manifest('ensemble', 'ensemble-1', { member_count: 31 }),
  };
  const transport = {
    fetchLatest: vi.fn(async () => ({ schema_version: 1, updated_at: 'x', layers: {
      weather: { run_id: 'weather-new', previous_run_id: 'weather-old', cycle: 'c', published_at: 'p', cadence_hours: 6 },
      ensemble: { run_id: 'ensemble-1', cycle: 'c', published_at: 'p', member_count: 31 },
    } })),
    fetchManifest: vi.fn(async (runId) => {
      if (unreadable.includes(runId) || !manifests[runId]) throw new Error('HTTP 404');
      return manifests[runId];
    }),
    fetchTile: vi.fn(),
  };
  return new TileForecastStore({ transport, now: () => 0 });
}

const fakeCache = () => ({
  get: vi.fn(async () => null), has: vi.fn(async () => false), put: vi.fn(async () => {}),
  delete: vi.fn(async () => {}), evictExcept: vi.fn(async () => {}),
});

describe('pinned forecast for the scan Worker', () => {
  it('pins exactly the page store\'s runs, a layer held on its previous run included', async () => {
    const page = pageStore({ unreadable: ['weather-new'] });
    await page.init();
    const catalogue = structuredClone(pinnedCatalogue(page));
    const tiles = { fetchTile: vi.fn() };
    const cache = fakeCache();
    const pinned = await pinForecastStore(catalogue, { tiles, cache, now: () => 0 });
    expect(pinned.describe()).toEqual(page.describe());
    expect(Object.keys(pinned.describe())).toEqual(Object.keys(page.describe()));
    expect(pinned.manifestFor('weather').run_id).toBe('weather-old');
    // only the page's store decides which runs the shared cache keeps
    expect(cache.evictExcept).not.toHaveBeenCalled();
    // it can never re-read the catalogue: refreshing finds the same runs
    expect(await pinned.refresh()).toEqual([]);
  });

  it('fails as an updated forecast when the runs it loads are not the page\'s', async () => {
    const page = pageStore();
    await page.init();
    const catalogue = structuredClone(pinnedCatalogue(page));
    catalogue.runs.weather.run_id = 'weather-other';
    await expect(pinForecastStore(catalogue, { tiles: { fetchTile: vi.fn() }, cache: fakeCache() }))
      .rejects.toBeInstanceOf(ForecastUpdatedError);
  });
});
