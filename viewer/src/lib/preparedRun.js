/**
 * Prepared-run source resolution. The route-independent per-cycle artifacts
 * (synoptic features + chart PNGs, wind/current grids) are published in two
 * places: the dev middleware serves the local pipeline output at /data/…,
 * and production serves the cron-published copy from the forecast tile host
 * under prepared/… (see .github/workflows/prepare-synoptic.yml). Everything
 * that reads a `runs/…` artifact path must resolve it through this module.
 */

import { FORECAST_BASE_URL } from './forecastConfig.js';

// Select the source before any request. Saved charts must also resolve when
// latest.json is offline, missing, or has not been requested yet. Development
// stays local instead of silently switching artifact hosts after a failed probe.
const RUNS_BASE = import.meta.env.DEV ? '/data/' : `${FORECAST_BASE_URL}/prepared/`;
const LATEST_URL = import.meta.env.DEV ? '/data/runs/latest.json' : `${RUNS_BASE}latest.json`;

let sourcePromise = null;

/** {doc, base}: latest.json content (or null) and the URL prefix for `runs/…` paths */
export function preparedRun() {
  sourcePromise ??= (async () => {
    try {
      const res = await fetch(LATEST_URL);
      if (res.ok) return { doc: await res.json(), base: RUNS_BASE };
    } catch {
      // No prepared runs published (or offline) — analysis degrades honestly.
    }
    return { doc: null, base: RUNS_BASE };
  })();
  return sourcePromise;
}

/** URL for a latest.json artifact path like "runs/<id>/synoptic/features.json" */
export async function artifactUrl(rel) {
  return `${RUNS_BASE}${rel}`;
}

/** Synchronous base for chart <img> sources, independent of pointer loading. */
export function runsBase() {
  return RUNS_BASE;
}
