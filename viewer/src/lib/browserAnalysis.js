// @ts-check
// The production bet, running today: per-user analysis in the browser.
// Weather comes from precomputed forecast tiles (R2 in production, the dev
// middleware's fixture run locally) cached in IndexedDB. Snapshots persist via
// the dev middleware POST when it exists; static hosting (Cloudflare Pages)
// answers 405, and the snapshot falls back to browser-local IndexedDB.

import { runAnalysis, persistSnapshot, contentHash, ENGINE_VERSION } from '@deepweather/engine';
import { forecastStore } from './forecastStore.js';
import { localSnapshots } from './localSnapshots.js';
import { preparedRun, artifactUrl } from './preparedRun.js';
import { captureActionDraft, freezeActionInputs, pinForecastInputs } from './actionInputs.js';

// statuses that mean "no write endpoint here", not "this write failed"
const NO_WRITE_ENDPOINT = new Set([403, 404, 405, 501]);

// the /data write endpoints exist only in the dev middleware; a production
// build goes straight to browser storage instead of probing (a probe works,
// but every 405 lands in the user's console)
const DEV_WRITES = import.meta.env.DEV;

class FallbackSnapshotStore {
  useLocal = !DEV_WRITES;

  /** @param {string} snapshotId */
  async exists(snapshotId) {
    if (await localSnapshots.exists(snapshotId)) return true;
    if (!DEV_WRITES) return false; // static hosting can't hold a same-id user snapshot
    const res = await fetch(`/data/snapshots/${snapshotId}/snapshot.json`, { method: 'GET' });
    return res.ok;
  }

  /** @param {string} snapshotId @param {string} filename @param {string} content */
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

/** @param {string} url @returns {Promise<any>} External JSON; admitted at the consumer boundary. */
async function loadJson(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} routeId */
async function loadTides(routeId) {
  const index = await loadJson('/data/tides/index.json');
  const artifact = index?.routes?.[routeId];
  if (typeof artifact !== 'string' || !/^[a-zA-Z0-9_-]+\.json$/.test(artifact)) return undefined;
  const ref = `/data/tides/${artifact}`;
  return { doc: await loadJson(ref), ref };
}

/** Refresh once at the action boundary; every artifact resolves through this pointer.
 * @param {ReturnType<typeof captureActionDraft>} draft
 * @param {(step: string) => void} [onProgress]
 * @returns {Promise<import('./actionInputs.js').ActionInputs>}
 */
export async function prepareAnalysisInputs(draft, onProgress) {
  const { route } = draft;
  const pinned = await pinForecastInputs(forecastStore());
  onProgress?.('loading prepared data');
  const { doc: latest } = await preparedRun({ refresh: true });
  const [currentGrid, synoptic, tideArtifact, gatesDoc, warningsDoc, zonesDoc] = await Promise.all([
    latest?.artifacts?.current_grid ? artifactUrl(latest.artifacts.current_grid).then(loadJson) : undefined,
    latest?.artifacts?.synoptic_features
      ? artifactUrl(latest.artifacts.synoptic_features).then(loadJson)
      : undefined,
    loadTides(route.route_id),
    loadJson('/data/config/gates.json'),
    // warnings are a local-pipeline artifact with no production publisher yet;
    // requesting them from static hosting just logs a 404 in every briefing
    DEV_WRITES ? loadJson('/data/warnings/latest.json') : undefined,
    loadJson('/data/config/route-zones.json'),
  ]);
  const tides = tideArtifact?.doc;
  const gates = gatesDoc?.gates?.filter((/** @type {import('@deepweather/engine').GateDef} */ gate) =>
    tides?.ports?.some((/** @type {{port_id: string}} */ port) => port.port_id === gate.reference_port),
  );
  /** @type {import('@deepweather/engine').WarningsInput | undefined} */
  let warnings;
  if (warningsDoc) {
    const zoneEntry = zonesDoc?.routes?.[route.route_id];
    const routeZoneIds = Object.entries(zoneEntry ?? {}).flatMap(([key, zones]) =>
      key.endsWith('_zones') && Array.isArray(zones) ? zones.map((z) => z.zone_id) : [],
    );
    // user-drawn routes have no zone mapping yet: warn against ALL active zones
    // (conservative — a false authority banner beats a missed one)
    const zoneIds = !zoneEntry && route.mode === 'user'
      ? warningsDoc.bulletins.map((/** @type {{zone_id: string}} */ b) => b.zone_id)
      : routeZoneIds;
    warnings = { doc: warningsDoc, routeZoneIds: zoneIds, ref: '/data/warnings/latest.json' };
  }

  /** @param {string} layer @param {any} doc @param {string | undefined} ref @returns {Record<string, unknown> | null} */
  const artifactRecord = (layer, doc, ref) => {
    if (!doc) return null;
    const fromPreparedRun = layer === 'currents' || layer === 'synoptic';
    return {
      source: 'prepared-artifact', layer, model: doc.source?.dataset_id ?? (fromPreparedRun ? latest?.model : layer) ?? layer,
      run_id: doc.run_id ?? (fromPreparedRun ? latest?.run_id : null) ?? null,
      fetched_at: doc.source?.fetched_at ?? doc.fetched_at ?? doc.generated_at ?? (fromPreparedRun ? latest?.generated_at : null),
      artifact_ref: ref, content_digest: contentHash(doc), digest_algorithm: 'fnv1a64',
      ...(doc.source?.mode === 'synthetic' ? { source_kind: 'emulated' } : {}),
      ...(layer === 'warnings' ? { route_zone_ids: warnings?.routeZoneIds } : {}),
    };
  };
  const currentGridProvenance = artifactRecord('currents', currentGrid, latest?.artifacts?.current_grid);
  const inputRecords = [
    { source: 'action-inputs', layer: 'action', route_revision: draft.routeRevision,
      profile_revision: draft.profileRevision, departure_utc: draft.departureUtc,
      engine_version: ENGINE_VERSION,
      tile_runs: pinned.tileRuns, prepared_run_id: latest?.run_id ?? null,
      prepared_pointer_digest: latest ? contentHash(latest) : null, digest_algorithm: 'fnv1a64' },
    artifactRecord('synoptic', synoptic, latest?.artifacts?.synoptic_features),
    artifactRecord('tides', tides, tideArtifact?.ref),
    gates?.length ? artifactRecord('gates', gatesDoc, '/data/config/gates.json') : null,
    artifactRecord('warnings', warningsDoc, '/data/warnings/latest.json'),
  ].filter((record) => record !== null);
  return freezeActionInputs({ ...draft, ...pinned, currentGrid, currentGridProvenance: currentGridProvenance ?? undefined,
    synoptic, tides, gates: gates?.length ? gates : undefined, warnings, inputRecords });
}

/** @param {import('./actionInputs.js').ActionInputs & {onProgress?: (step: string) => void}} inputs */
export async function analyzeInBrowser(inputs) {
  const { onProgress } = inputs;
  const action = inputs.tileRuns ? inputs : await prepareAnalysisInputs(captureActionDraft(inputs), onProgress);
  const result = await runAnalysis({ ...action, onProgress });
  onProgress?.('saving immutable snapshot');
  const snapshotId = await persistSnapshot(new FallbackSnapshotStore(), result, action.route, Date.now());
  return { snapshotId, result };
}

// Dev nicety: mirrors the route into data/processed/routes/ for CLI use.
// The briefing itself carries route.json inside the snapshot, so on static
// hosting (no POST endpoint) this is a no-op, not a failure.
/** @param {import('@deepweather/engine').Route} route */
export async function saveRoute(route) {
  if (!DEV_WRITES) return;
  const res = await fetch(`/data/routes/${route.route_id}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route, null, 2),
  });
  if (!res.ok && !NO_WRITE_ENDPOINT.has(res.status)) {
    throw new Error(`Route save failed: HTTP ${res.status}`);
  }
}
