/** A persisted intent is created explicitly, never inferred from a route label. */
export const newPassageId = () => globalThis.crypto?.randomUUID?.()
  ?? `passage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;

/** Catalog fields are additive; historical artifact bodies stay byte-identical. */
export function identityFields(doc) {
  return Object.fromEntries(['identity_version', 'passage_id', 'route_revision', 'decision_hash', 'check_sequence']
    .filter(key => doc[key] !== undefined).map(key => [key, doc[key]]));
}

/** The reference index names its pair explicitly; no route/departure inference. */
export function linkReferenceHistory(snapshots, index) {
  const ids = [index?.previous_snapshot_id, index?.latest_snapshot_id];
  if (!ids.every(id => typeof id === 'string') || ids[0] === ids[1]) return snapshots;
  if (!ids.every(id => snapshots.some(s => s.snapshot_id === id && !s.local))) return snapshots;
  return snapshots.map(s => !s.local && ids.includes(s.snapshot_id)
    ? { ...s, legacy_history_id: `reference-${ids[1]}`, history_order: ids.indexOf(s.snapshot_id) }
    : s);
}
