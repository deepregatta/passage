import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRoute, CurrentGapError, SearchBoundsError, type RoutingRequest } from '../src/routing/isochrone.js';
import type { Polar } from '../src/routing/polar.js';
import type { LandMask } from '../src/routing/landmask.js';
import type { RegionGrid } from '../src/grids.js';

// Invented table (the same shape as routing.test.ts): no real boat.
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

const T0 = Date.parse('2026-07-20T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Uniform wind over lat 49.0-51.2, lon -6.0-0.0 (hourly, from T0). */
function windGrid(windFromDeg: number, speedKt: number, hours = 49): RegionGrid {
  const rad = (windFromDeg * Math.PI) / 180;
  const nlat = 5;
  const nlon = 9;
  const size = hours * nlat * nlon;
  return {
    schema_version: 1, kind: 'wind10m', run_id: 'test-wind', generated_at: iso(T0),
    lat0: 49.0, lon0: -6.0, dlat: 0.55, dlon: 0.75, nlat, nlon,
    time_axis: Array.from({ length: hours }, (_, h) => iso(T0 + h * 3600_000)),
    u_kt: Array(size).fill(Math.round(-speedKt * Math.sin(rad) * 100) / 100),
    v_kt: Array(size).fill(Math.round(-speedKt * Math.cos(rad) * 100) / 100),
    source: { mode: 'synthetic' },
  };
}

/**
 * 0.01° mask over the wind grid's area: a land block at 49.33-49.60N, 2.0-1.3W
 * whose only water is a one-cell notch at 1.6W, from 49.33N up to `notchTop`,
 * open to the south. With `eastChannel`, a channel also runs from the notch at
 * `channelFrom` N to open water at 49.3N 1.2W.
 */
function notchMask(eastChannel = false, { notchTop = 49.36, channelFrom = 49.345 } = {}): LandMask {
  const lat0 = 49.0;
  const lon0 = -6.0;
  const d = 0.01;
  const nlat = 221;
  const nlon = 601;
  const land = Array<number>(nlat * nlon).fill(0);
  for (let i = 33; i <= 60; i++) for (let j = 400; j <= 470; j++) land[i * nlon + j] = 1;
  for (let i = 33; i <= Math.round((notchTop - lat0) / d); i++) land[i * nlon + 440] = 0;
  if (eastChannel) {
    for (let k = 0; k <= 400; k++) {
      const ci = Math.round((channelFrom - ((channelFrom - 49.3) * k) / 400 - lat0) / d);
      const cj = Math.round((-1.6 + (0.4 * k) / 400 - lon0) / d);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) land[(ci + a) * nlon + cj + b] = 0;
    }
  }
  return { schema_version: 1, kind: 'land_mask', lat0, lon0, dlat: d, dlon: d, nlat, nlon, land };
}

/** Hourly current from T0 at `d`° spacing over lat 49.0-51.2 and lon -6.0 to `lon1`: (u, v) = value(lat, lon), null for none. */
function currentGrid(value: (lat: number, lon: number) => [number, number] | null,
  { hours = 49, d = 0.1, lon1 = 0.0 } = {}): RegionGrid {
  const nlat = Math.round(2.2 / d) + 1;
  const nlon = Math.round((lon1 + 6.0) / d) + 1;
  const u: Array<number | null> = [];
  const v: Array<number | null> = [];
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const uv = value(49.0 + i * d, -6.0 + j * d);
        u.push(uv ? uv[0] : null);
        v.push(uv ? uv[1] : null);
      }
    }
  }
  return {
    schema_version: 1, kind: 'surface_current', run_id: 'test-current', generated_at: iso(T0),
    lat0: 49.0, lon0: -6.0, dlat: d, dlon: d, nlat, nlon,
    time_axis: Array.from({ length: hours }, (_, h) => iso(T0 + h * 3600_000)),
    u_kt: u as number[], v_kt: v as number[],
    source: { mode: 'synthetic' },
  };
}

/** Zero current over lat 49.0-51.2 and lon -6.0 to -1.55 only. */
const westCurrentGrid = () => currentGrid(() => [0, 0], { d: 0.05, lon1: -1.55 });

/** The latest hour of the wind grid the router read (every read goes through u_kt). */
function watchWindHours(grid: RegionGrid) {
  let latestIndex = -1;
  const u = grid.u_kt;
  grid.u_kt = new Proxy(u, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) latestIndex = Math.max(latestIndex, Number(key));
      return Reflect.get(target, key, receiver);
    },
  });
  return () => Math.floor(latestIndex / (grid.nlat * grid.nlon));
}

const start = { lat: 49.3, lon: -3.5, name: 'A' };
const departureUtc = iso(T0);
const inside = (box: { minLat: number; maxLat: number; minLon: number; maxLon: number }) =>
  (wp: { lat: number; lon: number }) => wp.lat >= box.minLat && wp.lat <= box.maxLat && wp.lon >= box.minLon && wp.lon <= box.maxLon;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finish connection', () => {
  // At 0.1° the graph's lon0 is -6.0, so the node nearest the finish (49.3, -1.64)
  // is (49.3, -1.6): just past the finish for a boat coming from the west.
  const finish = { lat: 49.3, lon: -1.64, name: 'B' };

  it('reaches the finish from another sea node when the nearest node\'s last leg is in the no-go cone', () => {
    // A westerly: the last leg from (49.3, -1.6) heads due west, dead into the wind.
    const { route, duration_h: hours } = computeRoute({
      start, finish, departureUtc, polar: POLAR, windGrid: windGrid(270, 12), resolutionDeg: 0.1,
    });
    expect(route.waypoints[0]).toMatchObject({ lat: 49.3, lon: -3.5, name: 'A' });
    expect(route.waypoints.at(-1)).toMatchObject({ lat: 49.3, lon: -1.64, name: 'B' });
    // Never the node whose leg is dead upwind: the route never goes past the finish.
    expect(route.waypoints.every(wp => wp.lon <= -1.64)).toBe(true);
    // ~72.8 nm downwind at 5.5-6 kt. The node it joins from was settled long before the
    // nearest node failed, and its leg starts at its own settle time: the boat arrives
    // before it would have reached the nearest node (74.3 nm at 5.5 kt, ~13.5 h).
    expect(hours).toBeGreaterThan(12.5);
    expect(hours).toBeLessThan(13.4);
    const timing = route.timing!;
    if (timing.basis !== 'routed') throw new Error('expected routed timing');
    const total = timing.legs.reduce((sum, leg) => sum + leg.duration_ms.nominal, 0);
    expect(total / 3600_000).toBeCloseTo(hours, 1);
  });

  it('with searchBounds, joins the finish only from a node inside the box, even one settled before the nearest node failed', () => {
    const request = { start, finish, departureUtc, polar: POLAR, windGrid: windGrid(270, 12), resolutionDeg: 0.1 };
    // Unconfined, the fastest join is from a node north of row 49.3 ...
    const box = { minLat: 49.25, maxLat: 49.35, minLon: -3.6, maxLon: -1.0 };
    expect(computeRoute(request).route.waypoints.every(inside(box))).toBe(false);
    // ... which a box holding only row 49.3 leaves out: the route joins from a node on that row.
    const { route } = computeRoute({ ...request, searchBounds: box });
    expect(route.waypoints.every(inside(box))).toBe(true);
    expect(route.waypoints.at(-1)).toMatchObject({ lat: 49.3, lon: -1.64, name: 'B' });
    expect(route.provenance?.routing_request).toHaveProperty('search_bounds');
  });

  it('keeps the nearest node whenever its last leg can be sailed, byte for byte, though a node settled earlier would arrive sooner', () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    // A southerly: the leg back from (49.3, -1.6) is a beam reach. Captured from the router
    // before alternative finish nodes existed (commit 22126e0).
    const result = computeRoute({ start, finish, departureUtc, polar: POLAR, windGrid: windGrid(180, 12), resolutionDeg: 0.1 });
    expect(result).toEqual({
      route: {
        schema_version: 1, route_id: 'computed-2026072000-test-32ft', name: 'A → B (computed)', mode: 'computed',
        waypoints: [
          { id: 'wp1', name: 'A', lat: 49.3, lon: -3.5 },
          { id: 'wp2', lat: 49.3, lon: -1.6 },
          { id: 'wp3', name: 'B', lat: 49.3, lon: -1.64 },
        ],
        speeds_kt: { slow: 5.5, nominal: 6.5, fast: 7.5 },
        timing: {
          basis: 'routed', departure_utc: '2026-07-20T00:00:00.000Z',
          legs: [
            { leg_id: 'L1', duration_ms: { slow: 48468999.67256434, nominal: 41198649.72167969, fast: 35824912.8014606 },
              through_water_kt: 6.5002527111442445, speed_over_ground_kt: 6.500081990703419 },
            { leg_id: 'L2', duration_ms: { slow: 1020423.8582835478, nominal: 867360.2795410156, fast: 754226.3300356658 },
              through_water_kt: 6.500101084717991, speed_over_ground_kt: 6.500101084718012 },
          ],
        },
        provenance: {
          engine_version: 'grid-dijkstra-v1',
          routing_request: { departure: '2026-07-20T00:00:00Z', polar_id: 'test-32ft', polar_scaling: 1, wind_run: 'test-wind',
            current_run: null, resolution_deg: 0.1 },
          polar_ref: 'test-32ft', computed_at: '2026-07-20T00:00:00Z',
        },
      },
      arrival_utc: '2026-07-20T11:41:06Z', duration_h: 11.7, distance_nm: 76, avg_sog_kt: 6.5, steps_used: 462,
    });
  });

  describe('a finish inside a notch open to the south, in a northerly', () => {
    // The node nearest the finish is (49.3, -1.6), at the notch's mouth: its last leg
    // heads due north into the wind, as does every leg that fits through the notch.
    const notchFinish = { lat: 49.345, lon: -1.6, name: 'B' };
    const request = (mask: LandMask, extra: Partial<RoutingRequest> = {}): RoutingRequest => ({
      start, finish: notchFinish, departureUtc, polar: POLAR, windGrid: windGrid(0, 12), landMask: mask, resolutionDeg: 0.1, ...extra,
    });

    it('still throws the plain error when no node near the finish can sail to it, and stops once they are all settled', () => {
      const grid = windGrid(0, 12);
      const latestHour = watchWindHours(grid);
      expect(() => computeRoute(request(notchMask(), { windGrid: grid }))).toThrow(
        'No route found within 48 h (wind coverage, land, or no-go conditions)',
      );
      // The nearest node is reached after ~11.7 h and the last other finish node after ~12.2 h;
      // the search does not run on toward its 48 h horizon.
      expect(latestHour()).toBeGreaterThanOrEqual(11);
      expect(latestHour()).toBeLessThanOrEqual(13);
    });

    it('reaches it through a channel, from a node the notch does not admit', () => {
      const { route } = computeRoute(request(notchMask(true)));
      expect(route.waypoints.at(-1)).toMatchObject({ lat: 49.345, lon: -1.6, name: 'B' });
      expect(route.waypoints.at(-2)!.lon).toBeGreaterThan(-1.6);
    });

    it('with searchBounds, never joins the finish from a node outside the box: a failure the box caused stays a SearchBoundsError', () => {
      // The box stops at 1.55W: the channel's nodes are outside it, the notch's inside.
      const box = { minLat: 49.0, maxLat: 49.5, minLon: -3.6, maxLon: -1.55 };
      let error: unknown;
      try {
        computeRoute(request(notchMask(true), { searchBounds: box }));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SearchBoundsError);
      expect((error as SearchBoundsError).reason).toBe('no-route');
      // A box that holds the channel's nearest node gives the route through it, inside the box.
      const wider = { ...box, maxLon: -1.35 };
      const { route } = computeRoute(request(notchMask(true), { searchBounds: wider }));
      expect(route.waypoints.every(inside(wider))).toBe(true);
      expect(route.provenance?.routing_request).toHaveProperty('search_bounds');
      expect(route.waypoints.slice(-2)).toEqual(computeRoute(request(notchMask(true))).route.waypoints.slice(-2));
    });

    it('reads the current at an alternative node like at any node: strict stops at a gap there, otherwise a gap is no current', () => {
      // The current grid ends at 1.55W, so the channel's nodes have no current value.
      const west = westCurrentGrid();
      expect(() => computeRoute(request(notchMask(true), { currentGrid: west, strictCurrent: true })))
        .toThrow(CurrentGapError);
      try {
        computeRoute(request(notchMask(true), { currentGrid: west, strictCurrent: true }));
      } catch (e) {
        expect((e as CurrentGapError).beyondTimeAxis).toBe(false);
      }
      const lenient = computeRoute(request(notchMask(true), { currentGrid: west }));
      const none = computeRoute(request(notchMask(true)));
      expect(lenient.route.waypoints).toEqual(none.route.waypoints);
      expect(lenient.arrival_utc).toBe(none.arrival_utc);
      expect(lenient.route.provenance?.routing_request).toMatchObject({ current_run: 'test-current' });
    });
  });
});

describe('finish connection: bounds and stepping', () => {
  const finish = { lat: 49.3, lon: -1.64, name: 'B' };
  const westerly = { start, finish, departureUtc, polar: POLAR, windGrid: windGrid(270, 12), resolutionDeg: 0.1 };
  const notchFinish = { lat: 49.345, lon: -1.6, name: 'B' };

  it('stops a failing search within its window after the nearest finish node failed, though a finish node never settles', () => {
    // The notch reaches 49.41N: the node (49.4, -1.6) inside it joins the finish over water,
    // but the search can only reach it dead upwind. The nearest node fails at ~11.7 h.
    const grid = windGrid(0, 12);
    const latestHour = watchWindHours(grid);
    // A strict current whose axis ends at 20 h, a few hours after the window closes (~17.7 h).
    const request = {
      start, finish: notchFinish, departureUtc, polar: POLAR, windGrid: grid, resolutionDeg: 0.1,
      landMask: notchMask(false, { notchTop: 49.41 }), currentGrid: currentGrid(() => [0, 0], { hours: 21 }), strictCurrent: true,
    };
    expect(() => computeRoute(request)).toThrow('No route found within 48 h (wind coverage, land, or no-go conditions)');
    expect(latestHour()).toBeGreaterThanOrEqual(11);
    expect(latestHour()).toBeLessThanOrEqual(18);
  });

  it('integrates a long last leg from another node in steps no longer than the longest graph edge', () => {
    // A 3 kt foul (westgoing) current east of 2.2W, none west of 2.3W. From (49.4, -2.3), in
    // still water, a single sample at the node would carry the whole 26 nm leg at full speed.
    const foul = currentGrid((_lat, lon) => [lon >= -2.2 ? -3 : 0, 0]);
    const calm = computeRoute(westerly);
    const { route, duration_h: hours } = computeRoute({ ...westerly, currentGrid: foul });
    expect(hours).toBeGreaterThan(calm.duration_h + 0.5);
    const timing = route.timing!;
    if (timing.basis !== 'routed') throw new Error('expected routed timing');
    const last = timing.legs.at(-1)!;
    // The last leg feels the foul current along it: its speed over ground is well under its speed through the water.
    expect(last.speed_over_ground_kt).toBeLessThan(last.through_water_kt - 1);
  });

  it('under strict current, a dry cell halfway along a long last leg from another node is a gap', () => {
    // Zero current at 0.03° with one dry square of four values (49.36-49.39N, 2.10-2.07W), between
    // the graph's rows: no graph node reads it, only points along the legs from nodes such as
    // (49.4, -2.3) to the finish.
    const dry = (lat: number, lon: number): [number, number] | null =>
      lat > 49.35 && lat < 49.40 && lon > -2.11 && lon < -2.06 ? null : [0, 0];
    const grid = currentGrid(dry, { d: 0.03, hours: 16 });
    let error: unknown;
    try {
      computeRoute({ ...westerly, currentGrid: grid, strictCurrent: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CurrentGapError);
    expect((error as CurrentGapError).beyondTimeAxis).toBe(false);
    // Lenient, a gap is no current: the same route as in still water.
    const lenient = computeRoute({ ...westerly, currentGrid: grid });
    expect(lenient.route.waypoints).toEqual(computeRoute(westerly).route.waypoints);
  });

  it('reaches the finish from another settled node when the deadline comes before the nearest node settles', () => {
    // The nearest node (49.3, -1.6) is reached only after ~13.5 h; the rescue arrives at ~13.1 h.
    const { duration_h: hours, route } = computeRoute({ ...westerly, maxHours: 13.4 });
    expect(hours).toBe(13.1);
    expect(route.waypoints.at(-1)).toMatchObject({ lat: 49.3, lon: -1.64, name: 'B' });
    expect(route.waypoints).toEqual(computeRoute(westerly).route.waypoints);
  });

  it('reaches the finish from another node when the nearest node cannot be reached at all', () => {
    // Finish at 49.37N in a notch reaching 49.41N: its nearest node (49.4, -1.6) lies inside the
    // notch, reachable only dead upwind in a northerly. A channel runs east to open water.
    const { route } = computeRoute({
      start, finish: { lat: 49.37, lon: -1.6, name: 'B' }, departureUtc, polar: POLAR, windGrid: windGrid(0, 12), resolutionDeg: 0.1,
      landMask: notchMask(true, { notchTop: 49.41, channelFrom: 49.37 }),
    });
    expect(route.waypoints.at(-1)).toMatchObject({ lat: 49.37, lon: -1.6, name: 'B' });
    expect(route.waypoints.at(-2)!.lon).toBeGreaterThan(-1.6);
  });

  it('does not count a node outside searchBounds with no wind there as the box holding the route back', () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    // Wind only up to 49.3N: the graph's top row (49.4N, padding around the finish) has none.
    const low = windGrid(270, 12);
    const short: RegionGrid = { ...low, dlat: 0.1, nlat: 4, u_kt: low.u_kt.slice(0, 49 * 4 * 9), v_kt: low.v_kt.slice(0, 49 * 4 * 9) };
    const request = { ...westerly, windGrid: short };
    const unconfined = computeRoute(request);
    const confined = computeRoute({ ...request, searchBounds: { minLat: 49.0, maxLat: 49.3, minLon: -6.0, maxLon: 0.0 } });
    expect(confined).toEqual(unconfined);
    expect(confined.route.provenance?.routing_request).not.toHaveProperty('search_bounds');
  });
});
