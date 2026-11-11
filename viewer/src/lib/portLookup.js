/** Nearest named port to a point. Pure and DOM-free: the list is passed in, so
 * nothing here loads, fetches or sends anything. Coordinates never leave the
 * browser; the lookup is a scan over a bundled list. See ports.js for loading it. */

const EARTH_RADIUS_NM = 3440.065;
const toRad = Math.PI / 180;

/** How close a tapped point must be to a port to take its name. Five nautical
 * miles is about one chart-plotting error from a harbour mouth, wide enough that
 * a tap anywhere in an approach channel or roadstead counts, and narrow enough
 * that a point in open water between two harbours names neither. */
export const PORT_RADIUS_NM = 5;

/** Great-circle distance in nautical miles (haversine). Longitudes may sit on
 * either side of the antimeridian: the sine terms make 179.9 and -179.9 close. */
export function distanceNm(latA, lonA, latB, lonB) {
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {Array<[string, number, number]>} ports `[name, lat, lon]` entries
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxNm]
 * @returns {{name: string, lat: number, lon: number, distanceNm: number} | null}
 *   the nearest port within maxNm (nearest wins, ties keep the earlier entry), else null
 */
export function nearestPort(ports, lat, lon, maxNm = PORT_RADIUS_NM) {
  if (!Array.isArray(ports) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
  // A degree of latitude is 60 nm on any meridian: ports further away in latitude need no haversine.
  const latWindow = maxNm / 60;
  let best = null;
  for (const entry of ports) {
    const [name, portLat, portLon] = entry;
    if (Math.abs(portLat - lat) > latWindow) continue;
    const d = distanceNm(lat, lon, portLat, portLon);
    if (d <= maxNm && (!best || d < best.distanceNm)) best = { name, lat: portLat, lon: portLon, distanceNm: d };
  }
  return best;
}
