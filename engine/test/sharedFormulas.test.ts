import { describe, expect, it } from 'vitest';
import { alongCourseKt } from '../src/grids.js';
import { computeSchedules } from '../src/eta.js';
import { approachingRatio, evaluateAgainstLimit } from '../src/limits.js';
import { windFromDeg, alongCourseComponentKt } from '../src/vectors.js';
import { limitRelation } from '../src/plainLanguage.js';
import { assessCrossSea } from '../src/hazards/waves.js';
import { squallPotential } from '../src/hazards/convective.js';
import type { LimitsProfile } from '../src/types.js';

describe('shared formula behavior', () => {
  it('keeps rounded current evidence separate from full-precision ETA calculations', () => {
    const current = { u_kt: 1.234, v_kt: 0 };
    expect(alongCourseKt(current, 90)).toBe(1.23);
    expect(alongCourseKt(current, 270)).toBe(-1.23);
    const [schedule] = computeSchedules([{
      leg_id: 'L1', from: { id: 'a', lat: 0, lon: 0 }, to: { id: 'b', lat: 0, lon: 1 },
      distance_nm: 20, bearing_deg_true: 90, dist_end_nm: 20,
    }], { slow: 4, nominal: 5, fast: 6 }, '2026-07-20T00:00:00Z', () => current);
    expect(schedule!.sog_kt.nominal).toBe(6.23);
    // 20 nm / 6.234 kt, truncated to whole seconds; rounding current first gives 03:12:37.
    expect(schedule!.exit.nominal).toBe('2026-07-20T03:12:29Z');
  });

  it('shares the default approaching boundary with plain wording while honoring profile overrides', () => {
    const profile: LimitsProfile = {
      schema_version: 1, profile_id: 'test', label: 'Test', declared: true,
      max_sustained_kt: { default: 20 }, max_gust_kt: 28,
    };
    expect(approachingRatio(profile)).toBe(0.75);
    for (const [value, status, relation] of [
      [14.999, 'ok', 'under'], [15, 'approaching', 'close to'],
      [20, 'approaching', 'close to'], [20.001, 'exceeded', 'over'],
    ] as const) {
      expect(evaluateAgainstLimit(value, 20, approachingRatio(profile))).toBe(status);
      expect(limitRelation(value, 20)).toBe(relation);
    }
    expect(approachingRatio({ ...profile, approaching_ratio: 0.9 })).toBe(0.9);
  });

  it('uses the unrounded cross-sea angle and inclusive component-height boundaries', () => {
    expect(assessCrossSea(0.5, 0, 0.5, 45)).toEqual({ angle_deg: 45, significant: false });
    expect(assessCrossSea(0.5, 0, 0.5, 45.01)).toEqual({ angle_deg: 45, significant: true });
    expect(assessCrossSea(0.499, 0, 0.5, 90)!.significant).toBe(false);
    expect(assessCrossSea(0.5, 0, 0.499, 90)!.significant).toBe(false);
    expect(assessCrossSea(null, 0, 0.5, 90)).toBeNull();
  });

  it.each([
    [299.999, 'low'], [300, 'elevated'], [999.999, 'elevated'], [1000, 'high'],
    [null, null], [NaN, null], [Infinity, null],
  ])('retains the CAPE screening boundary at %s', (cape, level) => {
    expect(squallPotential(cape)).toBe(level);
  });
});

describe('vector conventions', () => {
  it.each([
    [0, -10, 0], [-10, 0, 90], [0, 10, 180], [10, 0, 270],
    [-10, -10, 45], [-10, 10, 135], [10, 10, 225], [10, -10, 315],
    [0, 0, 180], // Retain the existing signed-zero atan2 convention for calm wind.
  ])('wind vector (%s, %s) comes FROM %s degrees', (u, v, expected) => {
    expect(windFromDeg(u, v)).toBe(expected);
  });

  it('preserves north wrap and unrounded diagonal current projection', () => {
    expect(windFromDeg(-0.01, -10)).toBeCloseTo(0.05729576, 7);
    expect(windFromDeg(0.01, -10)).toBeCloseTo(359.94270424, 7);
    expect(alongCourseComponentKt({ u_kt: 1, v_kt: 1 }, 45)).toBeCloseTo(Math.SQRT2, 14);
    expect(alongCourseComponentKt({ u_kt: 1.234, v_kt: 0 }, 90)).toBe(1.234);
  });
});
