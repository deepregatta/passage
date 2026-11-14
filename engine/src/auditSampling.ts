/**
 * Where and when the audit reads the forecast along a route
 * (engine semantics `passage-audit-4`, 2026-11-14). The one place the sample
 * points are made: the Check, the departure comparison and its refinement
 * (all through runAnalysis), and the download estimate (auditSamplePlan) use
 * these functions, so they cannot disagree.
 *
 * Placement. Each leg is cut into n = ceil(distance / AUDIT_SAMPLE_SPACING_NM)
 * equal stretches (at least one) and read at the middle of each stretch, so
 * consecutive points are at most 10 nm apart and each end of a leg is at most
 * 5 nm from a point. A leg of 10 nm or less keeps its midpoint. Cutting a
 * track into more waypoints along the same line reads the same places when
 * the cuts fall on stretch boundaries (one 60 nm leg, six 10 nm legs), and
 * nearly the same otherwise. Positions are interpolated along the leg exactly
 * as the timing is (geo.interpolatePosition) and kept to 1e-4 degree; they are
 * never rounded to a forecast lattice.
 *
 * Hours. A point stands for its stretch of the leg. It is judged for the
 * whole hours the boat can be in that stretch: from the earliest entry into
 * it (fast scenario at the stretch start) to the latest exit (slow scenario
 * at the stretch end), floored and ceiled to whole hours, the rule the tidal
 * gates use for a point (hazards/tides.ts) applied to both ends of the
 * stretch. The union over a leg's points is the leg's occupancy hours, so
 * every leg hour has at least one point. The timing itself (ETA ranges, the
 * ±15 % rule for computed routes, the current correction) is eta.ts's,
 * unchanged.
 *
 * Expected position. On the expected (nominal) timing the boat is in one
 * stretch at a time: `expectedPointIndex` names it (clamped to the leg), for
 * whatever reads the expected timing (route summary, charts, the expected
 * hours over a limit).
 */

import { hourlyRange, parseUtc, type LegSchedule } from './eta.js';
import { interpolatePosition } from './geo.js';
import type { Leg } from './types.js';

/** Largest distance between two consecutive audit points on a leg, nm. */
export const AUDIT_SAMPLE_SPACING_NM = 10;

export interface AuditSamplePoint {
  /** `L<leg>.<k>`, k from 1 along the leg */
  point_id: string;
  leg_id: string;
  /** index of the leg in deriveLegs(route) */
  leg_index: number;
  /** index of the point within its leg, and how many points the leg has */
  index_in_leg: number;
  points_in_leg: number;
  lat: number;
  lon: number;
  /** the stretch of the leg the point stands for, as fractions of the leg */
  from_fraction: number;
  to_fraction: number;
}

/** How many stretches a leg of this length is cut into. */
export function stretchCount(distanceNm: number): number {
  if (!Number.isFinite(distanceNm) || distanceNm <= 0) return 1;
  return Math.max(1, Math.ceil(distanceNm / AUDIT_SAMPLE_SPACING_NM - 1e-9));
}

/** Every audit sample point of the legs, leg by leg, along each leg. */
export function auditSamplePoints(legs: readonly Leg[]): AuditSamplePoint[] {
  const out: AuditSamplePoint[] = [];
  legs.forEach((leg, legIndex) => {
    const n = stretchCount(leg.distance_nm);
    for (let k = 0; k < n; k++) {
      const pos = interpolatePosition(leg.from, leg.to, (k + 0.5) / n);
      out.push({
        point_id: `${leg.leg_id}.${k + 1}`,
        leg_id: leg.leg_id,
        leg_index: legIndex,
        index_in_leg: k,
        points_in_leg: n,
        lat: round4(pos.lat),
        lon: round4(pos.lon),
        from_fraction: k / n,
        to_fraction: (k + 1) / n,
      });
    }
  });
  return out;
}

/** The interval the boat can be in the point's stretch: earliest entry (fast) to latest exit (slow), ms. */
export function pointWindowMs(point: AuditSamplePoint, schedule: LegSchedule): { fromMs: number; toMs: number } {
  const enterFast = parseUtc(schedule.enter.fast);
  const exitFast = parseUtc(schedule.exit.fast);
  const enterSlow = parseUtc(schedule.enter.slow);
  const exitSlow = parseUtc(schedule.exit.slow);
  return {
    fromMs: enterFast + (exitFast - enterFast) * point.from_fraction,
    toMs: enterSlow + (exitSlow - enterSlow) * point.to_fraction,
  };
}

/** The whole hours a point is judged for (see the module comment). */
export function pointHours(point: AuditSamplePoint, schedule: LegSchedule): string[] {
  const { fromMs, toMs } = pointWindowMs(point, schedule);
  return hourlyRange(fromMs, toMs);
}

/**
 * For each of the leg's occupancy hours, the indices (into `points`) of the
 * leg's points whose hours include it, in order along the leg.
 */
export function legHourCandidates(
  points: readonly AuditSamplePoint[],
  schedule: LegSchedule,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const hour of schedule.occupancy_hours) out.set(hour, []);
  points.forEach((point, index) => {
    for (const hour of pointHours(point, schedule)) out.get(hour)?.push(index);
  });
  return out;
}

/**
 * The index (within its leg, 0-based) of the stretch the boat is in at
 * `timeMs` on the nominal timing of a leg cut into `pointsInLeg` stretches,
 * clamped to the leg: before the nominal entry the first, after the nominal
 * exit the last.
 */
export function expectedPointIndex(
  pointsInLeg: number,
  nominal: { enterMs: number; exitMs: number },
  timeMs: number,
): number {
  if (pointsInLeg <= 1) return 0;
  const span = nominal.exitMs - nominal.enterMs;
  const fraction = span > 0 ? (timeMs - nominal.enterMs) / span : timeMs < nominal.enterMs ? 0 : 1;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.min(pointsInLeg - 1, Math.floor(clamped * pointsInLeg));
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
