/**
 * How much forecast data Compute, Scan and Check download, quoted before the
 * button is pressed. The tile lists come from the engine's request builders
 * (`routingTileRequests`, `auditTileRequests`, `auditSamplePlan`,
 * `currentGridBbox`), which are the ones the store's reads and `runAnalysis`
 * are built from, and the drift tests compare them with a real store's reads.
 * Nothing here reads a tile: it reads the pinned run manifests (already loaded
 * once the store is initialised) and asks the store which tiles it already holds.
 *
 * The figure is an estimate designed as an upper bound. It can still be low
 * when a forecast run is published between the quote and the press, when a day
 * boundary widens a scan's window, or when a held tile fails its checksum or is
 * evicted before the action runs.
 */

import {
  auditSamplePlan, auditTileRequests, candidateDepartures, currentGridBbox, quoteTileDownload, routeBbox, routingTileRequests,
} from '@deepweather/engine';
import { fmtGribBytes } from './gribExport.js';
import { scanDateWindow } from './scanWindow.js';

const NONE = Object.freeze({ compute: null, scan: null, check: null });

/** The departures of a comparison and the scan the Planner runs for them. */
const SCAN_SPAN_H = 120;
const SCAN_STEP_H = 6;

/** An action's quote, or null when it cannot be worked out (bad inputs, no tiles for the area). */
async function quoted(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * The quotes of the actions asked for in `want`, from the manifests of a
 * loaded store. Each is a TileQuote, or null.
 *
 * - compute: the wind and current grids over the box of the two endpoints.
 * - check: the audit's point layers at the route's leg points, the ECMWF
 *   layers its window picks, every enabled regional model overlapping them, and the
 *   current tiles unless a prepared grid covers the route. That last cannot be
 *   known before the press, so the current tiles are counted: an upper bound.
 * - scan: for a drawn route, the audit of each candidate departure over the same
 *   route. For a computed route, Compute's grids plus the audit over the whole
 *   route box (each candidate is routed afresh, so its leg points are not known
 *   yet), both ECMWF layers, and no current tiles of its own (a scan is handed
 *   the routing grid).
 *
 * @param {object} input
 * @param {{ manifestFor: Function, listedLayers?: Function, regionalLayerIds?: Function, hasTile?: Function }} input.store
 * @param {(layer: string) => object | null} input.manifests
 * @param {{ compute?: boolean, scan?: boolean, check?: boolean }} input.want
 * @param {'compute' | 'draw'} input.mode
 * @param {Array<{ lat: number, lng: number }>} input.endpoints
 * @param {string | null} input.polarId
 * @param {object | null} input.route  the route Check audits (drawn, or the computed one)
 * @param {string} input.departureUtc
 * @param {number | null} input.passageHours  the drawn route's nominal passage time, as the scan uses it
 * @param {number} [input.nowMs]
 */
export async function quotePlannerActions({
  store, manifests, want, mode, endpoints, polarId, route, departureUtc, passageHours, nowMs = Date.now(),
}) {
  if (!manifests('weather')) return NONE;
  const listed = typeof store.listedLayers === 'function' ? store.listedLayers() : undefined;
  const regionalLayers = typeof store.regionalLayerIds === 'function' ? store.regionalLayerIds() : [];
  const isCached = typeof store.hasTile === 'function' ? (tile) => store.hasTile(tile.layer, tile.tileId) : null;
  const quote = (requests) => quoteTileDownload(requests, manifests, { isCached, ...(listed ? { listed } : {}) });
  const endpointBox = () => routeBbox(
    { lat: endpoints[0].lat, lon: endpoints[0].lng }, { lat: endpoints[1].lat, lon: endpoints[1].lng },
  );
  const routedScan = mode === 'compute' && endpoints.length === 2 && Boolean(polarId);
  const audit = (plan, extra = {}) => auditTileRequests(manifests, {
    where: { points: plan.points }, window: plan, regionalLayers, currents: currentGridBbox([route]), ...extra,
  });

  const compute = want.compute && mode === 'compute' && endpoints.length === 2
    ? quoted(() => quote(routingTileRequests(endpointBox())))
    : null;
  const check = want.check && route && departureUtc
    ? quoted(() => quote(audit(auditSamplePlan(route, departureUtc))))
    : null;
  let scan = null;
  if (want.scan && routedScan) {
    scan = quoted(() => {
      const box = endpointBox();
      return quote([...routingTileRequests(box), ...auditTileRequests(manifests, { where: { area: box }, regionalLayers })]);
    });
  } else if (want.scan && route && departureUtc) {
    scan = quoted(() => {
      const departures = candidateDepartures(Date.parse(departureUtc), SCAN_SPAN_H, SCAN_STEP_H);
      const dateWindow = scanDateWindow(departures, passageHours ?? 48, nowMs);
      const requests = departures.flatMap((departure) => {
        try {
          return audit(auditSamplePlan(route, departure, dateWindow));
        } catch {
          return []; // the scan skips a candidate it cannot schedule
        }
      });
      return quote(requests);
    });
  }
  const [computeQuote, scanQuote, checkQuote] = await Promise.all([compute, scan, check]);
  return { compute: computeQuote, scan: scanQuote, check: checkQuote };
}

/**
 * The line under a button. Nothing when the figure cannot be known: no tile
 * published for the area, or a layer that could not be quoted with nothing
 * else left to fetch.
 * @param {import('@deepweather/engine').TileQuote | null} quote
 * @returns {string | null}
 */
export function downloadLine(quote) {
  if (!quote || quote.tiles === 0) return null;
  if (quote.downloadTiles === 0) return quote.lowerBound ? null : 'Forecast tiles already on this device';
  return `Downloads ${quote.lowerBound ? 'at least' : 'up to'} ${fmtGribBytes(quote.downloadBytes)} of forecast tiles`;
}
