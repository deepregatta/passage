/** The name a passage gets until the sailor types one. Start and finish carry
 * a `name` only when the point came from somewhere that knows it: an imported
 * GPX route, or a port of the bundled list within a few miles of a tapped point
 * (lib/ports.js; the page never asks an outside service to find one). The name
 * is a display label: it is not part of the routing inputs, and a passage's
 * identity is its passage_id. */

export const GENERIC_NAME = { en: 'My passage', fr: 'Ma traversée' };

const tidy = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** A point the sailor places (tap) or moves (drag) on the chart. When `portNameAt`
 * finds a port in range the point carries its name, marked `nameSource: 'port'`
 * so a later move may rename or clear it; out of range it carries none. A name
 * that came from an imported GPX file has no mark and stays on a moved point:
 * the page never overwrites a name it did not give. Names are proper nouns,
 * stored and shown exactly as the port list has them.
 * @param {{name?: string, nameSource?: string} | null} previous the point being moved, if any
 * @param {{lat: number, lng: number}} latlng
 * @param {(lat: number, lng: number) => string | null} portNameAt */
export function placedPoint(previous, latlng, portNameAt) {
  const point = { lat: latlng.lat, lng: latlng.lng };
  if (previous?.name && previous.nameSource !== 'port') return { ...point, name: previous.name };
  const port = portNameAt(point.lat, point.lng);
  return port ? { ...point, name: port, nameSource: 'port' } : point;
}

/** "Cherbourg → Plymouth" when both ends are named, otherwise the generic name. */
export function defaultPassageName({ mode, endpoints = [], waypoints = [] }, language = 'en') {
  const points = mode === 'draw' ? waypoints : endpoints;
  const start = tidy(points[0]?.name);
  const finish = tidy(points.length >= 2 ? points[points.length - 1]?.name : '');
  return start && finish ? `${start} → ${finish}` : (GENERIC_NAME[language] ?? GENERIC_NAME.en);
}
