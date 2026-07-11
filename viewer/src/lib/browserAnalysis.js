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

export async function analyzeInBrowser({ route, profile, departureUtc, onProgress }) {
  onProgress?.('loading prepared currents');
  const currentGrid = await loadCurrentGrid();
  const result = await runAnalysis({ route, profile, departureUtc, onProgress, currentGrid });
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
