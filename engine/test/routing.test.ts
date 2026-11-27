import { describe, expect, it } from 'vitest';
import { ClosedWaterError, computeRoute, SearchBoundsError, type RoutingRequest } from '../src/routing/isochrone.js';
import { boatSpeedKt, type Polar } from '../src/routing/polar.js';
import { isLand, seaJoinsPoints, segmentCrossesLand, type LandMask } from '../src/routing/landmask.js';
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects polar scaling %s before searching', (polarScaling) => {
      expect(() => computeRoute({
        start, finish, departureUtc: '2026-07-20T00:00:00Z', polar: POLAR, windGrid: windGrid(180, 12), polarScaling,
      })).toThrow('Polar scaling must be finite and positive');
    },
  );

  it('records the polar scaling in the route provenance, 1 when none is given, and routes slower at a lower one', () => {
    const request = {
      start, finish, departureUtc: '2026-07-20T00:00:00Z', polar: POLAR, windGrid: windGrid(180, 12), resolutionDeg: 0.1,
    };
    const plain = computeRoute(request);
    const slower = computeRoute({ ...request, polarScaling: 0.8 });
    expect(plain.route.provenance?.routing_request).toMatchObject({ polar_scaling: 1 });
    expect(slower.route.provenance?.routing_request).toMatchObject({ polar_scaling: 0.8 });
    expect(slower.duration_h).toBeGreaterThan(plain.duration_h);
  });

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

  it('the router does not pass a land wall through a pinch corner, even with graph nodes on cell corners', () => {
    // 0.05° cells from (49.1, -5.5), land border. The wall is column 10 up to row 10 and
    // column 11 from row 11: cells (10, 10) and (11, 11) meet only at the corner
    // (49.625, -4.975), which isLand puts in the sea cell (10, 11). A 0.025° graph has a
    // node on every cell corner, that one included.
    const nlat = 21;
    const nlon = 21;
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        if (i === 0 || i === nlat - 1 || j === 0 || j === nlon - 1 || (j === 10 && i <= 10) || (j === 11 && i >= 11)) cells.push([i, j]);
      }
    }
    const land = Array<number>(nlat * nlon).fill(0);
    for (const [i, j] of cells) land[i * nlon + j] = 1;
    const mask: LandMask = { schema_version: 1, kind: 'land_mask', lat0: 49.1, lon0: -5.5, dlat: 0.05, dlon: 0.05, nlat, nlon, land };
    expect(isLand(mask, 49.625, -4.975)).toBe(false);
    const request = {
      start: { lat: 49.4, lon: -5.3 }, finish: { lat: 49.4, lon: -4.7 },
      departureUtc: '2026-07-20T00:00:00Z', polar: POLAR, windGrid: windGrid(270, 14),
      landMask: mask, resolutionDeg: 0.025,
    };
    expect(() => computeRoute(request)).toThrow('No route found');
    // Opened by one sea cell (10, 10), the same wall lets the route through that gap.
    mask.land[10 * nlon + 10] = 0;
    const { route } = computeRoute(request);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, route.waypoints[i - 1]!, route.waypoints[i]!)).toBe(false);
    }
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

const CLOSED_WATER_MESSAGE =
  'No route found: on the coarse outline of the coast, no open water joins the start and the finish. ' +
  'A strait or channel between them is too narrow to be in it. Use Draw my route instead.';

/** The same uniform wind over a wider box (lat 48.5..52, lon -7..-2.5), for ends near or outside the mask window. */
const wideWindGrid = (): RegionGrid => {
  const base = windGrid(270, 12);
  const nlat = 8;
  const nlon = 10;
  const size = base.time_axis.length * nlat * nlon;
  return { ...base, lat0: 48.5, lon0: -7.0, dlat: 0.5, dlon: 0.5, nlat, nlon,
    u_kt: Array(size).fill(base.u_kt[0]!), v_kt: Array(size).fill(base.v_kt[0]!) };
};

// Closed water (coarse outline): mask window lat 49.0..51.2, lon -6.0..0.0 in 0.1 degree cells; row i is lat 49.0 + 0.1 i, column j is lon -6.0 + 0.1 j.
const NLAT = 23;
const NLON = 61;
const maskWith = (rows: Record<number, (j: number) => boolean>): LandMask => {
  const land = Array<number>(NLAT * NLON).fill(0);
  for (const [row, isLandAt] of Object.entries(rows)) {
    for (let j = 0; j < NLON; j++) if (isLandAt(j)) land[Number(row) * NLON + j] = 1;
  }
  return { schema_version: 1, kind: 'land_mask', lat0: 49.0, lon0: -6.0, dlat: 0.1, dlon: 0.1, nlat: NLAT, nlon: NLON, land };
};
const all = () => true;
/** maskWith inside a frame of land: the window's water is a basin, so a wall across it proves closed water. */
const basinWith = (rows: Record<number, (j: number) => boolean>): LandMask => {
  const mask = maskWith({ ...rows, 0: all, [NLAT - 1]: all });
  for (let i = 0; i < NLAT; i++) {
    mask.land[i * NLON] = 1;
    mask.land[i * NLON + NLON - 1] = 1;
  }
  return mask;
};

const south = { lat: 49.5, lon: -4.5 };
const north = { lat: 50.5, lon: -4.5 };
const request = (landMask: LandMask, extra: Partial<RoutingRequest> = {}): RoutingRequest => ({
  start: south, finish: north, departureUtc: '2026-07-20T00:00:00Z', polar: POLAR,
  windGrid: windGrid(270, 12), landMask, resolutionDeg: 0.1, ...extra,
});
const failure = (r: RoutingRequest): Error & { code?: string } => {
  try { computeRoute(r); } catch (error) { return error as Error; }
  throw new Error('expected computeRoute to throw');
};

describe('closed water on the coarse coastline outline', () => {
  it('says so when a land wall across an enclosed basin separates start from finish', () => {
    const error = failure(request(basinWith({ 10: all })));
    expect(error.message).toBe(CLOSED_WATER_MESSAGE);
    expect(error.code).toBe('closed-water');
    expect(error).toBeInstanceOf(ClosedWaterError);
    expect(error.name).toBe('ClosedWaterError');
  });

  it('keeps SearchBoundsError when searchBounds held the search back: its callers retry without the box', () => {
    // The finish node (50.5) lies above the box (to 50.49), so the box clips the search.
    const box = { minLat: 49.0, maxLat: 50.49, minLon: -6.0, maxLon: -3.0 };
    const error = failure(request(basinWith({ 10: all }), { finish: { lat: 50.49, lon: -4.5 }, searchBounds: box }));
    expect(error).toBeInstanceOf(SearchBoundsError);
    expect(error.code).toBe('search-bounds');
    // The same passage without the box reports the closed water.
    expect(failure(request(basinWith({ 10: all }), { finish: { lat: 50.49, lon: -4.5 } }))).toBeInstanceOf(ClosedWaterError);
  });

  it('says so when the only gap in a two-row wall is a corner pinch (diagonal sea cells share a corner only)', () => {
    // Sea at (row 10, column 30) and (row 11, column 31): the other two cells of that 2 x 2 block are land.
    const mask = basinWith({ 10: (j) => j !== 30, 11: (j) => j !== 31 });
    const error = failure(request(mask, { start: { lat: 49.5, lon: -3.0 }, finish: { lat: 50.5, lon: -3.0 } }));
    expect(error.message).toBe(CLOSED_WATER_MESSAGE);
  });

  it('does not call a wall closed when it has a one-cell gap joined edge to edge', () => {
    const mask = maskWith({ 10: (j) => j !== 30 });
    const open = { start: { lat: 49.5, lon: -3.0 }, finish: { lat: 50.5, lon: -3.0 } };
    // The gap really is passable: a route exists, every leg clear of land.
    const { route } = computeRoute(request(mask, open));
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentCrossesLand(mask, route.waypoints[i - 1]!, route.waypoints[i]!)).toBe(false);
    }
    // And when the same passage fails for another reason, the generic message stays.
    const tooShort = failure(request(mask, { ...open, maxHours: 0.1 }));
    expect(tooShort.message).toBe('No route found within 0.1 h (wind coverage, land, or no-go conditions)');
    expect(tooShort.code).toBeUndefined();
  });

  it('keeps the generic message when water joins the ends but the horizon is too short', () => {
    const error = failure(request(maskWith({}), { maxHours: 0.1 }));
    expect(error.message).toBe('No route found within 0.1 h (wind coverage, land, or no-go conditions)');
  });

  it('keeps the generic message when water joins the ends but the wind has no coverage at the departure', () => {
    const error = failure(request(maskWith({ 10: (j) => j !== 30 }), { departureUtc: '2026-07-25T00:00:00Z' }));
    expect(error.message).toBe('No route found within 48 h (wind coverage, land, or no-go conditions)');
  });

  describe('the window edge', () => {
    // A wall across the whole window, the start 0.03 degrees inside the west edge: the graph then
    // reaches 0.1 degrees beyond the window, where the mask has no cells. It used to count them as
    // sea and sail round the wall; past the window's last cell nothing is known, so it never goes there.
    const edgeMask = () => maskWith({ 10: all });
    const edge = {
      start: { lat: 49.5, lon: -5.97 }, finish: { lat: 50.5, lon: -5.97 },
      windGrid: wideWindGrid(),
    };

    it('does not sail round the wall beyond the window, nor call the water closed: a way round may lie outside', () => {
      const error = failure(request(edgeMask(), edge));
      expect(error).not.toBeInstanceOf(ClosedWaterError);
      expect(error.message).toBe('No route found within 48 h (wind coverage, land, or no-go conditions)');
    });

    it('says closed water when the wall meets land at both edges of the window: one end’s water is a basin', () => {
      const error = failure(request(basinWith({ 10: all }), { ...edge, start: { lat: 49.5, lon: -5.85 }, finish: { lat: 50.5, lon: -5.85 } }));
      expect(error).toBeInstanceOf(ClosedWaterError);
    });

    it('with a gap in the wall, the route stays inside the window', () => {
      const { route } = computeRoute(request(maskWith({ 10: (j) => j !== 5 }), edge));
      expect(route.waypoints.every((wp) => wp.lon >= -6.05 && wp.lon <= 0.05 && wp.lat >= 48.95 && wp.lat <= 51.25)).toBe(true);
    });

    it('refuses an end outside the window: the mask cannot say whether it is sea', () => {
      expect(() => computeRoute(request(edgeMask(), { ...edge, start: { lat: 49.5, lon: -6.3 }, finish: { lat: 50.5, lon: -6.3 } })))
        .toThrow('Start or finish lies outside the land mask');
    });
  });

  it('never calls closed a passage the router can sail (random masks, ends inside the window), and names every closed one', () => {
    // Closed means apart even with all water beyond the window counted as sea; apart only inside the
    // window keeps the generic message (the planner searches a larger window first).
    const small = (seed: number): LandMask => {
      let state = seed;
      const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const land = Array.from({ length: 21 * 21 }, () => (next() < 0.4 ? 1 : 0));
      return { schema_version: 1, kind: 'land_mask', lat0: 49.0, lon0: -6.0, dlat: 0.1, dlon: 0.1, nlat: 21, nlon: 21, land };
    };
    let sailed = 0;
    let closed = 0;
    let beyond = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const mask = small(seed);
      const sea = [] as Array<[number, number]>;
      for (let i = 3; i <= 17; i++) for (let j = 3; j <= 17; j++) if (mask.land[i * 21 + j] === 0) sea.push([i, j]);
      if (sea.length < 2) continue;
      const [a, b] = [sea[seed % sea.length]!, sea[(seed * 7 + 3) % sea.length]!];
      const start = { lat: 49.0 + 0.1 * a[0], lon: -6.0 + 0.1 * a[1] };
      const finish = { lat: 49.0 + 0.1 * b[0], lon: -6.0 + 0.1 * b[1] };
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const joined = seaJoinsPoints(mask, start, finish, false);
      let failed: Error | null = null;
      try {
        computeRoute({ start, finish, departureUtc: '2026-07-20T00:00:00Z', polar: POLAR, windGrid: wideWindGrid(), landMask: mask, resolutionDeg: 0.1 });
      } catch (error) {
        failed = error as Error;
      }
      if (!failed) {
        sailed++;
        expect(joined, `seed ${seed}: a route exists`).toBe(true);
      } else if (!joined && !seaJoinsPoints(mask, start, finish, true)) {
        closed++;
        expect(failed.message, `seed ${seed}`).toBe(CLOSED_WATER_MESSAGE);
      } else if (!joined) {
        beyond++;
        expect(failed, `seed ${seed}`).not.toBeInstanceOf(ClosedWaterError);
      }
    }
    expect(sailed).toBeGreaterThan(5);
    expect(closed).toBeGreaterThan(5);
    expect(beyond).toBeGreaterThan(0);
  });
});
