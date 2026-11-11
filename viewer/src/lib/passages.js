import { capitalize, fmtLocalTime } from './format.js';
import { translateText } from '../i18n.js';

/** "cherbourg-plymouth-v1" / "my-passage-5wp" → "Cherbourg plymouth" / "My passage" */
export function routeName(routeId) {
  const words = routeId
    .replace(/-(v\d+|\d+wp)$/i, '')
    .split('-')
    .filter(Boolean);
  return capitalize(words.join(' ')) || routeId;
}

/** The title the sailor gave a drawn or computed passage, or null when the
 * briefing should name it from its legs (fixed routes, and computed routes
 * saved before names were carried, which hold the engine's own label). */
export function userRouteName(route) {
  const name = typeof route?.name === 'string' ? route.name.trim() : '';
  if (!name || route.mode === 'fixed' || /\(computed\)$/.test(name)) return null;
  return name;
}

const created = (snapshot) => Date.parse(snapshot.created_at);
const source = (snapshot) => snapshot.local ? 'local' : 'served';
const groupKey = (snapshot) => snapshot.identity_version === 2 && snapshot.passage_id
  ? `${source(snapshot)}|passage|${snapshot.passage_id}`
  : !snapshot.local && snapshot.legacy_history_id
    ? `served|reference|${snapshot.legacy_history_id}`
    : `${source(snapshot)}|snapshot|${snapshot.snapshot_id}`;

/** The grouping key of a saved check: the key its passage's rename (lib/passageLabels.js) is stored under. */
export function passageKeyOf(snapshots, snapshotId) {
  const snapshot = (snapshots ?? []).find((item) => item.snapshot_id === snapshotId);
  return snapshot ? groupKey(snapshot) : null;
}

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

/** Marks text the document localiser must leave alone: it was already composed
 * in the right language, and may contain a name the sailor typed. Also used for
 * verbatim register data (licences and credit lines on the About page). */
export const OWNED = { 'data-i18n-owned': 'message' };

// Phrases with a sailor-typed or generated value in them. The value is put in
// after translation, so the French catalogue can never rewrite a passage name.
export const PASSAGE_TEMPLATES = [
  'Open {name}, departing {time}',
  'Open check {n} of {name}, made {time}',
  'Open check {n} of {name}, made {time}, on a different route',
  'Open check {n} of {name}, made {time}, on a different route or departure',
  'Check {n}',
  '+{n} more checks',
  'Rename {name}',
  'Delete {name}, departing {time}',
  'Delete "{name}"?',
  'Departing {time} local time ({tz}).',
  'This will also delete its {count} saved checks.',
  'Passage renamed to {name}.',
  'Passage renamed to {name}. This browser could not save the name, so it lasts only until you leave this page.',
  'Original name restored.',
];

export function passageText(template, values, language) {
  return translateText(template, language).replace(/\{(\w+)\}/g, (token, key) => String(values[key] ?? token));
}

/** Local time in the page language. */
export const localTime = (iso, language) => translateText(fmtLocalTime(iso), language);

/** Did the route content or departure fingerprint differ between checks of one
 * passage? route_revision covers route content AND departure, so an equal
 * departure makes it a route change; otherwise the manifest cannot say which.
 * Checks without a revision (legacy, schema 1) are never compared. */
export function routeChanges(checks) {
  const latest = checks.at(-1);
  const none = { kind: null, differing: new Map() };
  if (!latest?.route_revision) return none;
  const differing = new Map();
  for (const check of checks) {
    if (!check.route_revision || check.route_revision === latest.route_revision) continue;
    differing.set(check.snapshot_id, check.departure_utc === latest.departure_utc ? 'route' : 'route_or_departure');
  }
  if (!differing.size) return none;
  return { kind: [...differing.values()].includes('route') ? 'route' : 'route_or_departure', differing };
}
