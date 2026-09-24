import { describe, expect, it } from 'vitest';
import { encodeGrib2Message, gribRound, latticeCornersMicro, type Grib2Field, type GribLattice } from '../src/export/grib2.js';
import { gribLattice, tilesAlignedToLattice } from '../src/export/exportPlan.js';
import { readGrib2 } from './helpers/grib2Reader.js';

const lattice3x2: GribLattice = gribLattice({ minLat: 49, maxLat: 49.25, minLon: -5, maxLon: -4.5 }, 0.25);

function field(overrides: Partial<Grib2Field> = {}): Grib2Field {
  return {
    discipline: 0,
    centre: 7,
    generatingProcess: 96,
    cycle: '2026-09-23T06:00Z',
    forecastHours: 27,
    category: 2,
    number: 2,
    level: { type: 103, value: 10 },
    decimalScale: 1,
    lattice: lattice3x2,
    values: [1.04, 2.26, -3.5, 0, 12.34, 7],
    ...overrides,
  };
}

function only(bytes: Uint8Array | null) {
  expect(bytes).not.toBeNull();
  const messages = readGrib2(bytes!);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

describe('encodeGrib2Message', () => {
  it('writes the eight sections at their specified lengths and the total length', () => {
    const bytes = encodeGrib2Message(field())!;
    const message = only(bytes);
    expect(message.sections.map((s) => [s.number, s.length])).toEqual([
      [1, 21], [3, 72], [4, 34], [5, 21], [6, 6], [7, 5 + Math.ceil((6 * message.packing.nbits) / 8)],
    ]);
    expect(message.length).toBe(bytes.byteLength);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('GRIB');
    expect([bytes[4], bytes[5], bytes[6], bytes[7]]).toEqual([0, 0, 0, 2]);
    expect(String.fromCharCode(...bytes.subarray(-4))).toBe('7777');
  });

  it('identifies the product like NCEP: cycle as reference time, forecast hours, level and grid', () => {
    const message = only(encodeGrib2Message(field()));
    expect(message).toMatchObject({
      discipline: 0,
      centre: 7,
      subCentre: 0,
      refTime: '2026-09-23T06:00:00Z',
      grid: {
        points: 6, shape: 6, ni: 3, nj: 2, la1: 49_250_000, lo1: 355_000_000, la2: 49_000_000,
        lo2: 355_500_000, di: 250_000, dj: 250_000, flags: 0x30, scanningMode: 0,
      },
      product: {
        category: 2, number: 2, generatingProcess: 96, unit: 1, forecastTime: 27,
        levelType: 103, levelScale: 0, levelValue: 10,
      },
      packing: { count: 6, binaryScale: 0, decimalScale: 1 },
      bitmapIndicator: 255,
    });
  });

  it('rounds to D decimals with an exact integer reference and the minimum bit width', () => {
    const message = only(encodeGrib2Message(field()));
    // ints: 10, 23, -35, 0, 123, 70 → R = -35, range 158 → 8 bits
    expect(message.packing.reference).toBe(-35);
    expect(message.packing.nbits).toBe(8);
    expect([...message.values]).toEqual([1, 2.3, -3.5, 0, 12.3, 7]);
    expect([...message.values]).toEqual([1.04, 2.26, -3.5, 0, 12.34, 7].map((v) => gribRound(v, 1)));
  });

  it('writes negative latitudes, longitudes and D in sign-magnitude, not two\'s complement', () => {
    const south = gribLattice({ minLat: -35.5, maxLat: -35, minLon: -6, maxLon: -5.75 }, 0.25);
    const bytes = encodeGrib2Message(field({
      lattice: south, lonConvention: 'signed', decimalScale: -1, values: [120, 340, 1000, 20, 0, 60],
    }))!;
    const message = only(bytes);
    expect(message.grid).toMatchObject({ la1: -35_000_000, la2: -35_500_000, lo1: -6_000_000, lo2: -5_750_000 });
    const s3 = message.offset + message.sections.find((s) => s.number === 3)!.offset;
    expect(bytes[s3 + 46]).toBe(0x80 | (35_000_000 >>> 24)); // La1: sign bit + magnitude
    const s5 = message.offset + message.sections.find((s) => s.number === 5)!.offset;
    expect([bytes[s5 + 17], bytes[s5 + 18]]).toEqual([0x80, 0x01]); // D = −1
    expect(message.packing.decimalScale).toBe(-1);
    expect([...message.values]).toEqual([120, 340, 1000, 20, 0, 60]);
  });

  it('wraps longitudes to 0–360 by default, so a box across Greenwich has Lo2 < Lo1', () => {
    const greenwich = gribLattice({ minLat: 49, maxLat: 51, minLon: -6, maxLon: 2 }, 0.25);
    expect(latticeCornersMicro(greenwich)).toEqual({ la1: 51e6, lo1: 354e6, la2: 49e6, lo2: 2e6 });
    expect(latticeCornersMicro(greenwich, 'signed')).toEqual({ la1: 51e6, lo1: -6e6, la2: 49e6, lo2: 2e6 });
    const east = gribLattice({ minLat: 49, maxLat: 51, minLon: 0, maxLon: 2 }, 0.25);
    expect(latticeCornersMicro(east)).toMatchObject({ lo1: 0, lo2: 2e6 });
  });

  it('uses the integer micro-degree step on 1/12° and 1/36° grids so corners stay self-consistent', () => {
    const glo12 = gribLattice({ minLat: 48, maxLat: 51, minLon: -6, maxLon: 2 }, 0.08333587646484375);
    expect(glo12).toMatchObject({ n: 120, stepMicro: 83333, kS: 576, kN: 612, kW: -72, kE: 24, ni: 97, nj: 37 });
    const corners = latticeCornersMicro(glo12);
    expect(corners.la1 - corners.la2).toBe((glo12.nj - 1) * glo12.stepMicro);
    expect(Math.abs(corners.la1 - 51e6)).toBeLessThan(250); // ≤ 0.00025° from the exact corner
    const ibi = gribLattice({ minLat: 48, maxLat: 51, minLon: -6, maxLon: 2 }, 0.02777863000000025);
    expect(ibi).toMatchObject({ n: 360, stepMicro: 27778 });
    // GLO12 manifests from 2026-09-24 carry exactly 1/12: same lattice, now aligned.
    expect(gribLattice({ minLat: 48, maxLat: 51, minLon: -6, maxLon: 2 }, 1 / 12)).toEqual(glo12);
    expect(tilesAlignedToLattice(1 / 12, 120)).toBe(true);
    expect(tilesAlignedToLattice(0.08333587646484375, 120)).toBe(false);
    expect(tilesAlignedToLattice(0.02777863, 360)).toBe(false);
  });

  it('packs values MSB first and sets bitmap bits MSB first with 1 = present', () => {
    const lattice = gribLattice({ minLat: 0, maxLat: 0, minLon: 0, maxLon: 2.25 }, 0.25); // 1 row × 10
    const values = [NaN, 1, 2, NaN, NaN, 3, 4, 5, 6, NaN];
    const bytes = encodeGrib2Message(field({ lattice, decimalScale: 0, values }))!;
    const message = only(bytes);
    const s6 = message.offset + message.sections.find((s) => s.number === 6)!.offset;
    expect(message.sections.find((s) => s.number === 6)!.length).toBe(6 + 2);
    expect(bytes[s6 + 5]).toBe(0); // bitmap follows
    expect([bytes[s6 + 6], bytes[s6 + 7]]).toEqual([0b01100111, 0b10000000]);
    expect(message.packing).toMatchObject({ count: 6, reference: 1, nbits: 3 });
    const s7 = message.offset + message.sections.find((s) => s.number === 7)!.offset;
    // X = 0,1,2,3,4,5 in 3 bits: 000 001 010 011 100 101 → 00000101 00111001 01000000
    expect([...bytes.subarray(s7 + 5, s7 + 8)]).toEqual([0b00000101, 0b00111001, 0b01000000]);
    expect([...message.values]).toEqual(values);
  });

  it('writes a constant field with zero bits, D = 0 and the rounded value as reference', () => {
    const message = only(encodeGrib2Message(field({ decimalScale: 2, values: [4.504, 4.5, 4.496, NaN, 4.5, 4.501] })));
    expect(message.packing).toMatchObject({ nbits: 0, decimalScale: 0, reference: 4.5, count: 5 });
    expect(message.sections.find((s) => s.number === 7)!.length).toBe(5);
    expect([...message.values]).toEqual([4.5, 4.5, 4.5, NaN, 4.5, 4.5]);
    // An inexact decimal still decodes within float32 precision of the rounded value.
    const tenth = only(encodeGrib2Message(field({ values: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] })));
    expect(tenth.values[0]).toBeCloseTo(0.1, 6);
  });

  it('returns null for an all-missing field', () => {
    expect(encodeGrib2Message(field({ values: new Array(6).fill(NaN) }))).toBeNull();
  });

  it('rejects inconsistent grids, out-of-range keys and unpackable values', () => {
    expect(() => encodeGrib2Message(field({ values: [1, 2, 3] }))).toThrow('3×2 grid');
    expect(() => encodeGrib2Message(field({ lattice: { ...lattice3x2, ni: 4 } }))).toThrow('inconsistent');
    expect(() => encodeGrib2Message(field({ forecastHours: -3 }))).toThrow('forecastHours');
    expect(() => encodeGrib2Message(field({ category: 256 }))).toThrow('category');
    expect(() => encodeGrib2Message(field({ values: [0, 1, 2, 3, 4, Infinity] }))).toThrow('non-finite');
    expect(() => encodeGrib2Message(field({ decimalScale: 6, values: [0, 1, 2, 3, 4, 20] }))).toThrow('range');
  });
});
