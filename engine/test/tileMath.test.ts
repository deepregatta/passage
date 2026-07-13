import { describe, expect, it } from 'vitest';
import { parseUtc } from '../src/eta.js';
import {
  axisTimesMs,
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
