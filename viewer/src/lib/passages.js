import { capitalize } from './format.js';

/** "cherbourg-plymouth-v1" / "my-passage-5wp" → "Cherbourg plymouth" / "My passage" */
export function routeName(routeId) {
  const words = routeId
    .replace(/-(v\d+|\d+wp)$/i, '')
    .split('-')
    .filter(Boolean);
  return capitalize(words.join(' ')) || routeId;
}

const created = (snapshot) => Date.parse(snapshot.created_at) || 0;

/**
 * A passage is one route and departure; each check of it is a frozen briefing.
 * Checks run oldest to newest; a tie goes to the served example, which is the
 * latest run of its demo pair. Passages run most recently checked first, with
 * the example after the sailor's own.
 */
export function groupPassages(snapshots = []) {
  const byKey = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.route_id}|${snapshot.departure_utc}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(snapshot);
  }
  return [...byKey.entries()]
    .map(([key, checks]) => {
      checks.sort((a, b) => created(a) - created(b) || Number(Boolean(a.demo)) - Number(Boolean(b.demo)));
      const latest = checks.at(-1);
      return {
        key,
        route_id: latest.route_id,
        departure_utc: latest.departure_utc,
        checks,
        latest,
        previous: checks.at(-2) ?? null,
        demo: checks.some((check) => check.demo),
      };
    })
    .sort((a, b) => Number(a.demo) - Number(b.demo) || created(b.latest) - created(a.latest));
}
