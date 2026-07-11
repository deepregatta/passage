import { describe, expect, it } from 'vitest';
import {
  evaluateAgainstLimit,
  pointOfSail,
  sustainedLimitKt,
  trueWindAngle,
} from '../src/limits.js';
import { computeSchedules, parseUtc } from '../src/eta.js';
import { decideVerdict } from '../src/verdict.js';
import type { Leg, LimitsProfile } from '../src/types.js';

const profile: LimitsProfile = {
  schema_version: 1,
  profile_id: 'test',
  label: 'Test',
  declared: true,
  max_sustained_kt: { default: 22, upwind: 18, reach: 25, downwind: 25 },
  max_gust_kt: 28,
  approaching_ratio: 0.75,
};

describe('course-relative wind', () => {
  it('TWA: wind from 270 on course 300 = 30° (upwind)', () => {
    expect(trueWindAngle(270, 300)).toBe(30);
    expect(pointOfSail(30)).toBe('upwind');
  });

  it('TWA: wind from 200 on course 290 = 90° (reach)', () => {
    expect(trueWindAngle(200, 290)).toBe(90);
    expect(pointOfSail(90)).toBe('reach');
  });

  it('TWA wraps across north: wind from 350 on course 10 = 20°', () => {
    expect(trueWindAngle(350, 10)).toBe(20);
  });

  it('limit picked by point of sail: 25 kt on the beam ok, same wind upwind exceeded', () => {
    expect(sustainedLimitKt(profile, 'reach')).toBe(25);
    expect(sustainedLimitKt(profile, 'upwind')).toBe(18);
    expect(evaluateAgainstLimit(24, 25, 0.75)).toBe('approaching');
    expect(evaluateAgainstLimit(24, 18, 0.75)).toBe('exceeded');
  });

  it('status thresholds: ok < approaching(≥75%) < exceeded(>100%), null=unknown', () => {
    expect(evaluateAgainstLimit(10, 28, 0.75)).toBe('ok');
    expect(evaluateAgainstLimit(21, 28, 0.75)).toBe('approaching');
    expect(evaluateAgainstLimit(28, 28, 0.75)).toBe('approaching'); // at limit, not over
    expect(evaluateAgainstLimit(28.1, 28, 0.75)).toBe('exceeded');
    expect(evaluateAgainstLimit(null, 28, 0.75)).toBe('unknown');
  });
});

describe('ETA schedules', () => {
  const legs: Leg[] = [
    {
      leg_id: 'L1',
      from: { id: 'a', lat: 49.6, lon: -1.6 },
      to: { id: 'b', lat: 49.8, lon: -2.0 },
      distance_nm: 22,
      bearing_deg_true: 300,
      dist_end_nm: 22,
    },
    {
      leg_id: 'L2',
      from: { id: 'b', lat: 49.8, lon: -2.0 },
      to: { id: 'c', lat: 50.0, lon: -2.6 },
      distance_nm: 26,
      bearing_deg_true: 300,
      dist_end_nm: 48,
    },
  ];

  it('slow ETA is always after fast ETA, occupancy covers the spread', () => {
    const schedules = computeSchedules(legs, { slow: 4, nominal: 5, fast: 6 }, '2026-07-12T06:00:00Z');
    for (const s of schedules) {
      expect(parseUtc(s.exit.slow)).toBeGreaterThan(parseUtc(s.exit.fast));
      expect(parseUtc(s.occupancy_hours[0]!)).toBeLessThanOrEqual(parseUtc(s.enter.fast));
      expect(
        parseUtc(s.occupancy_hours[s.occupancy_hours.length - 1]!),
      ).toBeGreaterThanOrEqual(parseUtc(s.exit.slow));
    }
    // 48 nm at 4 kt = 12 h; slow exit of L2 = 18:00Z
    expect(schedules[1]!.exit.slow).toBe('2026-07-12T18:00:00Z');
  });
});

describe('verdict', () => {
  const base = { worstRatio: null, anyExceeded: false, anyApproaching: false, driverEvidenceId: null };

  it('states escalate: within < approaching < exceeds', () => {
    expect(decideVerdict({ ...base }).state).toBe('within');
    expect(decideVerdict({ ...base, anyApproaching: true }).state).toBe('approaching');
    expect(decideVerdict({ ...base, anyExceeded: true }).state).toBe('exceeds');
  });

  it('insufficient confidence beats limit states', () => {
    expect(decideVerdict({ ...base, anyExceeded: true, insufficientConfidence: true }).state).toBe(
      'insufficient',
    );
  });

  it('warning override beats everything (authority state)', () => {
    const v = decideVerdict({
      ...base,
      anyExceeded: true,
      insufficientConfidence: true,
      warningActive: true,
      warningBulletinRef: 'bms-1',
    });
    expect(v.state).toBe('warning_active');
    expect(v.warning_override).toEqual({ active: true, bulletin_ref: 'bms-1' });
  });
});
