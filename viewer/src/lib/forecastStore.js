/**
 * The app-wide ForecastStore singleton: PFT1 tiles over HTTP (R2 in
 * production, the dev middleware's fixture run locally), cached in IndexedDB.
 * Shared by analysis and the Planner's departure scans so every consumer of
 * the same run hits the same cache.
 */

import { HttpTileTransport, TileForecastStore } from '@deepweather/engine';
import { createTileCache } from './tileCache.js';

const baseUrl = import.meta.env.VITE_FORECAST_BASE_URL || '/data/forecast';

let storeInstance = null;

export function forecastStore() {
  if (!storeInstance) {
    const cache = createTileCache();
    storeInstance = new TileForecastStore({
      transport: new HttpTileTransport({ baseUrl }),
      ...(cache ? { cache } : {}),
    });
  }
  return storeInstance;
}

/** friendly message for store failures (no run published / offline / coverage) */
export function friendlyForecastError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/unavailable for this area/i.test(message)) {
    return new Error('No forecast tiles cover this area yet');
  }
  return new Error("Couldn't load the forecast tiles — check your connection and try again");
}
