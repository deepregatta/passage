import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeTile, encodeTile } from '../src/forecast/tileCodec.js';
import type { TileHeader } from '../src/forecast/tileCodec.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiles');

function fnv64(data: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of data) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function loadGolden(name: string) {
  const raw = new Uint8Array(gunzipSync(readFileSync(join(FIXTURES, `${name}.bin.gz`))));
  const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')) as {
    fnv64: string;
    header: TileHeader;
    arrays: Record<string, unknown[]>;
  };
  return { raw, expected };
}

/** flatten the expected JSON's nested arrays into (number|null)[] */
function flatten(nested: unknown): Array<number | null> {
  const out: Array<number | null> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else out.push(node as number | null);
  };
  walk(nested);
  return out;
}

describe('golden fixtures (cross-language contract with the pipeline codec)', () => {
  for (const name of ['golden-N40W010-weather', 'golden-N40W010-ensemble']) {
    it(`decodes ${name} to the expected values`, () => {
      const { raw, expected } = loadGolden(name);
      expect(fnv64(raw)).toBe(expected.fnv64);

      const tile = decodeTile(raw);
      expect(tile.header).toEqual(expected.header);
      for (const [varName, nested] of Object.entries(expected.arrays)) {
        const got = tile.arrays[varName]!;
        const want = flatten(nested);
        expect(got.length).toBe(want.length);
        for (let k = 0; k < want.length; k++) {
          if (want[k] === null) {
            expect(Number.isNaN(got[k]), `${varName}[${k}] should be missing`).toBe(true);
          } else {
            expect(Math.abs(got[k]! - want[k]!), `${varName}[${k}]`).toBeLessThanOrEqual(1e-3);
          }
        }
      }
    });
  }
});

describe('encode/decode round trip', () => {
  const header = {
    spec: 'PFT1' as const,
    schema_version: 1,
    layer: 'weather',
    model: 'gfs_0p25',
    run_id: 'weather-20260713T06Z',
    cycle: '2026-07-13T06:00Z',
    generated_at: '2026-07-13T10:00:00Z',
    tile_id: 'N40W010',
    lat0: 40,
    lon0: -10,
    dlat: 0.25,
    dlon: 0.25,
    nlat: 3,
    nlon: 3,
    time_axes: { hourly: { base: '2026-07-13T06:00Z', offsets_h: [0, 1] } },
    member_count: 1,
  };

  it('round-trips values within quantization error and preserves NaN', () => {
    const values = new Float32Array(2 * 3 * 3).map((_, k) => -20 + k * 2.37);
    values[4] = NaN;
    const buf = encodeTile(
      { ...header, variables: [{ name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01 }] },
      { wind_u_kt: values },
    );
    const tile = decodeTile(buf);
    const got = tile.arrays.wind_u_kt!;
    for (let k = 0; k < values.length; k++) {
      if (Number.isNaN(values[k])) expect(Number.isNaN(got[k])).toBe(true);
      else expect(Math.abs(got[k]! - values[k]!)).toBeLessThanOrEqual(0.005 + 1e-6);
    }
  });

  it('keeps int16 arrays aligned after an odd-length int8 array', () => {
    const anom = new Float32Array(1 * 3 * 3).fill(1.4);
    const mean = new Float32Array(1 * 3 * 3).fill(12.34);
    const buf = encodeTile(
      {
        ...header,
        time_axes: { hourly: { base: '2026-07-13T06:00Z', offsets_h: [0] } },
        variables: [
          { name: 'anom', axis: 'hourly', dtype: 'i8', scale: 0.2 },
          { name: 'mean', axis: 'hourly', dtype: 'i16', scale: 0.01 },
        ],
      },
      { anom, mean },
    );
    const tile = decodeTile(buf);
    const meanVar = tile.header.variables.find((v) => v.name === 'mean')!;
    expect(meanVar.byte_offset % 4).toBe(0);
    expect(tile.arrays.mean![0]).toBeCloseTo(12.34, 2);
  });

  it('decodes tiles that sit at an odd offset inside a larger buffer', () => {
    const values = new Float32Array(2 * 3 * 3).fill(7.25);
    const buf = encodeTile(
      { ...header, variables: [{ name: 'v', axis: 'hourly', dtype: 'i16', scale: 0.01 }] },
      { v: values },
    );
    const shifted = new Uint8Array(buf.length + 1);
    shifted.set(buf, 1);
    const tile = decodeTile(shifted.subarray(1));
    expect(tile.arrays.v![0]).toBeCloseTo(7.25, 2);
  });

  it('rejects buffers without the magic', () => {
    expect(() => decodeTile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PFT1/);
  });
});
