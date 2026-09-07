import { describe, expect, it } from 'vitest';
import { computeRoute } from '../src/routing/isochrone.js';
import { boatSpeedKt, type Polar } from '../src/routing/polar.js';
import { isLand, segmentCrossesLand, type LandMask } from '../src/routing/landmask.js';
import type { RegionGrid } from '../src/grids.js';

const POLAR: Polar = {
  schema_version: 1,
  polar_id: 'test-32ft',
  label: 'Test 32ft',
  tws_kt: [6, 12, 20],
  twa_deg: [45, 90, 135, 180],
  speeds_kt: [
    [3.2, 4.5, 4.2, 3.5],
    [5.0, 6.5, 6.8, 5.5],
    [5.8, 7.2, 7.8, 6.9],
  ],
  source: { kind: 'generic' },
};

/** uniform wind over a big box */
function windGrid(windFromDeg: number, speedKt: number, hours = 49): RegionGrid {
  const rad = (windFromDeg * Math.PI) / 180;
  const u = -speedKt * Math.sin(rad); // FROM dir -> vector points opposite
  const v = -speedKt * Math.cos(rad);
  const nlat = 5;
  const nlon = 9;
  const times = Array.from({ length: hours }, (_, h) =>
    new Date(Date.parse('2026-07-20T00:00:00Z') + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  );
  const size = times.length * nlat * nlon;
  return {
    schema_version: 1,
    kind: 'wind10m',
    run_id: 'test-wind',
    generated_at: times[0]!,
    lat0: 49.0,
    lon0: -6.0,
    dlat: 0.55,
    dlon: 0.75,
    nlat,
    nlon,
    time_axis: times,
    u_kt: Array(size).fill(Math.round(u * 100) / 100),
    v_kt: Array(size).fill(Math.round(v * 100) / 100),
    source: { mode: 'synthetic' },
  };
}

/** land row across lat≈50.0 with a gap at lon -2.6..-2.2 */
function wallMask(): LandMask {
  const nlat = 23;
  const nlon = 61;
  const lat0 = 49.0;
  const lon0 = -6.0;
  const dlat = 0.1;
  const dlon = 0.1;
  const land = Array(nlat * nlon).fill(0);
  const wallRow = Math.round((50.0 - lat0) / dlat);
  for (let j = 0; j < nlon; j++) {
    const lon = lon0 + j * dlon;
    if (lon < -2.6 || lon > -2.2) land[wallRow * nlon + j] = 1;
  }
  return { schema_version: 1, kind: 'land_mask', lat0, lon0, dlat, dlon, nlat, nlon, land };
}

describe('polar interpolation', () => {
  it('bilinear inside the table, clamped at edges, no-go below 33°', () => {
    expect(boatSpeedKt(POLAR, 12, 90)).toBe(6.5);
    expect(boatSpeedKt(POLAR, 9, 90)).toBeCloseTo(5.5, 5); // halfway 4.5..6.5
    expect(boatSpeedKt(POLAR, 30, 90)).toBe(7.2); // above table -> clamp
    expect(boatSpeedKt(POLAR, 12, 20)).toBe(0); // in the no-go cone
    expect(boatSpeedKt(POLAR, 12, -90)).toBe(6.5); // symmetric
  });
});

describe('land mask', () => {
  const mask = wallMask();
  it('point and segment tests', () => {
    expect(isLand(mask, 50.0, -4.0)).toBe(true);
    expect(isLand(mask, 50.0, -2.4)).toBe(false); // the gap
    expect(isLand(mask, 49.5, -4.0)).toBe(false);
    expect(segmentCrossesLand(mask, { lat: 49.5, lon: -4.0 }, { lat: 50.5, lon: -4.0 })).toBe(true);
    expect(segmentCrossesLand(mask, { lat: 49.5, lon: -2.4 }, { lat: 50.5, lon: -2.4 })).toBe(false);
  });
});

describe('isochrone router', () => {
  const start = { lat: 49.3, lon: -3.5, name: 'A' };
  const finish = { lat: 49.3, lon: -1.6, name: 'B' }; // ~74 nm due east

  it('open water, fair reaching breeze: near-direct route, plausible arrival', () => {
    const result = computeRoute({
      start,
      finish,
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(180, 12), // southerly 12 kt -> beam reach heading east
    });
    // beam reach at 12 kt TWS -> ~6.5 kt; 74 nm -> ~11.4 h (some zigzag tolerance)
    expect(result.duration_h).toBeGreaterThan(9);
    expect(result.duration_h).toBeLessThan(14);
    expect(result.distance_nm).toBeGreaterThan(70);
    expect(result.distance_nm).toBeLessThan(90);
    expect(result.route.mode).toBe('computed');
    expect(result.route.provenance?.routing_request).toMatchObject({ polar_id: 'test-32ft' });
    expect(result.route.speeds_kt!.slow).toBeLessThan(result.route.speeds_kt!.fast);
  });

  it('a land wall forces the route through the gap', () => {
    const result = computeRoute({
      start: { lat: 49.3, lon: -4.0 },
      finish: { lat: 50.8, lon: -4.0 }, // due north, wall at 50.0 except gap at -2.6..-2.2
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(270, 14), // westerly beam wind for N-S sailing
      landMask: wallMask(),
      maxHours: 40,
    });
    // some waypoint must pass through the gap longitude band while crossing 50.0
    const crossing = result.route.waypoints.find((wp, i) => {
      const next = result.route.waypoints[i + 1];
      return next && wp.lat <= 50.0 && next.lat >= 50.0;
    });
    expect(crossing).toBeDefined();
    expect(crossing!.lon).toBeGreaterThan(-2.75);
    expect(crossing!.lon).toBeLessThan(-2.05);
  });

  it('faster polar scaling arrives earlier (monotonicity)', () => {
    const base = {
      start,
      finish,
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(180, 12),
    };
    const slow = computeRoute({ ...base, polarScaling: 0.8 });
    const fast = computeRoute({ ...base, polarScaling: 1.2 });
    expect(fast.duration_h).toBeLessThan(slow.duration_h);
  });

  it('no wind coverage -> clear error, not a bogus route', () => {
    expect(() =>
      computeRoute({
        start: { lat: 30, lon: 10 },
        finish: { lat: 31, lon: 11 },
        departureUtc: '2026-07-20T00:00:00Z',
        polar: POLAR,
        windGrid: windGrid(180, 12),
      }),
    ).toThrow(/stalled|coverage/);
  });
});
