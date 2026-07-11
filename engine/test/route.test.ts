import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveLegs, deriveSamplePoints, legMidpoints, totalDistanceNm } from '../src/route.js';
import { haversineNm, bearingDegTrue, wrap180 } from '../src/geo.js';
import type { Route } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const route = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'config', 'routes', 'cherbourg-plymouth.json'), 'utf8'),
) as Route;

describe('geo', () => {
  it('haversine: Cherbourg to Plymouth is ~100 nm great circle', () => {
    const d = haversineNm(49.665, -1.645, 50.333, -4.175);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(110);
  });

  it('bearing: due north and due east', () => {
    expect(bearingDegTrue(50, -3, 51, -3)).toBeCloseTo(0, 0);
    expect(bearingDegTrue(0, 0, 0, 1)).toBeCloseTo(90, 0);
  });

  it('wrap180 wraps correctly', () => {
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    expect(wrap180(180)).toBe(180);
    expect(wrap180(0)).toBe(0);
  });
});

describe('route derivation (Cherbourg → Plymouth)', () => {
  const legs = deriveLegs(route);

  it('derives 6 legs from 7 waypoints, total ~105 nm', () => {
    expect(legs).toHaveLength(6);
    const total = totalDistanceNm(legs);
    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThan(115);
  });

  it('route generally heads W/NW (bearings 270–330 for main legs)', () => {
    for (const leg of legs.slice(1, 5)) {
      expect(leg.bearing_deg_true).toBeGreaterThan(260);
      expect(leg.bearing_deg_true).toBeLessThan(340);
    }
  });

  it('sample points are ~5 nm apart and monotonically increasing', () => {
    const points = deriveSamplePoints(legs, 5);
    expect(points.length).toBeGreaterThan(15);
    for (let i = 1; i < points.length; i++) {
      const gap = points[i]!.dist_from_start_nm - points[i - 1]!.dist_from_start_nm;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(12);
    }
  });

  it('midpoints: one per leg, on the leg', () => {
    const mids = legMidpoints(legs);
    expect(mids).toHaveLength(legs.length);
    expect(mids[0]!.leg_id).toBe('L1');
  });

  it('is deterministic', () => {
    expect(deriveLegs(route)).toEqual(legs);
  });
});
