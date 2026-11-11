import { PORT_RADIUS_NM, nearestPort } from './portLookup.js';

/** The bundled list of ports (viewer/src/data/ports.json, see its PROVENANCE.md),
 * loaded on first use as its own chunk so first paint does not pay for it. It is
 * a static file of the Passage site: reading it sends nothing about any route. */

let listPromise = null;
let loaded = null;

/** Starts (once) and returns the load of the list. Resolves to the entries, or to
 * null when the file cannot be loaded: every caller then carries on without names,
 * and the next call tries again. */
export function loadPorts() {
  listPromise ??= import('../data/ports.json')
    .then((module) => {
      const list = module.default?.ports;
      if (!Array.isArray(list) || list.length === 0) throw new Error('empty port list');
      loaded = list;
      return list;
    })
    .catch(() => {
      listPromise = null;
      return null;
    });
  return listPromise;
}

/** The list if it has finished loading, else null. */
export const loadedPorts = () => loaded;

/** Port name for a point, from the loaded list only (null when not loaded or none in range). */
export function portNameAt(lat, lng, maxNm = PORT_RADIUS_NM) {
  return loaded ? nearestPort(loaded, lat, lng, maxNm)?.name ?? null : null;
}

export function clearPortsCacheForTests() {
  listPromise = null;
  loaded = null;
}
