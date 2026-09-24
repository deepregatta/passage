import { describe, expect, it } from 'vitest';
import { parseUtc } from '../src/eta.js';
import {
  axisTimesMs,
  edgeNeighbourProbes,
  nearestGridIndex,
  resampleToHourly,
  tileIdFor,
  tileOrigin,
  tilesForBbox,
} from '../src/forecast/tileMath.js';
import type { TileHeader } from '../src/forecast/tileCodec.js';

describe('tile ids and origins', () => {
  it('names tiles by their SW corner', () => {
    expect(tileIdFor(45, -5)).toBe('N40W010');
    expect(tileIdFor(-0.1, 0.1)).toBe('S10E000');
    expect(tileIdFor(0, 0)).toBe('N00E000');
    expect(tileIdFor(-10, 170)).toBe('S10E170');
  });

  it('treats tile edges as half-open', () => {
    expect(tileOrigin(49.999, -0.001)).toEqual({ lat0: 40, lon0: -10 });
    expect(tileOrigin(50, 0)).toEqual({ lat0: 50, lon0: 0 });
  });

  it('normalizes 0-360 longitudes', () => {
    expect(tileOrigin(45, 185)).toEqual({ lat0: 40, lon0: -180 });
    expect(tileIdFor(45, 359.9)).toBe('N40W010');
  });

  it('handles the poles', () => {
    expect(tileIdFor(-90, 0)).toBe('S90E000');
    expect(tileOrigin(89.9, 10).lat0).toBe(80);
  });
});

describe('tilesForBbox', () => {
  it('returns every intersecting tile', () => {
    // Biscay-ish box spanning four tiles
    expect(tilesForBbox({ minLat: 43, maxLat: 51, minLon: -12, maxLon: -2 }).sort()).toEqual(
      ['N40W010', 'N40W020', 'N50W010', 'N50W020'].sort(),
    );
  });

  it('returns a single tile for a small box', () => {
    expect(tilesForBbox({ minLat: 44, maxLat: 45, minLon: -8, maxLon: -6 })).toEqual(['N40W010']);
  });

  it('clamps at the poles and the date line', () => {
    expect(tilesForBbox({ minLat: 85, maxLat: 90, minLon: 175, maxLon: 180 })).toEqual(['N80E170']);
    expect(tilesForBbox({ minLat: -90, maxLat: -85, minLon: -180, maxLon: -175 })).toEqual([
      'S90W180',
    ]);
  });

  it('rejects antimeridian-crossing boxes like routeBbox does', () => {
    expect(() => tilesForBbox({ minLat: 0, maxLat: 1, minLon: 170, maxLon: -170 })).toThrow(
      /antimeridian/,
    );
  });

  it('covers the globe with 648 tiles', () => {
    expect(tilesForBbox({ minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 })).toHaveLength(648);
  });
});

const header = {
  time_axes: {
    hourly: { base: '2026-07-13T06:00Z', offsets_h: [0, 1, 2] },
    h3: { base: '2026-07-13T06:00Z', offsets_h: [0, 3, 6] },
  },
  lat0: 40,
  lon0: -10,
  dlat: 0.25,
  dlon: 0.25,
  nlat: 40,
  nlon: 40,
} as unknown as TileHeader;

describe('axisTimesMs and nearestGridIndex', () => {
  it('expands offsets from the base time', () => {
    const times = axisTimesMs(header, 'h3');
    expect(times).toEqual([
      parseUtc('2026-07-13T06:00Z'),
      parseUtc('2026-07-13T09:00Z'),
      parseUtc('2026-07-13T12:00Z'),
    ]);
  });

  it('finds the nearest grid point and rejects out-of-tile points', () => {
    expect(nearestGridIndex(header, 40.25, -9.75)).toEqual({ i: 1, j: 1, flat: 41 });
    expect(nearestGridIndex(header, 40.1, -9.9)).toEqual({ i: 0, j: 0, flat: 0 });
    expect(nearestGridIndex(header, 51, -9.75)).toBeNull();
    expect(nearestGridIndex(header, 45, -11)).toBeNull();
  });
});

describe('edgeNeighbourProbes', () => {
  const grid = (lat0: number, lon0: number, d = 0.25) =>
    ({ lat0, lon0, dlat: d, dlon: d, nlat: Math.round(10 / d), nlon: Math.round(10 / d) }) as unknown as TileHeader;

  it('probes nothing when the home tile holds the nearest point', () => {
    expect(edgeNeighbourProbes(header, 45, -5, 0.25)).toEqual([]);
    expect(edgeNeighbourProbes(header, 40.1, -9.9, 0.25)).toEqual([]);
  });

  it('probes the one side the rounded index overflows', () => {
    expect(edgeNeighbourProbes(grid(30, -10), 39.9, -5, 0.25)).toEqual([{ tileId: 'N40W010', lat: 39.9, lon: -5 }]);
    expect(edgeNeighbourProbes(grid(40, -20), 44.9, -10.1, 0.25)).toEqual([{ tileId: 'N40W010', lat: 44.9, lon: -10.1 }]);
    expect(edgeNeighbourProbes(grid(30, -20), 39.9, -10.1, 0.25)).toEqual([{ tileId: 'N40W010', lat: 39.9, lon: -10.1 }]);
    // float noise below a 10° line on a 1/12° lattice
    const noisy = 37.33333333333333 + 32 / 12;
    expect(noisy).toBeLessThan(40);
    expect(edgeNeighbourProbes(grid(30, -10, 1 / 12), noisy, -5, 1 / 12).map((p) => p.tileId)).toEqual(['N40W010']);
    // offset grid (first row above the line): the tile below holds the nearest row
    expect(edgeNeighbourProbes(grid(40.2, -9.8), 40.05, -5, 0.25).map((p) => p.tileId)).toEqual(['N30W010']);
  });

  it('ignores grids that stop short of the tile edge by more than a cell', () => {
    const partial = { ...grid(40, -10), nlat: 24 } as TileHeader; // rows end at 45.75
    expect(edgeNeighbourProbes(partial, 46.5, -5, 0.25)).toEqual([]);
  });

  it('keeps probe longitudes continuous across the antimeridian', () => {
    expect(edgeNeighbourProbes(grid(40, 170), 45, 179.9, 0.25)).toEqual([{ tileId: 'N40W180', lat: 45, lon: -180.1 }]);
    expect(edgeNeighbourProbes(grid(40, -179.8), 45, -179.95, 0.25)).toEqual([{ tileId: 'N40E170', lat: 45, lon: 180.05 }]);
    // an unnormalised longitude is wrapped before probing
    expect(edgeNeighbourProbes(grid(40, 170), 45, -180.1, 0.25)).toEqual([{ tileId: 'N40W180', lat: 45, lon: -180.1 }]);
  });

  it('never probes past the poles', () => {
    expect(edgeNeighbourProbes(grid(80, 0), 89.95, 5, 0.25)).toEqual([]);
    expect(edgeNeighbourProbes(null, -89.95, 5, 0.25)).toEqual([]);
  });

  it('probes every side within a cell when the home tile is unpublished', () => {
    expect(edgeNeighbourProbes(null, 45, -15, 0.25)).toEqual([]);
    expect(edgeNeighbourProbes(null, 45, -10.2, 0.25).map((p) => p.tileId)).toEqual(['N40W010']);
    expect(edgeNeighbourProbes(null, 39.9, -10.1, 0.25).map((p) => p.tileId)).toEqual(['N40W020', 'N30W010', 'N40W010']);
    expect(edgeNeighbourProbes(null, 40.05, -9.95, 0.25).map((p) => p.tileId)).toEqual(['N30W010', 'N40W020', 'N30W020']);
  });
});

describe('resampleToHourly', () => {
  const t = (iso: string) => parseUtc(iso);
  const axis = [t('2026-07-13T06:00Z'), t('2026-07-13T09:00Z'), t('2026-07-13T12:00Z')];

  it('interpolates linearly between 3-hourly steps', () => {
    const { times, values } = resampleToHourly(
      axis,
      [0, 3, 6],
      t('2026-07-13T06:00Z'),
      t('2026-07-13T12:00Z'),
    );
    expect(times[0]).toBe('2026-07-13T06:00:00Z');
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('returns null outside the axis and propagates null steps', () => {
    const { values } = resampleToHourly(
      axis,
      [0, null, 6],
      t('2026-07-13T05:00Z'),
      t('2026-07-13T13:00Z'),
    );
    // 05: before axis; 07,08: needs null step; 09 lands exactly on the null step
    expect(values[0]).toBeNull();
    expect(values[1]).toBe(0);
    expect(values[2]).toBeNull();
    expect(values[3]).toBeNull();
    expect(values[4]).toBeNull();
    expect(values[7]).toBe(6);
    expect(values[8]).toBeNull();
  });

  it('uses the exact step value when an hour lands on a step after a null', () => {
    const { values } = resampleToHourly(
      axis,
      [null, 3, 6],
      t('2026-07-13T09:00Z'),
      t('2026-07-13T09:00Z'),
    );
    expect(values).toEqual([3]);
  });
});
