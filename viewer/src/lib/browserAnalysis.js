// @ts-check
// The production bet, running today: per-user analysis in the browser.
// Weather comes from precomputed forecast tiles (R2 in production, the dev
// middleware's fixture run locally) cached in IndexedDB. Snapshots persist via
// the dev middleware POST when it exists; static hosting (Cloudflare Pages)
// answers 405, and the snapshot falls back to browser-local IndexedDB.

import { runAnalysis, persistSnapshot, contentHash, ENGINE_VERSION, SnapshotExistsError } from '@deepweather/engine';
import { forecastStore } from './forecastStore.js';
import { localSnapshots } from './localSnapshots.js';
import { preparedRun, artifactUrl } from './preparedRun.js';
import { artifactRecord, loadJson, loadPreparedCurrent } from './preparedCurrent.js';
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

  async list() {
    const local = await localSnapshots.list();
    if (!DEV_WRITES) return local;
    const res = await fetch('/data/snapshots/manifest.json');
    if (!res.ok) throw new Error(`Snapshot catalog unavailable: HTTP ${res.status}`);
    const served = await res.json();
    const localIds = new Set(local.map((/** @type {{snapshot_id: string}} */ item) => item.snapshot_id));
    return [...local, ...(served.snapshots ?? []).filter((/** @type {{snapshot_id: string}} */ item) => !localIds.has(item.snapshot_id))];
  }

  /** @param {string} snapshotId @param {string} filename */
  async read(snapshotId, filename) {
    const local = await localSnapshots.read(snapshotId, filename);
    if (local !== null || await localSnapshots.exists(snapshotId)) return local;
    if (!DEV_WRITES) return null;
    const res = await fetch(`/data/snapshots/${snapshotId}/${filename}`);
    return res.ok ? res.text() : null;
  }

  /** POST one artifact to the dev middleware: true when written, false when
   * there is no write endpoint here (then every later artifact goes local).
   * @param {string} snapshotId @param {string} filename @param {string} content */
  async post(snapshotId, filename, content) {
    const res = await fetch(`/data/snapshots/${snapshotId}/${filename}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
    });
    if (res.ok) return true;
    // the dev middleware's write-once refusal: the same kind as the engine's
    if (res.status === 409) throw new SnapshotExistsError(snapshotId, `Snapshot ${snapshotId} already exists (write-once)`);
    if (!NO_WRITE_ENDPOINT.has(res.status)) {
      throw new Error(`Snapshot write failed: HTTP ${res.status}`);
    }
    this.useLocal = true; // keep every artifact of this snapshot in one place
    return false;
  }

  /** @param {string} snapshotId @param {string} filename @param {string} content */
  async write(snapshotId, filename, content) {
    if (!this.useLocal && await this.post(snapshotId, filename, content)) return;
    await localSnapshots.write(snapshotId, filename, content);
  }

  /** The whole check at once: in this browser, one IndexedDB transaction (all
   * or nothing). The dev middleware still takes one request per file, as before.
   * @param {string} snapshotId @param {Array<{filename: string, content: string}>} files */
  async writeAll(snapshotId, files) {
    let sent = 0;
    while (!this.useLocal && sent < files.length) {
      const { filename, content } = files[sent];
      if (!await this.post(snapshotId, filename, content)) break;
      sent += 1;
    }
    if (sent < files.length) await localSnapshots.writeAll(snapshotId, files.slice(sent));
  }
}

/** True when the browser refused the write because this site's storage is
 * full. Browsers word the message differently; the name is the same. */
function storageFull(/** @type {unknown} */ error) {
  for (let e = /** @type {any} */ (error); e; e = e.cause) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  }
  return false;
}

/** A failed save, told apart for the planner: `saveFailure` is 'storage-full',
 * 'blocked' (write-once: this check already has records that cannot be
 * reopened) or 'failed'; the message keeps the original text for the detail. */
function saveError(/** @type {any} */ error) {
  const blocked = error instanceof SnapshotExistsError;
  const name = error?.name && error.name !== 'Error' && !blocked ? error.name : null;
  const text = [name, error?.message].filter(Boolean).join(': ') || String(error);
  return Object.assign(new Error(text, { cause: error }), {
    name: 'SnapshotSaveError', saveFailure: storageFull(error) ? 'storage-full' : blocked ? 'blocked' : 'failed',
  });
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
 * @param {import('@deepweather/engine').ForecastStore} [store] the store to pin: the page's, or the scan Worker's copy of its runs
 * @returns {Promise<import('./actionInputs.js').ActionInputs>}
 */
export async function prepareAnalysisInputs(draft, onProgress, store = forecastStore()) {
  const { route } = draft;
  const pinned = await pinForecastInputs(store);
  onProgress?.('loading prepared data');
  const { doc: latest } = await preparedRun({ refresh: true });
  const [{ currentGrid, currentGridProvenance }, synoptic, tideArtifact, gatesDoc, warningsDoc, zonesDoc] = await Promise.all([
    loadPreparedCurrent(latest),
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

  const inputRecords = [
    { source: 'action-inputs', layer: 'action', route_revision: draft.routeRevision,
      profile_revision: draft.profileRevision, departure_utc: draft.departureUtc,
      engine_version: ENGINE_VERSION,
      tile_runs: pinned.tileRuns, prepared_run_id: latest?.run_id ?? null,
      prepared_pointer_digest: latest ? contentHash(latest) : null, digest_algorithm: 'fnv1a64' },
    artifactRecord(latest, 'synoptic', synoptic, latest?.artifacts?.synoptic_features),
    artifactRecord(latest, 'tides', tides, tideArtifact?.ref),
    gates?.length ? artifactRecord(latest, 'gates', gatesDoc, '/data/config/gates.json') : null,
    artifactRecord(latest, 'warnings', warningsDoc, '/data/warnings/latest.json', { route_zone_ids: warnings?.routeZoneIds }),
  ].filter((record) => record !== null);
  return freezeActionInputs({ ...draft, ...pinned, currentGrid, currentGridProvenance,
    synoptic, tides, gates: gates?.length ? gates : undefined, warnings, inputRecords });
}

/** @param {import('./actionInputs.js').ActionInputs & {onProgress?: (step: string) => void}} inputs */
export async function analyzeInBrowser(inputs) {
  const { onProgress } = inputs;
  const action = inputs.tileRuns ? inputs : await prepareAnalysisInputs(captureActionDraft(inputs), onProgress);
  const result = await runAnalysis({ ...action, onProgress });
  onProgress?.('saving immutable snapshot');
  let snapshotId;
  try {
    snapshotId = await persistSnapshot(new FallbackSnapshotStore(), result, action.route, Date.now());
  } catch (error) {
    throw saveError(error);
  }
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
