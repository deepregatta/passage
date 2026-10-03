import { capitalize } from './format.js';

/** "cherbourg-plymouth-v1" / "my-passage-5wp" → "Cherbourg plymouth" / "My passage" */
export function routeName(routeId) {
  const words = routeId
    .replace(/-(v\d+|\d+wp)$/i, '')
    .split('-')
    .filter(Boolean);
  return capitalize(words.join(' ')) || routeId;
}

const created = (snapshot) => Date.parse(snapshot.created_at);
const source = (snapshot) => snapshot.local ? 'local' : 'served';
const groupKey = (snapshot) => snapshot.identity_version === 2 && snapshot.passage_id
  ? `${source(snapshot)}|passage|${snapshot.passage_id}`
  : !snapshot.local && snapshot.legacy_history_id
    ? `served|reference|${snapshot.legacy_history_id}`
    : `${source(snapshot)}|snapshot|${snapshot.snapshot_id}`;

/** One deterministic order for progress stations and chronological comparisons. */
export function compareChecks(a, b) {
  const time = (created(a) || 0) - (created(b) || 0);
  if (time) return time;
  if (a.legacy_history_id && a.legacy_history_id === b.legacy_history_id) {
    const order = (a.history_order ?? 0) - (b.history_order ?? 0);
    if (order) return order;
  }
  if (Number.isSafeInteger(a.check_sequence) && Number.isSafeInteger(b.check_sequence) && a.check_sequence !== b.check_sequence) {
    return a.check_sequence - b.check_sequence;
  }
  return a.snapshot_id < b.snapshot_id ? -1 : a.snapshot_id > b.snapshot_id ? 1 : 0;
}

/** Ambiguous legacy records are singleton groups: deletion cannot cross intents. */
export function groupPassages(snapshots = []) {
  const byKey = new Map();
  for (const snapshot of snapshots) {
    const key = groupKey(snapshot);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(snapshot);
  }
  return [...byKey.entries()].map(([key, checks]) => {
    checks.sort(compareChecks);
    const latest = checks.at(-1);
    return { key, route_id: latest.route_id, departure_utc: latest.departure_utc,
      checks, latest, previous: previousCheck(checks, latest),
      legacy: !(latest.identity_version === 2 && latest.passage_id) && !latest.legacy_history_id,
      demo: checks.some(check => check.demo) };
  }).sort((a, b) => Number(a.demo) - Number(b.demo) || compareChecks(b.latest, a.latest));
}

/** Immediate predecessor only; absent/invalid dates never manufacture a story. */
export function previousCheck(snapshots, current) {
  return comparisonForCheck(snapshots, current).previous;
}

export function comparisonForCheck(snapshots, current) {
  const checks = snapshots.filter(item => groupKey(item) === groupKey(current) && Number.isFinite(created(item))).sort(compareChecks);
  const index = checks.findIndex(item => item.snapshot_id === current.snapshot_id);
  if (index < 0 || ambiguousCheckOrder(checks, current)) return { previous: null, unavailable: true };
  if (index === 0) return { previous: null, unavailable: false };
  const previous = checks[index - 1];
  return ambiguousCheckOrder(checks, previous)
    ? { previous: null, unavailable: true } : { previous, unavailable: false };
}

/** Unknown equal-clock order is disclosed rather than inferred from a hash. */
export function ambiguousCheckOrder(snapshots, entry) {
  return !Number.isFinite(created(entry)) || snapshots.some(other =>
    groupKey(other) === groupKey(entry) && other.snapshot_id !== entry.snapshot_id && created(other) === created(entry) &&
    !(entry.legacy_history_id && entry.legacy_history_id === other.legacy_history_id && entry.history_order !== other.history_order) &&
    !(Number.isSafeInteger(entry.check_sequence) && Number.isSafeInteger(other.check_sequence) && entry.check_sequence !== other.check_sequence));
}
