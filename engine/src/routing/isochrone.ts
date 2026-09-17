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
 * Routing is route ACQUISITION: the computed route feeds the unchanged audit,
 * flagged as inheriting polar uncertainty.
 */

import { alongCourseComponentKt, windFromDeg } from '../vectors.js';
import { bearingDegTrue, haversineNm, wrap180 } from '../geo.js';
import { toIso } from '../eta.js';
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
  const scaling = request.polarScaling ?? 1;
  const maxMs = (request.maxHours ?? 48) * 3600_000;

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
  const departureMs = Date.parse(request.departureUtc);

  const snap = (p: { lat: number; lon: number }): [number, number] => {
    let bi = Math.round((p.lat - lat0) / res);
    let bj = Math.round((p.lon - lon0) / res);
    bi = Math.max(0, Math.min(nlat - 1, bi));
    bj = Math.max(0, Math.min(nlon - 1, bj));
    const connects = (i: number, j: number) => !landMask ||
      !segmentCrossesLand(landMask, p, { lat: latOf(i), lon: lonOf(j) });
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
      throw new Error('No sea node near start/finish');
    }
    return [bi, bj];
  };

  const [si, sj] = snap(start);
  const [fi, fj] = snap(finish);
  const startId = id(si, sj);
  const finishId = id(fi, fj);

  // earliest arrival labels + binary heap
  const arrival = new Float64Array(nlat * nlon).fill(Infinity);
  const parent = new Int32Array(nlat * nlon).fill(-1);
  arrival[startId] = departureMs;

  const heap: Array<{ t: number; node: number }> = [{ t: departureMs, node: startId }];
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

  while (heap.length) {
    const { t, node } = pop();
    if (settled[node]) continue;
    settled[node] = 1;
    settledCount += 1;
    if (node === finishId) break;
    if (t - departureMs > maxMs) continue;

    const i = Math.floor(node / nlon);
    const j = node % nlon;
    const fromLat = latOf(i);
    const fromLon = lonOf(j);

    const w = wind.sample(fromLat, fromLon, t);
    if (!w) continue; // outside wind coverage (space or time): branch ends
    const twsKt = Math.hypot(w.u_kt, w.v_kt);
    const windDirection = windFromDeg(w.u_kt, w.v_kt);
    const c = current?.sample(fromLat, fromLon, t) ?? { u_kt: 0, v_kt: 0 };

    for (const [di, dj] of NEIGHBORS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= nlat || nj < 0 || nj >= nlon) continue;
      const nid = id(ni, nj);
      if (settled[nid]) continue;
      const toLat = latOf(ni);
      const toLon = lonOf(nj);
      if (landMask && isLand(landMask, toLat, toLon)) continue;

      const heading = bearingDegTrue(fromLat, fromLon, toLat, toLon);
      const twa = Math.abs(wrap180(windDirection - heading));
      const stw = boatSpeedKt(polar, twsKt, twa) * scaling;
      const along = alongCourseComponentKt(c, heading);
      const sog = stw + along;
      if (stw < MIN_SOG_KT || sog < MIN_SOG_KT) continue;

      // Even adjacent sea nodes can straddle land in a finer-resolution mask.
      if (
        landMask &&
        segmentCrossesLand(landMask, { lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon })
      ) {
        continue;
      }

      const dist = haversineNm(fromLat, fromLon, toLat, toLon);
      const arrivalMs = t + (dist / sog) * 3600_000;
      if (arrivalMs < arrival[nid]!) {
        arrival[nid] = arrivalMs;
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

  if (!settled[finishId] || !Number.isFinite(arrival[finishId]!)) {
    throw new Error(
      `No route found within ${request.maxHours ?? 48} h (wind coverage, land, or no-go conditions)`,
    );
  }

  // backtrack over grid nodes
  const gridPath: Array<{ lat: number; lon: number; timeMs: number }> = [];
  for (let n = finishId; n !== -1; n = parent[n]!) {
    gridPath.unshift({ lat: latOf(Math.floor(n / nlon)), lon: lonOf(n % nlon), timeMs: arrival[n]! });
  }

  // Keep the checked endpoint-to-grid connections. Replacing the first/last
  // grid nodes can create unchecked legs, even when both snap to one node.
  const path = [
    { lat: start.lat, lon: start.lon, timeMs: departureMs },
    ...gridPath,
    { lat: finish.lat, lon: finish.lon, timeMs: arrival[finishId]! },
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
  for (let k = 1; k < path.length; k++) {
    distance += haversineNm(path[k - 1]!.lat, path[k - 1]!.lon, path[k]!.lat, path[k]!.lon);
  }
  const durationH = (arrival[finishId]! - departureMs) / 3600_000;
  const avgSog = distance / Math.max(0.1, durationH);

  const route: Route = {
    schema_version: 1,
    route_id: `computed-${request.departureUtc.slice(0, 13).replace(/[-T:]/g, '')}-${polar.polar_id}`,
    name: `${start.name ?? 'Start'} → ${finish.name ?? 'Finish'} (computed)`,
    mode: 'computed',
    waypoints,
    // the audit's ETA machinery needs slow/nominal/fast: derived from the routed
    // average SOG ±15% — a documented approximation inheriting polar uncertainty
    speeds_kt: {
      slow: Math.max(0.5, Math.round(avgSog * 0.85 * 10) / 10),
      nominal: Math.round(avgSog * 10) / 10,
      fast: Math.round(avgSog * 1.15 * 10) / 10,
    },
    provenance: {
      engine_version: 'grid-dijkstra-v0',
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
    arrival_utc: toIso(arrival[finishId]!),
    duration_h: Math.round(durationH * 10) / 10,
    distance_nm: Math.round(distance * 10) / 10,
    avg_sog_kt: Math.round(avgSog * 100) / 100,
    steps_used: settledCount,
  };
}
