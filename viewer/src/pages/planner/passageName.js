/** The name a passage gets until the sailor types one. Start and finish carry
 * a `name` only when the point came from somewhere that knows it (an imported
 * GPX route); a point tapped on the chart has none, and the page never asks an
 * outside service to find one. The name is a display label: it is not part of
 * the routing inputs, and a passage's identity is its passage_id. */

export const GENERIC_NAME = { en: 'My passage', fr: 'Ma traversée' };

const tidy = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** "Cherbourg → Plymouth" when both ends are named, otherwise the generic name. */
export function defaultPassageName({ mode, endpoints = [], waypoints = [] }, language = 'en') {
  const points = mode === 'draw' ? waypoints : endpoints;
  const start = tidy(points[0]?.name);
  const finish = tidy(points.length >= 2 ? points[points.length - 1]?.name : '');
  return start && finish ? `${start} → ${finish}` : (GENERIC_NAME[language] ?? GENERIC_NAME.en);
}
