import { describe, expect, it } from 'vitest';
import { snapToSea, windowLandMask } from '../src/routing/landmaskPack.js';
import type { LandMask } from '../src/routing/landmask.js';

function pack(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 1 << (i & 7); });
  return bytes;
}

describe('packed land mask', () => {
  it('windows row-major LSB bits and clamps to the source extent', () => {
    const bits = [
      0, 1, 0, 1,
      1, 0, 1, 0,
      0, 0, 1, 1,
    ];
    const mask = windowLandMask(
      pack(bits),
      { lat0: 0, lon0: 10, dlat: 1, dlon: 1, nlat: 3, nlon: 4, bit_order: 'lsb' },
      { minLat: 0.7, maxLat: 9, minLon: 10.7, maxLon: 12.1 },
    );
    expect(mask).toMatchObject({ lat0: 0, lon0: 10, nlat: 3, nlon: 4 });
    expect(mask.land).toEqual(bits);
  });

  it('rejects antimeridian boxes', () => {
    expect(() => windowLandMask(
      new Uint8Array(1),
      { lat0: 0, lon0: 0, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
      { minLat: 0, maxLat: 1, minLon: 170, maxLon: -170 },
    )).toThrow(/Antimeridian/);
  });

  it('snaps a harbour point to the nearest sea cell and returns null when boxed in', () => {
    const mask: LandMask = {
      schema_version: 1, kind: 'land_mask', lat0: 0, lon0: 0,
      dlat: 0.05, dlon: 0.05, nlat: 5, nlon: 5,
      land: Array(25).fill(1),
    };
    mask.land[2 * 5 + 4] = 0;
    expect(snapToSea(mask, { lat: 0.1, lon: 0.1 }, 3)).toEqual({ lat: 0.1, lon: 0.2 });
    expect(snapToSea({ ...mask, land: Array(25).fill(1) }, { lat: 0.1, lon: 0.1 }, 3)).toBeNull();
  });
});
