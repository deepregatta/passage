// The production bet, running today: per-user analysis in the browser.
// Open-Meteo is fetched from this browser (each user's own IP carries the quota);
// snapshots persist via the dev middleware POST (Supabase/R2 later).

import { runAnalysis, persistSnapshot } from '@deepweather/engine';

class HttpSnapshotStore {
  async exists(snapshotId) {
    const res = await fetch(`/data/snapshots/${snapshotId}/snapshot.json`, { method: 'GET' });
    return res.ok;
  }

  async write(snapshotId, filename, content) {
    const res = await fetch(`/data/snapshots/${snapshotId}/${filename}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
    });
    if (res.status === 409) throw new Error(`Snapshot ${snapshotId} already exists (write-once)`);
    if (!res.ok) throw new Error(`Snapshot write failed: HTTP ${res.status}`);
  }
}

async function loadCurrentGrid() {
  try {
    const latest = await fetch('/data/runs/latest.json').then((r) => (r.ok ? r.json() : null));
    const rel = latest?.artifacts?.current_grid;
    if (!rel) return undefined;
    const grid = await fetch(`/data/${rel}`).then((r) => (r.ok ? r.json() : null));
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
  const latest = await loadJson('/data/runs/latest.json');
  const [currentGrid, synoptic, tides, gatesDoc, warningsDoc, zonesDoc] = await Promise.all([
    loadCurrentGrid(),
    latest?.artifacts?.synoptic_features
      ? loadJson(`/data/${latest.artifacts.synoptic_features}`)
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
    onProgress,
    currentGrid,
    synoptic,
    tides,
    gates: gatesDoc?.gates,
    warnings,
  });
  onProgress?.('saving immutable snapshot');
  const snapshotId = await persistSnapshot(new HttpSnapshotStore(), result, route, Date.now());
  return { snapshotId, result };
}

export async function saveRoute(route) {
  const res = await fetch(`/data/routes/${route.route_id}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route, null, 2),
  });
  if (!res.ok) throw new Error(`Route save failed: HTTP ${res.status}`);
}
