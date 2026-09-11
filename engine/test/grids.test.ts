import { describe, expect, it } from 'vitest';
import { GridSampler, alongCourseKt, currentSetDeg, currentSpeedKt } from '../src/grids.js';
import { computeSchedules, parseUtc } from '../src/eta.js';
import type { RegionGrid } from '../src/grids.js';
import type { Leg } from '../src/types.js';

/** 3x3 grid, 2 time steps: uniform 2 kt east-going at t0, 2 kt west-going at t1; one land cell */
function makeGrid(): RegionGrid {
  const nlat = 3;
  const nlon = 3;
  const times = ['2026-07-20T00:00:00Z', '2026-07-20T06:00:00Z'];
  const u: Array<number | null> = [];
  const v: Array<number | null> = [];
  for (let t = 0; t < times.length; t++) {
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const land = i === 2 && j === 2;
        u.push(land ? null : t === 0 ? 2 : -2);
        v.push(land ? null : 0);
      }
    }
  }
  return {
    schema_version: 1,
    kind: 'surface_current',
    run_id: 'test-grid',
    generated_at: '2026-07-19T12:00:00Z',
    lat0: 49.0,
    lon0: -3.0,
    dlat: 0.5,
    dlon: 0.5,
    nlat,
    nlon,
    time_axis: times,
    u_kt: u,
    v_kt: v,
    source: { mode: 'synthetic' },
  };
}

describe('GridSampler', () => {
  const sampler = new GridSampler(makeGrid());

  it('bilinear in space, linear in time (midpoint of reversal -> 0)', () => {
    const mid = sampler.sample(49.5, -2.5, parseUtc('2026-07-20T03:00:00Z'));
    expect(mid).toEqual({ u_kt: 0, v_kt: 0 });
    const early = sampler.sample(49.5, -2.5, parseUtc('2026-07-20T00:00:00Z'));
    expect(early).toEqual({ u_kt: 2, v_kt: 0 });
  });

  it('null outside temporal or spatial coverage', () => {
    expect(sampler.sample(49.5, -2.5, parseUtc('2026-07-21T00:00:00Z'))).toBeNull();
    expect(sampler.sample(60, 10, parseUtc('2026-07-20T01:00:00Z'))).toBeNull();
  });

  it('coastal fallback: near the land corner, nearest wet corner wins (no null)', () => {
    const nearLand = sampler.sample(49.9, -2.1, parseUtc('2026-07-20T00:00:00Z'));
    expect(nearLand).not.toBeNull();
    expect(nearLand!.u_kt).toBe(2);
  });

  it('interpolates a spatial gradient across irregular time steps, including exact endpoints', () => {
    const grid = makeGrid();
    const start = parseUtc(grid.time_axis[0]!);
    const hours = [0, 2, 7, 19];
    grid.time_axis = hours.map(h => new Date(start + h * 3600_000).toISOString());
    grid.nlat = grid.nlon = 2;
    grid.u_kt = hours.flatMap(h => [2 * h, 2 * h + 8, 2 * h + 4, 2 * h + 12]);
    grid.v_kt = hours.flatMap(h => [-h, -h - 4, -h + 2, -h - 2]);
    const sampler = new GridSampler(grid);
    for (const h of [0, 1, 2, 4.5, 7, 13, 19]) {
      expect(sampler.sample(49.125, -2.625, start + h * 3600_000))
        .toEqual({ u_kt: 7 + 2 * h, v_kt: -2.5 - h });
    }
    for (const time of [start - 1, start + 19 * 3600_000 + 1, NaN, Infinity, -Infinity]) {
      expect(sampler.sample(49.125, -2.625, time)).toBeNull();
    }
    expect(new GridSampler({ ...grid, time_axis: [] }).sample(49, -3, start)).toBeNull();
  });

  it.each([
    [0, null], [1, 10], [2, 20], [3, 10], [4, 30], [5, 10], [6, 20], [7, 10],
    [8, 40], [9, 10], [10, 20], [11, 10], [12, 30], [13, 10], [14, 20], [15, 25],
  ] as const)('preserves coastal corner order on equal weights (wet mask %s)', (mask, expected) => {
    const grid = makeGrid();
    grid.nlat = grid.nlon = 2;
    grid.time_axis = grid.time_axis.slice(0, 1);
    // Mask order is SW, NW, SE, NE; flat storage is latitude-major.
    grid.u_kt = [0, 2, 1, 3].map(corner => (mask & (1 << corner)) ? (corner + 1) * 10 : null);
    grid.v_kt = [1, 1, 1, 1];
    expect(new GridSampler(grid).sample(49.25, -2.75, parseUtc(grid.time_axis[0]!)))
      .toEqual(expected === null ? null : { u_kt: expected, v_kt: 1 });
  });

  it('chooses the highest-weight wet corner independently for u and v', () => {
    const grid = makeGrid();
    grid.nlat = grid.nlon = 2;
    grid.time_axis = grid.time_axis.slice(0, 1);
    grid.u_kt = [10, 30, 20, null];
    grid.v_kt = [null, null, -20, -40];
    expect(new GridSampler(grid).sample(49.125, -2.625, parseUtc(grid.time_axis[0]!)))
      .toEqual({ u_kt: 30, v_kt: -40 });
  });

  it('retains null propagation from both bracketing slices even at exact timestamps', () => {
    const grid = makeGrid();
    const start = parseUtc(grid.time_axis[0]!);
    grid.nlat = grid.nlon = 2;
    grid.u_kt = [null, null, null, null, 2, 2, 2, 2];
    grid.v_kt = Array(8).fill(0);
    const sampler = new GridSampler(grid);
    for (const h of [0, 3, 6]) expect(sampler.sample(49.25, -2.75, start + h * 3600_000)).toBeNull();
  });

  it('vector helpers: 2 kt east-going has set 090, fair on an easterly course', () => {
    const sample = { u_kt: 2, v_kt: 0 };
    expect(currentSetDeg(sample)).toBe(90);
    expect(currentSpeedKt(sample)).toBe(2);
    expect(alongCourseKt(sample, 90)).toBe(2); // heading east, carried east: fair
    expect(alongCourseKt(sample, 270)).toBe(-2); // heading west against it: foul
  });
});

describe('current-corrected schedules', () => {
  const legs: Leg[] = [
    {
      leg_id: 'L1',
      from: { id: 'a', lat: 49.4, lon: -2.8 },
      to: { id: 'b', lat: 49.4, lon: -2.2 }, // due east, inside the grid
      distance_nm: 20,
      bearing_deg_true: 90,
      dist_end_nm: 20,
    },
  ];
  const speeds = { slow: 4, nominal: 5, fast: 6 };

  it('fair current shortens the leg, foul current lengthens it', () => {
    const sampler = () => ({ u_kt: 2, v_kt: 0 }); // constant 2 kt east-going
    const fair = computeSchedules(legs, speeds, '2026-07-20T00:00:00Z', sampler);
    // heading east with 2 kt fair: SOG nominal = 7 -> 20/7 h ≈ 2h51 vs 4h uncorrected
    expect(fair[0]!.sog_kt.nominal).toBeCloseTo(7, 5);
    expect(parseUtc(fair[0]!.exit.nominal) - parseUtc(fair[0]!.enter.nominal)).toBeCloseTo(
      (20 / 7) * 3600_000,
      -4,
    );

    const foul = computeSchedules(legs, speeds, '2026-07-20T00:00:00Z', () => ({ u_kt: -2, v_kt: 0 }));
    expect(foul[0]!.sog_kt.nominal).toBeCloseTo(3, 5);
  });

  it('without a sampler, SOG equals still-water speed (regression guard)', () => {
    const schedules = computeSchedules(legs, speeds, '2026-07-20T00:00:00Z');
    expect(schedules[0]!.sog_kt).toEqual(speeds);
  });

  it('SOG never collapses below the floor in a hopeless foul current', () => {
    const schedules = computeSchedules(legs, speeds, '2026-07-20T00:00:00Z', () => ({ u_kt: -9, v_kt: 0 }));
    expect(schedules[0]!.sog_kt.slow).toBe(0.5);
  });
});

it('samples a single time slice only at its timestamp, retaining spatial interpolation and null coverage', () => {
  const grid = makeGrid();
  grid.time_axis = grid.time_axis.slice(0, 1);
  grid.u_kt = [0, 2, null, 2, 4, null, null, null, null];
  grid.v_kt = [2, 4, null, 4, 6, null, null, null, null];
  const sampler = new GridSampler(grid);
  const time = parseUtc(grid.time_axis[0]!);
  expect(sampler.sample(49.25, -2.75, time)).toEqual({ u_kt: 2, v_kt: 4 });
  expect(sampler.sample(49, -3, time)).toEqual({ u_kt: 0, v_kt: 2 });
  expect(sampler.sample(49.25, -2.75, time - 1)).toBeNull();
  expect(sampler.sample(49.25, -2.75, time + 1)).toBeNull();
  expect(sampler.sample(50, -2, time)).toBeNull();
  expect(sampler.sample(60, 10, time)).toBeNull();
});
