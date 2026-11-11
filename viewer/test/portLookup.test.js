import { describe, expect, it } from 'vitest';
import { PORT_RADIUS_NM, distanceNm, nearestPort } from '../src/lib/portLookup.js';

// Invented harbours for the mechanics; real names and positions (to a few
// decimals, as in the bundled list) where the geography matters.
const INVENTED = [
  ['Alpha', 10, 20],
  ['Beta', 10.05, 20],
  ['Gamma', 10, 30],
];
const REAL = [
  ['Cherbourg', 49.65, -1.62],
  ['Plymouth', 50.364, -4.143],
  ['Newport', 41.49, -71.327],
  ['New York', 40.7, -74.02],
  ['Palma', 39.56, 2.64],
  ['Barcelona', 41.35, 2.17],
  ['Brisbane', -27.38, 153.17],
  ['Gladstone', -23.83, 151.26],
];

describe('distanceNm', () => {
  it('is one nautical mile per arc minute of latitude', () => {
    expect(distanceNm(0, 0, 1 / 60, 0)).toBeCloseTo(1, 2);
    expect(distanceNm(45, 10, 46, 10)).toBeCloseTo(60, 0);
  });

  it('is zero for the same point and symmetric', () => {
    expect(distanceNm(12, 34, 12, 34)).toBe(0);
    expect(distanceNm(12, 34, 15, 40)).toBeCloseTo(distanceNm(15, 40, 12, 34), 9);
  });
});

describe('nearestPort', () => {
  it('uses a five nautical mile radius by default', () => {
    expect(PORT_RADIUS_NM).toBe(5);
    // 4.9 nm north of Alpha is in range, 5.1 nm is not.
    expect(nearestPort([INVENTED[0]], 10 + 4.9 / 60, 20)?.name).toBe('Alpha');
    expect(nearestPort([INVENTED[0]], 10 + 5.1 / 60, 20)).toBeNull();
  });

  it('returns the port, its position and the distance', () => {
    const found = nearestPort(INVENTED, 10.01, 20);
    expect(found).toMatchObject({ name: 'Alpha', lat: 10, lon: 20 });
    expect(found.distanceNm).toBeCloseTo(0.6, 1);
  });

  it('lets the nearest win when two ports are in range', () => {
    // Alpha and Beta are 3 nm apart: the midpoint is 1.5 nm from each.
    expect(nearestPort(INVENTED, 10 + 1.4 / 60, 20)?.name).toBe('Alpha');
    expect(nearestPort(INVENTED, 10 + 1.6 / 60, 20)?.name).toBe('Beta');
    expect(nearestPort(INVENTED, 10.03, 20)?.name).toBe('Beta');
  });

  it('keeps the earlier entry on an exact tie', () => {
    expect(nearestPort([['First', 5, 5], ['Second', 5, 5]], 5, 5)?.name).toBe('First');
  });

  it('gives no name in open water, with an empty list, or for unusable input', () => {
    expect(nearestPort(INVENTED, 10, 25)).toBeNull();
    expect(nearestPort([], 10, 20)).toBeNull();
    expect(nearestPort(null, 10, 20)).toBeNull();
    expect(nearestPort(INVENTED, Number.NaN, 20)).toBeNull();
    expect(nearestPort(INVENTED, 10, undefined)).toBeNull();
    expect(nearestPort(INVENTED, 95, 20)).toBeNull();
  });

  it('accepts a wider or narrower radius', () => {
    const alpha = [INVENTED[0]];
    expect(nearestPort(alpha, 10 + 8 / 60, 20)).toBeNull();
    expect(nearestPort(alpha, 10 + 8 / 60, 20, 10)?.name).toBe('Alpha');
    expect(nearestPort(alpha, 10 + 2 / 60, 20, 1)).toBeNull();
  });

  it('names the real ports a sailor taps next to', () => {
    const tap = (lat, lon) => nearestPort(REAL, lat, lon)?.name ?? null;
    expect(tap(49.66, -1.6)).toBe('Cherbourg');
    expect(tap(50.35, -4.12)).toBe('Plymouth');
    expect(tap(41.5, -71.3)).toBe('Newport');
    expect(tap(40.69, -74.04)).toBe('New York');
    expect(tap(39.55, 2.62)).toBe('Palma');
    expect(tap(41.36, 2.18)).toBe('Barcelona');
    expect(tap(-27.4, 153.15)).toBe('Brisbane');
    expect(tap(-23.85, 151.27)).toBe('Gladstone');
    // The middle of the Channel names nothing.
    expect(tap(50, -3)).toBeNull();
  });

  it('works across the antimeridian from either side', () => {
    const suva = [['East of the line', -16.8, 179.99], ['West of the line', -16.8, -179.98]];
    // 0.02 degrees of longitude at 16.8 degrees south is about 1.1 nm.
    expect(nearestPort([suva[0]], -16.8, -179.99)?.name).toBe('East of the line');
    expect(nearestPort([suva[1]], -16.8, 179.99)?.name).toBe('West of the line');
    // Equally near from the line itself: the nearer of the two wins.
    expect(nearestPort(suva, -16.8, 180)?.name).toBe('East of the line');
    expect(nearestPort(suva, -16.8, -180)?.name).toBe('East of the line');
    // A degree away is nowhere near.
    expect(nearestPort([suva[0]], -16.8, -178.5)).toBeNull();
  });

  it('measures east-west distance true at high latitude', () => {
    // At 78.2 N a degree of longitude is about 12.4 nm: 0.3 degrees is 3.7 nm, 0.5 degrees is 6.2 nm.
    const longyearbyen = [['Longyearbyen', 78.22, 15.62]];
    expect(nearestPort(longyearbyen, 78.22, 15.92)?.name).toBe('Longyearbyen');
    expect(nearestPort(longyearbyen, 78.22, 16.12)).toBeNull();
    // The same longitude offset at the equator would be 18 nm: the lookup must not assume it.
    expect(distanceNm(78.22, 15.62, 78.22, 15.92)).toBeCloseTo(3.7, 1);
  });

  it('finds a port at the pole whatever the longitude', () => {
    const pole = [['Pole station', 89.99, 0]];
    expect(nearestPort(pole, 89.99, 180)).not.toBeNull();
    expect(nearestPort(pole, 90, 123)?.name).toBe('Pole station');
  });
});
