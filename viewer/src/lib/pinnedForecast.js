// The page's pinned forecast runs, handed to another thread. The scan Worker
// gets a copy of the runs the page's store has pinned (a few KB of catalogue
// and manifests, never tiles) and builds its own TileForecastStore over them:
// it reads the same tiles through the shared IndexedDB cache or over HTTP, and
// it can never read latest.json, so it cannot substitute a newer run.
import { contentHash, HttpTileTransport, TileForecastStore } from '@deepweather/engine';
import { ForecastUpdatedError } from './forecastFreshness.js';
import { FORECAST_BASE_URL } from './forecastConfig.js';
import { createTileCache } from './tileCache.js';

/**
 * What another thread needs to pin the same runs as `store`: every loaded
 * layer in the store's order, with its catalogue entry and run manifest.
 * @param {import('@deepweather/engine').TileForecastStore} store an initialised store
 */
export function pinnedCatalogue(store) {
  const runs = store.describe();
  const layers = Object.entries(runs).map(([layer, info]) => ({
    layer,
    regional: info.regional === true,
    entry: {
      run_id: info.run_id, previous_run_id: null, cycle: info.cycle, published_at: info.published_at,
      ...(info.member_count !== undefined ? { member_count: info.member_count } : {}),
      ...(info.cadence_hours !== undefined ? { cadence_hours: info.cadence_hours } : {}),
    },
    manifest: store.manifestFor(layer),
  }));
  return {
    runs,
    layers,
    regionalLayers: [...(store.regionalLayerIds?.() ?? [])],
  };
}

/**
 * A transport that answers only with the pinned catalogue and manifests;
 * tiles still come from `tiles` (HTTP).
 * @param {ReturnType<typeof pinnedCatalogue>} catalogue
 * @param {Pick<import('@deepweather/engine').TileTransport, 'fetchTile'>} tiles
 */
export function pinnedTransport(catalogue, tiles) {
  const latest = (regional) => ({
    schema_version: 1,
    updated_at: '',
    layers: Object.fromEntries(catalogue.layers.filter((l) => l.regional === regional).map((l) => [l.layer, l.entry])),
  });
  const manifests = new Map(catalogue.layers.map((l) => [l.manifest.run_id, l.manifest]));
  return {
    fetchLatest: async () => latest(false),
    fetchRegionalLatest: async () => latest(true),
    fetchManifest: async (runId) => {
      const manifest = manifests.get(runId);
      if (!manifest) throw new Error(`run ${runId} is not pinned`);
      return manifest;
    },
    fetchTile: (runId, tilePath, options) => tiles.fetchTile(runId, tilePath, options),
  };
}

/** The shared tile cache, without eviction: only the page's own store decides which runs to keep. */
function sharedCache(cache) {
  if (!cache) return undefined;
  return {
    get: (key) => cache.get(key),
    ...(typeof cache.has === 'function' ? { has: (key) => cache.has(key) } : {}),
    put: (key, bytes, runId) => cache.put(key, bytes, runId),
    delete: (key) => cache.delete(key),
    evictExcept: async () => {},
  };
}

/**
 * A store pinned to `catalogue`, for a thread other than the page's.
 * `pinForecastStore` resolves once its runs are loaded and match the page's;
 * a mismatch fails the action as "The forecast has been updated".
 * @param {ReturnType<typeof pinnedCatalogue>} catalogue
 * @param {{ now?: () => number, tiles?: Pick<import('@deepweather/engine').TileTransport, 'fetchTile'>, cache?: any }} [options]
 */
export async function pinForecastStore(catalogue, { now, tiles, cache = createTileCache() } = {}) {
  const shared = sharedCache(cache);
  const store = new TileForecastStore({
    transport: pinnedTransport(catalogue, tiles ?? new HttpTileTransport({ baseUrl: FORECAST_BASE_URL })),
    regionalLayers: catalogue.regionalLayers,
    ...(shared ? { cache: shared } : {}),
    ...(now ? { now } : {}),
  });
  await store.init();
  if (contentHash(store.describe()) !== contentHash(catalogue.runs)) throw new ForecastUpdatedError();
  return store;
}
