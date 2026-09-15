/**
 * Declared-limits evaluation: course-relative wind, per condition,
 * per hour. 25 kt on the beam is not 25 kt hard on the nose.
 */

import { wrap180 } from './geo.js';
import type { LimitsProfile, PointOfSail } from './types.js';

export type LimitStatus = 'ok' | 'approaching' | 'exceeded' | 'unknown';

export const DEFAULT_APPROACHING_RATIO = 0.75;

/** True wind angle off the bow, degrees [0, 180]. windFromDeg is where the wind comes FROM. */
export function trueWindAngle(windFromDeg: number, courseDegTrue: number): number {
  return Math.abs(wrap180(windFromDeg - courseDegTrue));
}

export function pointOfSail(twaDeg: number): PointOfSail {
  if (twaDeg < 60) return 'upwind';
  if (twaDeg <= 120) return 'reach';
  return 'downwind';
}

export function sustainedLimitKt(profile: LimitsProfile, pos: PointOfSail): number {
  return profile.max_sustained_kt[pos] ?? profile.max_sustained_kt.default;
}

export function evaluateAgainstLimit(
  value: number | null,
  limit: number,
  approachingRatio: number,
): LimitStatus {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value > limit) return 'exceeded';
  if (value >= approachingRatio * limit) return 'approaching';
  return 'ok';
}

export function approachingRatio(profile: LimitsProfile): number {
  return profile.approaching_ratio ?? DEFAULT_APPROACHING_RATIO;
}
