import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fnv1a64Hex } from '../src/hash.js';

describe('FNV-1a byte hashing', () => {
  it.each([
    ['', 'cbf29ce484222325'],
    ['a', 'af63dc4c8601ec8c'],
    ['foobar', '85944171f73967e8'],
  ])('matches the published vector for %j without changing string hashes', (value, expected) => {
    expect(fnv1a64Hex(value)).toBe(expected);
    expect(fnv1a64Hex(new TextEncoder().encode(value))).toBe(expected);
  });

  it('matches the Python-generated binary golden using only the supplied byte view', () => {
    const raw = gunzipSync(readFileSync(new URL('./fixtures/tiles/golden-N40W010-weather.bin.gz', import.meta.url)));
    const padded = new Uint8Array(raw.length + 2);
    padded.set(raw, 1);
    expect(fnv1a64Hex(padded.subarray(1, -1))).toBe('f81cd54ab70d458e');
  });
});
