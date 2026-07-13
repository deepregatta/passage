/**
 * Prepared-run source resolution. The route-independent per-cycle artifacts
 * (synoptic features + chart PNGs, wind/current grids) are published in two
 * places: the dev middleware serves the local pipeline output at /data/…,
 * and production serves the cron-published copy from the forecast tile host
 * under prepared/… (see .github/workflows/prepare-synoptic.yml). Everything
 * that reads a `runs/…` artifact path must resolve it through this module.
 */

const FORECAST_BASE = (import.meta.env.VITE_FORECAST_BASE_URL || '').replace(/\/$/, '');

// chartUrl() needs a synchronous base for <img src>; it is correct as soon as
// preparedRun() has settled, which every analysis/briefing path awaits first.
let resolvedBase = '/data/';

let sourcePromise = null;

/** {doc, base}: latest.json content (or null) and the URL prefix for `runs/…` paths */
export function preparedRun() {
  sourcePromise ??= (async () => {
    // only the dev middleware serves /data/runs/ — a production build skips
    // the probe (it would 404 into the console on every briefing)
    if (import.meta.env.DEV) {
      try {
        const res = await fetch('/data/runs/latest.json');
        if (res.ok) return { doc: await res.json(), base: '/data/' };
      } catch {
        // fall through to the published copy
      }
    }
    if (FORECAST_BASE) {
      try {
        const res = await fetch(`${FORECAST_BASE}/prepared/latest.json`);
        if (res.ok) return { doc: await res.json(), base: `${FORECAST_BASE}/prepared/` };
      } catch {
        // no prepared runs published (or offline) — analysis degrades honestly
      }
    }
    return { doc: null, base: '/data/' };
  })().then((source) => {
    resolvedBase = source.base;
    return source;
  });
  return sourcePromise;
}

/** URL for a latest.json artifact path like "runs/<id>/synoptic/features.json" */
export async function artifactUrl(rel) {
  const { base } = await preparedRun();
  return `${base}${rel}`;
}

/** synchronous variant for chart <img> sources; valid once preparedRun() settled */
export function runsBase() {
  return resolvedBase;
}
