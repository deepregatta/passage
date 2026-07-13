// The production bet, running today: per-user analysis in the browser.
// Weather comes from precomputed forecast tiles (R2 in production, the dev
// middleware's fixture run locally) cached in IndexedDB. Snapshots persist via
// the dev middleware POST when it exists; static hosting (Cloudflare Pages)
// answers 405, and the snapshot falls back to browser-local IndexedDB.

import { runAnalysis, persistSnapshot } from '@deepweather/engine';
import { forecastStore } from './forecastStore.js';
import { localSnapshots } from './localSnapshots.js';
import { preparedRun, artifactUrl } from './preparedRun.js';

// statuses that mean "no write endpoint here", not "this write failed"
const NO_WRITE_ENDPOINT = new Set([403, 404, 405, 501]);

class FallbackSnapshotStore {
  useLocal = false;

  async exists(snapshotId) {
    if (await localSnapshots.exists(snapshotId)) return true;
    const res = await fetch(`/data/snapshots/${snapshotId}/snapshot.json`, { method: 'GET' });
    return res.ok;
  }

  async write(snapshotId, filename, content) {
    if (!this.useLocal) {
      const res = await fetch(`/data/snapshots/${snapshotId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      });
      if (res.ok) return;
      if (res.status === 409) throw new Error(`Snapshot ${snapshotId} already exists (write-once)`);
      if (!NO_WRITE_ENDPOINT.has(res.status)) {
        throw new Error(`Snapshot write failed: HTTP ${res.status}`);
      }
      this.useLocal = true; // keep every artifact of this snapshot in one place
    }
    await localSnapshots.write(snapshotId, filename, content);
  }
}

async function loadCurrentGrid() {
  try {
    const { doc: latest } = await preparedRun();
    const rel = latest?.artifacts?.current_grid;
    if (!rel) return undefined;
    const grid = await fetch(await artifactUrl(rel)).then((r) => (r.ok ? r.json() : null));
    return grid ?? undefined;
  } catch {
    return undefined; // analysis still runs; currents listed as unsupported
  }
}

async function loadJson(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function analyzeInBrowser({ route, profile, departureUtc, onProgress }) {
  onProgress?.('loading prepared data');
  const { doc: latest } = await preparedRun();
  const [currentGrid, synoptic, tides, gatesDoc, warningsDoc, zonesDoc] = await Promise.all([
    loadCurrentGrid(),
    latest?.artifacts?.synoptic_features
      ? artifactUrl(latest.artifacts.synoptic_features).then(loadJson)
      : undefined,
    loadJson('/data/tides/channel.json'),
    loadJson('/data/config/gates.json'),
    loadJson('/data/warnings/latest.json'),
    loadJson('/data/config/route-zones.json'),
  ]);
  let warnings;
  if (warningsDoc) {
    const zoneEntry = zonesDoc?.routes?.[route.route_id];
    const routeZoneIds = [
      ...(zoneEntry?.fr_zones ?? []).map((z) => z.zone_id),
      ...(zoneEntry?.uk_zones ?? []).map((z) => z.zone_id),
    ];
    // user-drawn routes have no zone mapping yet: warn against ALL active zones
    // (conservative — a false authority banner beats a missed one)
    const zoneIds = routeZoneIds.length
      ? routeZoneIds
      : warningsDoc.bulletins.map((b) => b.zone_id);
    warnings = { doc: warningsDoc, routeZoneIds: zoneIds, ref: '/data/warnings/latest.json' };
  }

  const result = await runAnalysis({
    route,
    profile,
    departureUtc,
    store: forecastStore(),
    onProgress,
    currentGrid,
    synoptic,
    tides,
    gates: gatesDoc?.gates,
    warnings,
  });
  onProgress?.('saving immutable snapshot');
  const snapshotId = await persistSnapshot(new FallbackSnapshotStore(), result, route, Date.now());
  return { snapshotId, result };
}

// Dev nicety: mirrors the route into data/processed/routes/ for CLI use.
// The briefing itself carries route.json inside the snapshot, so on static
// hosting (no POST endpoint) this is a silent no-op, not a failure.
export async function saveRoute(route) {
  const res = await fetch(`/data/routes/${route.route_id}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route, null, 2),
  });
  if (!res.ok && !NO_WRITE_ENDPOINT.has(res.status)) {
    throw new Error(`Route save failed: HTTP ${res.status}`);
  }
}
