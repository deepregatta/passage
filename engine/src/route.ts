/** Route geometry: legs and sample points derived deterministically from waypoints. */

import { bearingDegTrue, haversineNm, interpolatePosition } from './geo.js';
import type { Leg, Route, SamplePoint } from './types.js';

export function deriveLegs(route: Route): Leg[] {
  if (route.waypoints.length < 2) {
    throw new Error(`Route ${route.route_id} needs at least 2 waypoints`);
  }
  const legs: Leg[] = [];
  let cumulative = 0;
  for (let i = 0; i < route.waypoints.length - 1; i++) {
    const from = route.waypoints[i]!;
    const to = route.waypoints[i + 1]!;
    const distance = haversineNm(from.lat, from.lon, to.lat, to.lon);
    cumulative += distance;
    legs.push({
      leg_id: `L${i + 1}`,
      from,
      to,
      distance_nm: round2(distance),
      bearing_deg_true: round1(bearingDegTrue(from.lat, from.lon, to.lat, to.lon)),
      dist_end_nm: round2(cumulative),
    });
  }
  return legs;
}

export function totalDistanceNm(legs: Leg[]): number {
  return legs.length ? legs[legs.length - 1]!.dist_end_nm : 0;
}

/**
 * Densified sample points every ~spacingNm along the route (leg midpoint guaranteed
 * for short legs). Deterministic: same route -> same points. These are the positions
 * used for point-forecast fetches and (later) grid sampling.
 */
export function deriveSamplePoints(legs: Leg[], spacingNm = 5): SamplePoint[] {
  const points: SamplePoint[] = [];
  let distStart = 0;
  let counter = 0;
  for (const leg of legs) {
    const n = Math.max(1, Math.round(leg.distance_nm / spacingNm));
    for (let k = 0; k < n; k++) {
      const fraction = (k + 0.5) / n;
      const pos = interpolatePosition(leg.from, leg.to, fraction);
      counter += 1;
      points.push({
        point_id: `P${counter}`,
        leg_id: leg.leg_id,
        lat: round4(pos.lat),
        lon: round4(pos.lon),
        dist_from_start_nm: round2(distStart + leg.distance_nm * fraction),
      });
    }
    distStart += leg.distance_nm;
  }
  return points;
}

/** Representative point per leg (midpoint sample) for per-leg condition evaluation. */
export function legMidpoints(legs: Leg[]): SamplePoint[] {
  return legs.map((leg, i) => {
    const pos = interpolatePosition(leg.from, leg.to, 0.5);
    return {
      point_id: `M${i + 1}`,
      leg_id: leg.leg_id,
      lat: round4(pos.lat),
      lon: round4(pos.lon),
      dist_from_start_nm: round2(leg.dist_end_nm - leg.distance_nm / 2),
    };
  });
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;
