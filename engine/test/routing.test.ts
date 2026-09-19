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

/** Six walls with alternating north/south gaps; the border prevents going around them. */
function combMask(): LandMask {
  const nlat = 61;
  const nlon = 81;
  const land = Array<number>(nlat * nlon).fill(0);
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const wall = [10, 22, 34, 46, 58, 70].indexOf(j);
      if (i === 0 || i === nlat - 1 || j === 0 || j === nlon - 1 ||
        (wall >= 0 && (wall % 2 === 0 ? i < 46 : i > 14))) {
        land[i * nlon + j] = 1;
      }
    }
  }
  return {
    schema_version: 1, kind: 'land_mask',
    lat0: 49.1, lon0: -5.5, dlat: 0.02, dlon: 0.02, nlat, nlon, land,
  };
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

  it.each(['not-a-date', '', '2026-07-20T00:00:00+25:00'])('rejects invalid departure %j before searching', (departureUtc) => {
    expect(() => computeRoute({ start, finish, departureUtc, polar: POLAR, windGrid: windGrid(180, 12) }))
      .toThrow('Invalid UTC timestamp');
  });

  it.each(['2026-07-20T00:00:00', '2026-07-19T19:00:00-05:00', '2026-07-20T02:00:00+02:00'])(
    'routes the same UTC instant for %s', (departureUtc) => {
      const request = { start, finish, polar: POLAR, windGrid: windGrid(180, 12), resolutionDeg: 0.1 };
      const expected = computeRoute({ ...request, departureUtc: '2026-07-20T00:00:00Z' });
      const actual = computeRoute({ ...request, departureUtc });
      expect(actual.arrival_utc).toBe(expected.arrival_utc);
      expect(actual.duration_h).toBe(expected.duration_h);
      expect(actual.route.waypoints).toEqual(expected.route.waypoints);
    },
  );

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
    const mask = wallMask();
    const result = computeRoute({
      start: { lat: 49.3, lon: -4.0 },
      finish: { lat: 50.8, lon: -4.0 }, // due north, wall at 50.0 except gap at -2.6..-2.2
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(270, 14), // westerly beam wind for N-S sailing
      landMask: mask,
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
    for (let i = 1; i < result.route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, result.route.waypoints[i - 1]!, result.route.waypoints[i]!)).toBe(false);
    }
  });

  it.each([
    { finishLat: 49.3, gap: false },
    { finishLat: 49.4, gap: false },
    { finishLat: 49.3, gap: true },
    { finishLat: 49.4, gap: true },
  ])('checks short graph edges against a finer mask ($finishLat, gap=$gap)', ({ finishLat, gap }) => {
    // A 0.01° wall sits halfway along a 0.1° graph edge. Both its
    // cardinal and diagonal endpoints are sea; node checks alone miss it.
    const nlat = 61;
    const nlon = 81;
    const land = Array<number>(nlat * nlon).fill(0);
    for (let i = 0; i < nlat; i++) {
      if (!gap || i < 40 || i > 50) land[i * nlon + 25] = 1;
    }
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask',
      lat0: 49.1, lon0: -5.5, dlat: 0.01, dlon: 0.01, nlat, nlon, land,
    };
    const start = { lat: 49.3, lon: -5.3 };
    const finish = { lat: finishLat, lon: -5.2 };
    expect(isLand(mask, start.lat, start.lon)).toBe(false);
    expect(isLand(mask, finish.lat, finish.lon)).toBe(false);
    expect(segmentCrossesLand(mask, start, finish)).toBe(true);
    const request = {
      start, finish,
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(270, 14),
      landMask: mask,
      resolutionDeg: 0.1,
    };
    if (!gap) {
      expect(() => computeRoute(request)).toThrow('No route found');
      return;
    }
    const { route } = computeRoute(request);
    expect(route.waypoints[0]).toMatchObject(start);
    expect(route.waypoints.at(-1)).toMatchObject(finish);
    expect(route.waypoints.some(wp => wp.lat >= 49.5)).toBe(true);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, route.waypoints[i - 1]!, route.waypoints[i]!)).toBe(false);
    }
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

  it.each([
    { reverse: false, gap: false },
    { reverse: true, gap: false },
    { reverse: false, gap: true },
    { reverse: true, gap: true },
  ])('checks endpoint connections across a finer wall (reverse=$reverse, gap=$gap)', ({ reverse, gap }) => {
    const nlat = 61;
    const nlon = 81;
    const land = Array<number>(nlat * nlon).fill(0);
    for (let i = 0; i < nlat; i++) {
      if (!gap || i < 40 || i > 50) land[i * nlon + 23] = 1;
    }
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask',
      lat0: 49.1, lon0: -5.5, dlat: 0.01, dlon: 0.01, nlat, nlon, land,
    };
    const endpoints = [{ lat: 49.3, lon: -5.26 }, { lat: 49.3, lon: -5.4 }];
    const start = endpoints[reverse ? 1 : 0]!;
    const finish = endpoints[reverse ? 0 : 1]!;
    expect(isLand(mask, start.lat, start.lon)).toBe(false);
    expect(isLand(mask, finish.lat, finish.lon)).toBe(false);
    expect(segmentCrossesLand(mask, start, finish)).toBe(true);
    const request = {
      start, finish, departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR, windGrid: windGrid(180, 12), landMask: mask, resolutionDeg: 0.1,
    };
    if (!gap) {
      expect(() => computeRoute(request)).toThrow('No route found');
      return;
    }
    const { route } = computeRoute(request);
    expect(route.waypoints[0]).toMatchObject(start);
    expect(route.waypoints.at(-1)).toMatchObject(finish);
    expect(route.waypoints.some(wp => wp.lat >= 49.5)).toBe(true);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, route.waypoints[i - 1]!, route.waypoints[i]!)).toBe(false);
    }
  });

  it.each([false, true])('retains the shared connection node when the direct endpoint leg crosses land (reverse=%s)', (reverse) => {
    // Both endpoints snap to (49.3, -5.3). The two connectors avoid the
    // small island between the endpoints, so replacing that node is unsafe.
    const nlat = 61;
    const nlon = 81;
    const land = Array<number>(nlat * nlon).fill(0);
    land[22 * nlon + 22] = 1;
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask',
      lat0: 49.1, lon0: -5.5, dlat: 0.01, dlon: 0.01, nlat, nlon, land,
    };
    const endpoints = [{ lat: 49.34, lon: -5.3 }, { lat: 49.3, lon: -5.26 }];
    const start = endpoints[reverse ? 1 : 0]!;
    const finish = endpoints[reverse ? 0 : 1]!;
    expect(segmentCrossesLand(mask, start, finish)).toBe(true);
    const { route } = computeRoute({
      start, finish, departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR, windGrid: windGrid(225, 12), landMask: mask, resolutionDeg: 0.1,
    });
    expect(route.waypoints[0]).toMatchObject(start);
    expect(route.waypoints.at(-1)).toMatchObject(finish);
    expect(route.waypoints).toHaveLength(3);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, route.waypoints[i - 1]!, route.waypoints[i]!)).toBe(false);
    }
  });

  it.each([false, true])('rejects an emitted endpoint rounded onto land (reverse=%s)', (reverse) => {
    // The land-cell boundary is at -5.30004: the requested endpoint is
    // sea, but its four-decimal output (-5.3) is land.
    const nlat = 61;
    const nlon = 81;
    const land = Array<number>(nlat * nlon).fill(0);
    for (let i = 0; i < nlat; i++) land[i * nlon + 20] = 1;
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask',
      lat0: 49.1, lon0: -5.49504, dlat: 0.01, dlon: 0.01, nlat, nlon, land,
    };
    const endpoints = [{ lat: 49.3, lon: -5.300049 }, { lat: 49.3, lon: -5.4 }];
    const start = endpoints[reverse ? 1 : 0]!;
    const finish = endpoints[reverse ? 0 : 1]!;
    expect(isLand(mask, start.lat, start.lon)).toBe(false);
    expect(isLand(mask, finish.lat, finish.lon)).toBe(false);
    expect(isLand(mask, 49.3, -5.3)).toBe(true);
    expect(() => computeRoute({
      start, finish, departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR, windGrid: windGrid(180, 12), landMask: mask, resolutionDeg: 0.1,
    })).toThrow(/land/);
  });

  it.each([false, true])('rejects an endpoint enclosed away from every routing node (reverse=%s)', (reverse) => {
    const nlat = 61;
    const nlon = 81;
    const land = Array<number>(nlat * nlon).fill(0);
    for (let i = 23; i <= 25; i++) {
      for (let j = 23; j <= 25; j++) {
        if (i !== 24 || j !== 24) land[i * nlon + j] = 1;
      }
    }
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask',
      lat0: 49.1, lon0: -5.5, dlat: 0.01, dlon: 0.01, nlat, nlon, land,
    };
    const endpoints = [{ lat: 49.34, lon: -5.26 }, { lat: 49.3, lon: -5.4 }];
    const start = endpoints[reverse ? 1 : 0]!;
    const finish = endpoints[reverse ? 0 : 1]!;
    expect(isLand(mask, start.lat, start.lon)).toBe(false);
    expect(isLand(mask, finish.lat, finish.lon)).toBe(false);
    expect(() => computeRoute({
      start, finish, departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR, windGrid: windGrid(180, 12), landMask: mask, resolutionDeg: 0.1,
    })).toThrow('No sea node near start/finish');
  });

  it.each([0, 45, 90, 135, 180, 225, 270, 315])('keeps every emitted leg in the sea through six alternating wall gaps (wind %s)', (direction) => {
    const mask = combMask();
    const start = { lat: 49.7, lon: -5.4, name: 'Maze entrance' };
    const finish = { lat: 49.7, lon: -4.0, name: 'Maze exit' };
    const { route } = computeRoute({
      start, finish,
      departureUtc: '2026-07-20T00:00:00Z',
      polar: POLAR,
      windGrid: windGrid(direction, 14, 97),
      landMask: mask,
      resolutionDeg: 0.02,
      maxHours: 96,
    });
    expect(route.waypoints[0]).toMatchObject(start);
    expect(route.waypoints.at(-1)).toMatchObject(finish);
    expect(route.waypoints.length).toBeGreaterThan(2);
    const crossings = route.waypoints.slice(1).flatMap((to, i) =>
      segmentCrossesLand(mask, route.waypoints[i]!, to) ? [i] : [],
    );
    expect(crossings).toEqual([]);
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
