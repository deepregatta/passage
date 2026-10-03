/**
 * Minimal weather router: time-dependent
 * Dijkstra over a sea grid — earliest-arrival labels whose level sets are the
 * isochrones. Chosen over frontier-pruning isochrone expansion after that
 * approach demonstrably stalled on U-shaped land detours (wall-gap fixture:
 * outward hulls cannot retract, convergent hulls pin against the wall, and
 * upwind returns lose every bucket contest). Dijkstra is provably optimal on
 * the graph and fast enough for the browser. Land checks use the supplied
 * mask and its segment sampler; they are not a navigation safety guarantee.
 *
 * Routing is route ACQUISITION: the computed route carries its leg timing into the audit,
 * flagged as inheriting polar uncertainty.
 */

import { alongCourseComponentKt, windFromDeg } from '../vectors.js';
import { bearingDegTrue, haversineNm, wrap180 } from '../geo.js';
import { parseUtc, toIso } from '../eta.js';
import { GridSampler, type RegionGrid } from '../grids.js';
import { boatSpeedKt, type Polar } from './polar.js';
import { isLand, segmentCrossesLand, type LandMask } from './landmask.js';
import type { Route, Waypoint } from '../types.js';

export interface RoutingRequest {
  start: { lat: number; lon: number; name?: string };
  finish: { lat: number; lon: number; name?: string };
  departureUtc: string;
  polar: Polar;
  /** scales every polar speed (crew/sea-state factor); 1 = table values */
  polarScaling?: number;
  windGrid: RegionGrid;
  currentGrid?: RegionGrid;
  landMask?: LandMask;
  /** graph resolution in degrees; default adapts to the crossing size */
  resolutionDeg?: number;
  maxHours?: number;
  /** diagnostic hook: settled-node count + best arrival so far, every ~500 pops */
  debug?: (info: { settled: number; bestToGoNm: number; hoursOut: number }) => void;
}

export interface RoutingResult {
  route: Route;
  arrival_utc: string;
  duration_h: number;
  distance_nm: number;
  avg_sog_kt: number;
  /** settled graph nodes — a cost indicator */
  steps_used: number;
}

const MIN_SOG_KT = 0.3;

/** 16-direction neighborhood: angular resolution ~22.5° */
const NEIGHBORS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];

export function computeRoute(request: RoutingRequest): RoutingResult {
  const { start, finish, polar, windGrid, currentGrid, landMask } = request;
  const departureMs = parseUtc(request.departureUtc);
  const scaling = request.polarScaling ?? 1;
  const maxMs = (request.maxHours ?? 48) * 3600_000;
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new Error('Routing horizon must be finite and nonnegative');
  const deadlineMs = departureMs + maxMs;
  const noRoute = () => new Error(
    `No route found within ${request.maxHours ?? 48} h (wind coverage, land, or no-go conditions)`,
  );

  if (landMask && (isLand(landMask, start.lat, start.lon) || isLand(landMask, finish.lat, finish.lon))) {
    throw new Error('Start or finish is on land');
  }

  // graph extent: the whole routable area, not a rhumb-line corridor — coastal
  // detours can be far off-axis. Use the wind grid's coverage (intersected with
  // the land mask's extent when present), grown to include the endpoints.
  const windLat1 = windGrid.lat0 + (windGrid.nlat - 1) * windGrid.dlat;
  const windLon1 = windGrid.lon0 + (windGrid.nlon - 1) * windGrid.dlon;
  let lat0 = windGrid.lat0;
  let lat1 = windLat1;
  let lon0 = windGrid.lon0;
  let lon1 = windLon1;
  if (landMask) {
    lat0 = Math.max(lat0, landMask.lat0);
    lat1 = Math.min(lat1, landMask.lat0 + (landMask.nlat - 1) * landMask.dlat);
    lon0 = Math.max(lon0, landMask.lon0);
    lon1 = Math.min(lon1, landMask.lon0 + (landMask.nlon - 1) * landMask.dlon);
  }
  const pad = 0.1;
  lat0 = Math.min(lat0, start.lat - pad, finish.lat - pad);
  lat1 = Math.max(lat1, start.lat + pad, finish.lat + pad);
  lon0 = Math.min(lon0, start.lon - pad, finish.lon - pad);
  lon1 = Math.max(lon1, start.lon + pad, finish.lon + pad);
  const res =
    request.resolutionDeg ?? Math.max(0.02, Math.max(lat1 - lat0, lon1 - lon0) / 150);
  const nlat = Math.max(3, Math.round((lat1 - lat0) / res) + 1);
  const nlon = Math.max(3, Math.round((lon1 - lon0) / res) + 1);

  // Search on the coordinates we can actually emit: rounding a grid node
  // only after routing can move an otherwise valid coastal edge onto land.
  const rounded = (value: number) => Math.round(value * 10000) / 10000;
  const latOf = (i: number) => rounded(lat0 + i * res);
  const lonOf = (j: number) => rounded(lon0 + j * res);
  const id = (i: number, j: number) => i * nlon + j;

  const wind = new GridSampler(windGrid);
  const current = currentGrid ? new GridSampler(currentGrid) : null;
  // Includes the endpoint connections, which previously had zero travel time.
  const travel = (from: { lat: number; lon: number }, to: { lat: number; lon: number }, t: number) => {
    const dist = haversineNm(from.lat, from.lon, to.lat, to.lon);
    if (dist === 0) return { arrivalMs: t, waterNm: 0 };
    const w = wind.sample(from.lat, from.lon, t);
    if (!w) return null;
    const heading = bearingDegTrue(from.lat, from.lon, to.lat, to.lon);
    const stw = boatSpeedKt(polar, Math.hypot(w.u_kt, w.v_kt),
      Math.abs(wrap180(windFromDeg(w.u_kt, w.v_kt) - heading))) * scaling;
    const c = current?.sample(from.lat, from.lon, t) ?? { u_kt: 0, v_kt: 0 };
    const sog = stw + alongCourseComponentKt(c, heading);
    if (stw < MIN_SOG_KT || sog < MIN_SOG_KT) return null;
    const hours = dist / sog;
    const arrivalMs = t + hours * 3600_000;
    return arrivalMs <= deadlineMs ? { arrivalMs, waterNm: stw * hours } : null;
  };

  const snap = (p: { lat: number; lon: number }, fromStart = false): [number, number] => {
    let bi = Math.round((p.lat - lat0) / res);
    let bj = Math.round((p.lon - lon0) / res);
    bi = Math.max(0, Math.min(nlat - 1, bi));
    bj = Math.max(0, Math.min(nlon - 1, bj));
    let hasSeaConnection = false;
    const connects = (i: number, j: number) => {
      const node = { lat: latOf(i), lon: lonOf(j) };
      if (landMask && segmentCrossesLand(landMask, p, node)) return false;
      hasSeaConnection = true;
      return !fromStart || travel(p, node, departureMs) !== null;
    };
    if (!connects(bi, bj)) {
      // A sea node can still be across a peninsula or a thin wall. Search
      // nearby rings for a node with a checked connection to the endpoint.
      for (let r = 1; r < 8; r++) {
        for (let di = -r; di <= r; di++) {
          for (let dj = -r; dj <= r; dj++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = bi + di;
            const j = bj + dj;
            if (i < 0 || i >= nlat || j < 0 || j >= nlon) continue;
            if (connects(i, j)) return [i, j];
          }
        }
      }
      if (hasSeaConnection) throw noRoute();
      throw new Error('No sea node near start/finish');
    }
    return [bi, bj];
  };

  const startPoint = { lat: rounded(start.lat), lon: rounded(start.lon) };
  const finishPoint = { lat: rounded(finish.lat), lon: rounded(finish.lon) };
  if (landMask && (isLand(landMask, startPoint.lat, startPoint.lon) || isLand(landMask, finishPoint.lat, finishPoint.lon))) {
    throw new Error('Start or finish is on land');
  }
  const [si, sj] = snap(startPoint, true);
  const [fi, fj] = snap(finishPoint);
  const startId = id(si, sj);
  const finishId = id(fi, fj);
  const connection = travel(startPoint, { lat: latOf(si), lon: lonOf(sj) }, departureMs);
  if (!connection) throw noRoute();

  // earliest arrival labels + binary heap
  const arrival = new Float64Array(nlat * nlon).fill(Infinity);
  const parent = new Int32Array(nlat * nlon).fill(-1);
  const waterDistance = new Float64Array(nlat * nlon);
  arrival[startId] = connection.arrivalMs;
  waterDistance[startId] = connection.waterNm;

  const heap: Array<{ t: number; node: number }> = [{ t: connection.arrivalMs, node: startId }];
  const push = (t: number, node: number) => {
    heap.push({ t, node });
    let k = heap.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up]!.t <= heap[k]!.t) break;
      [heap[up], heap[k]] = [heap[k]!, heap[up]!];
      k = up;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]!.t < heap[m]!.t) m = l;
        if (r < heap.length && heap[r]!.t < heap[m]!.t) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };

  const settled = new Uint8Array(nlat * nlon);
  let settledCount = 0;
  let terminal: ReturnType<typeof travel> = null;

  while (heap.length) {
    const { t, node } = pop();
    if (settled[node]) continue;
    if (t > deadlineMs) break;
    settled[node] = 1;
    settledCount += 1;
    if (node === finishId) {
      terminal = travel({ lat: latOf(fi), lon: lonOf(fj) }, finishPoint, t);
      break;
    }

    const i = Math.floor(node / nlon);
    const j = node % nlon;
    const fromLat = latOf(i);
    const fromLon = lonOf(j);

    for (const [di, dj] of NEIGHBORS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= nlat || nj < 0 || nj >= nlon) continue;
      const nid = id(ni, nj);
      if (settled[nid]) continue;
      const toLat = latOf(ni);
      const toLon = lonOf(nj);
      if (landMask && isLand(landMask, toLat, toLon)) continue;

      // Even adjacent sea nodes can straddle land in a finer-resolution mask.
      if (
        landMask &&
        segmentCrossesLand(landMask, { lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon })
      ) {
        continue;
      }

      const edge = travel({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, t);
      if (!edge) continue;
      const { arrivalMs } = edge;
      if (arrivalMs < arrival[nid]!) {
        arrival[nid] = arrivalMs;
        waterDistance[nid] = waterDistance[node]! + edge.waterNm;
        parent[nid] = node;
        push(arrivalMs, nid);
      }
    }

    if (request.debug && settledCount % 500 === 0) {
      request.debug({
        settled: settledCount,
        bestToGoNm: Math.round(haversineNm(fromLat, fromLon, finish.lat, finish.lon) * 10) / 10,
        hoursOut: Math.round(((t - departureMs) / 3600_000) * 10) / 10,
      });
    }
  }

  if (!terminal || terminal.arrivalMs > deadlineMs) throw noRoute();

  // backtrack over grid nodes
  const gridPath: Array<{ lat: number; lon: number; timeMs: number; waterNm: number }> = [];
  for (let n = finishId; n !== -1; n = parent[n]!) {
    gridPath.unshift({ lat: latOf(Math.floor(n / nlon)), lon: lonOf(n % nlon), timeMs: arrival[n]!, waterNm: waterDistance[n]! });
  }

  // Keep the checked endpoint-to-grid connections. Replacing the first/last
  // grid nodes can create unchecked legs, even when both snap to one node.
  const path = [
    { ...startPoint, timeMs: departureMs, waterNm: 0 },
    ...gridPath,
    { ...finishPoint, timeMs: terminal.arrivalMs, waterNm: waterDistance[finishId]! + terminal.waterNm },
  ].filter((p, k, points) => k === 0 ||
    p.lat !== points[k - 1]!.lat || p.lon !== points[k - 1]!.lon);
  // Keep real corners regardless of waypoint count. Check each shortcut from
  // the last retained point so consecutive removals cannot cut across land.
  const kept = [path[0]!];
  for (let k = 1; k < path.length - 1; k++) {
    const p = path[k]!;
    const prev = path[k - 1]!;
    const next = path[k + 1]!;
    const straightOn =
      Math.abs(wrap180(bearingDegTrue(prev.lat, prev.lon, p.lat, p.lon) -
        bearingDegTrue(p.lat, p.lon, next.lat, next.lon))) < 12;
    if (!straightOn || (landMask && segmentCrossesLand(landMask, kept.at(-1)!, next))) {
      kept.push(p);
    }
  }
  kept.push(path.at(-1)!);
  if (kept.length < 2 || terminal.arrivalMs <= departureMs) throw noRoute();

  const waypoints: Waypoint[] = kept.map((n, k) => ({
    id: `wp${k + 1}`,
    ...(k === 0 && start.name ? { name: start.name } : {}),
    ...(k === kept.length - 1 && finish.name ? { name: finish.name } : {}),
    lat: rounded(n.lat),
    lon: rounded(n.lon),
  }));

  // Rounding can move a checked point onto land or change the sampled leg.
  // Fail closed for the actual emitted coordinates, including two-point paths.
  if (landMask && waypoints.some((to, k) => k > 0 &&
    segmentCrossesLand(landMask, waypoints[k - 1]!, to))) {
    throw new Error(
      `No route found within ${request.maxHours ?? 48} h (wind coverage, land, or no-go conditions)`,
    );
  }

  let distance = 0;
  for (let k = 1; k < kept.length; k++) {
    distance += haversineNm(kept[k - 1]!.lat, kept[k - 1]!.lon, kept[k]!.lat, kept[k]!.lon);
  }
  const durationH = (terminal.arrivalMs - departureMs) / 3600_000;
  const avgSog = distance / durationH;
  const avgStw = (waterDistance[finishId]! + terminal.waterNm) / durationH;

  const route: Route = {
    schema_version: 1,
    route_id: `computed-${request.departureUtc.slice(0, 13).replace(/[-T:]/g, '')}-${polar.polar_id}`,
    name: `${start.name ?? 'Start'} → ${finish.name ?? 'Finish'} (computed)`,
    mode: 'computed',
    waypoints,
    // Through-water speeds remain available if this geometry is reused as a
    // drawn route. Routed audits use the per-leg durations below, including current.
    speeds_kt: {
      slow: Math.round(avgStw * 0.85 * 10) / 10,
      nominal: Math.round(avgStw * 10) / 10,
      fast: Math.round(avgStw * 1.15 * 10) / 10,
    },
    timing: {
      basis: 'routed', departure_utc: new Date(departureMs).toISOString(),
      legs: kept.slice(1).map((point, i) => {
        const prev = kept[i]!;
        const duration = point.timeMs - prev.timeMs;
        return {
          leg_id: `L${i + 1}`,
          duration_ms: { slow: duration / 0.85, nominal: duration, fast: duration / 1.15 },
          through_water_kt: (point.waterNm - prev.waterNm) * 3600_000 / duration,
          speed_over_ground_kt: haversineNm(prev.lat, prev.lon, point.lat, point.lon) * 3600_000 / duration,
        };
      }),
    },
    provenance: {
      engine_version: 'grid-dijkstra-v1',
      routing_request: {
        departure: request.departureUtc,
        polar_id: polar.polar_id,
        polar_scaling: scaling,
        wind_run: windGrid.run_id,
        current_run: currentGrid?.run_id ?? null,
        resolution_deg: Math.round(res * 1000) / 1000,
      },
      polar_ref: polar.polar_id,
      computed_at: toIso(Date.now()),
    },
  };

  return {
    route,
    arrival_utc: toIso(terminal.arrivalMs),
    duration_h: Math.round(durationH * 10) / 10,
    distance_nm: Math.round(distance * 10) / 10,
    avg_sog_kt: Math.round(avgSog * 100) / 100,
    steps_used: settledCount,
  };
}
