// @ts-check
// Prepared artifacts named by one latest.json pointer, loaded the same way by
// every action. Compute and Check both read the prepared current grid here, so
// a computed route and its Check record the same grid and the same digest.
import { contentHash } from '@deepweather/engine';
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
    artifact_ref: ref, content_digest: contentHash(doc), digest_algorithm: 'fnv1a64',
    ...(doc.source?.mode === 'synthetic' ? { source_kind: 'emulated' } : {}),
    ...extra,
  };
}

/**
 * The prepared current grid one pointer names, with its input record.
 * @param {any} latest
 * @returns {Promise<{ currentGrid?: import('@deepweather/engine').RegionGrid, currentGridProvenance?: Record<string, unknown> }>}
 */
export async function loadPreparedCurrent(latest) {
  const ref = latest?.artifacts?.current_grid;
  const currentGrid = ref ? await artifactUrl(ref).then(loadJson) : undefined;
  return { currentGrid, currentGridProvenance: artifactRecord(latest, 'currents', currentGrid, ref) ?? undefined };
}
