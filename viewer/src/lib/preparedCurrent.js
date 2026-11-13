// @ts-check
// Prepared artifacts named by one latest.json pointer, loaded the same way by
// every action. Compute and Check both read the prepared current grid here, so
// a computed route and its Check record the same grid and the same digest.
import { cachedContentHash } from '@deepweather/engine';
import { freezeInput } from './actionInputs.js';
import { artifactUrl } from './preparedRun.js';

/** @param {string} url @returns {Promise<any>} External JSON; admitted at the consumer boundary. */
export async function loadJson(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The input record an action stores for one prepared artifact.
 * @param {any} latest the latest.json pointer the action resolved
 * @param {string} layer @param {any} doc @param {string | undefined} ref
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown> | null}
 */
export function artifactRecord(latest, layer, doc, ref, extra = {}) {
  if (!doc) return null;
  const fromPreparedRun = layer === 'currents' || layer === 'synoptic';
  return {
    source: 'prepared-artifact', layer, model: doc.source?.dataset_id ?? (fromPreparedRun ? latest?.model : layer) ?? layer,
    run_id: doc.run_id ?? (fromPreparedRun ? latest?.run_id : null) ?? null,
    fetched_at: doc.source?.fetched_at ?? doc.fetched_at ?? doc.generated_at ?? (fromPreparedRun ? latest?.generated_at : null),
    // A deep-frozen doc (the prepared current grid) is hashed once, here, and the
    // engine reuses this digest for routing and admission (cachedContentHash).
    artifact_ref: ref, content_digest: cachedContentHash(doc), digest_algorithm: 'fnv1a64',
    ...(doc.source?.mode === 'synthetic' ? { source_kind: 'emulated' } : {}),
    ...extra,
  };
}

/**
 * The prepared current grid one pointer names, with its input record. The grid
 * is deep-frozen before it is hashed: it cannot change after its digest is
 * taken, so every later use of this object (routing, admission, the audit)
 * reads that one digest instead of hashing the grid again.
 * @param {any} latest
 * @returns {Promise<{ currentGrid?: import('@deepweather/engine').RegionGrid, currentGridProvenance?: Record<string, unknown> }>}
 */
export async function loadPreparedCurrent(latest) {
  const ref = latest?.artifacts?.current_grid;
  const loaded = ref ? await artifactUrl(ref).then(loadJson) : undefined;
  const currentGrid = loaded && typeof loaded === 'object' ? freezeInput(loaded) : loaded;
  return { currentGrid, currentGridProvenance: artifactRecord(latest, 'currents', currentGrid, ref) ?? undefined };
}
