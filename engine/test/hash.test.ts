import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { cachedContentHash, canonicalJson, contentHash, fnv1a64Hex, fnv1a64HexParts } from '../src/hash.js';

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

/**
 * The definition the limb implementation replaced (engine/src/hash.ts until
 * 2026-11-13), kept here as the reference: FNV-1a 64 on BigInt over UTF-16 code
 * units of strings and bytes of byte arrays.
 */
function referenceFnv1a64(parts: ReadonlyArray<string | Uint8Array>): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const input of parts) {
    for (let i = 0; i < input.length; i++) {
      h ^= BigInt(typeof input === 'string' ? input.charCodeAt(i) : input[i]!);
      h = (h * prime) & mask;
    }
  }
  return h.toString(16).padStart(16, '0');
}

/** A seeded generator (mulberry32): the same corpus on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One UTF-16 code unit sequence from a mix of classes, lone surrogates included. */
function randomString(next: () => number, length: number): string {
  const units: number[] = [];
  while (units.length < length) {
    const kind = Math.floor(next() * 6);
    if (kind === 0) units.push(Math.floor(next() * 0x80)); // ASCII, controls and NUL included
    else if (kind === 1) units.push(0x80 + Math.floor(next() * 0x780)); // Latin-1 to two-byte UTF-8
    else if (kind === 2) units.push(0x800 + Math.floor(next() * (0xd800 - 0x800))); // BMP below the surrogates
    else if (kind === 3) units.push(0xe000 + Math.floor(next() * 0x2000)); // BMP above them, 0xffff included
    else if (kind === 4) { // a valid surrogate pair (astral character)
      const cp = 0x10000 + Math.floor(next() * 0x100000);
      units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
    } else units.push(0xd800 + Math.floor(next() * 0x800)); // a lone high or low surrogate
  }
  let text = '';
  for (let i = 0; i < length; i += 8192) text += String.fromCharCode(...units.slice(i, Math.min(i + 8192, length)));
  return text;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('FNV-1a limb implementation equals the BigInt definition', () => {
  const same = (parts: ReadonlyArray<string | Uint8Array>) => expect(fnv1a64HexParts(parts)).toBe(referenceFnv1a64(parts));

  it('on the empty input, every one-unit string and every byte value', () => {
    same([]);
    same(['']);
    same([new Uint8Array(0)]);
    for (let unit = 0; unit <= 0xffff; unit++) same([String.fromCharCode(unit)]);
    for (let byte = 0; byte <= 0xff; byte++) same([Uint8Array.of(byte)]);
    expect(fnv1a64Hex('\u{1f30a}')).toBe(referenceFnv1a64(['🌊'])); // a surrogate pair is two units
  });

  it('on every committed fixture and golden: raw bytes, text and the canonical JSON contentHash reads', () => {
    const paths = [...files(join(HERE, 'fixtures')), ...files(join(HERE, 'golden')), ...files(join(HERE, '../../contracts'))];
    let json = 0;
    for (const path of paths) {
      const raw = new Uint8Array(readFileSync(path));
      same([raw]);
      const bytes = path.endsWith('.gz') ? new Uint8Array(gunzipSync(raw)) : raw;
      if (bytes !== raw) same([bytes]);
      const text = new TextDecoder().decode(bytes);
      same([text]);
      if (path.endsWith('.json')) {
        const canonical = canonicalJson(JSON.parse(text));
        same([canonical]);
        json += 1;
      }
    }
    // the legacy snapshot and both PFT1 codec goldens are in the corpus
    expect(paths.some(p => p.includes('legacy-current-snapshot/decision-inputs.json'))).toBe(true);
    expect(paths.filter(p => /golden-N40W010-\w+\.bin\.gz$/.test(p))).toHaveLength(2);
    expect(json).toBeGreaterThan(40);
  });

  it('on long strings and long byte arrays', () => {
    const next = random(20261113);
    same([randomString(next, 1_000_003)]);
    same(['a'.repeat(2_000_000)]);
    same(['￿'.repeat(500_000)]);
    const bytes = new Uint8Array(1_000_001);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    same([bytes]);
  });

  it('on 3,000 seeded random strings, byte arrays and mixed part lists', () => {
    const next = random(42);
    for (let k = 0; k < 1000; k++) same([randomString(next, Math.floor(next() * 400))]);
    for (let k = 0; k < 1000; k++) {
      const bytes = new Uint8Array(Math.floor(next() * 400));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
      same([bytes]);
    }
    for (let k = 0; k < 1000; k++) {
      const parts = Array.from({ length: Math.floor(next() * 5) }, () => (next() < 0.5
        ? randomString(next, Math.floor(next() * 50))
        : Uint8Array.from({ length: Math.floor(next() * 50) }, () => Math.floor(next() * 256))));
      same(parts);
      expect(fnv1a64HexParts(parts.filter(p => typeof p === 'string'))).toBe(fnv1a64Hex(parts.filter(p => typeof p === 'string').join('')));
    }
  });
});

describe('cachedContentHash', () => {
  const freeze = <T,>(value: T): T => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const grid = () => ({ kind: 'surface_current', run_id: 'r', time_axis: ['2026-07-20T00:00:00Z'], u_kt: [1, null, 2], v_kt: [0, null, 1], source: { mode: 'live' } });

  it('returns contentHash for any value, frozen or not', () => {
    for (const value of [null, 1, 'x', [1, 2], grid(), freeze(grid())]) expect(cachedContentHash(value)).toBe(contentHash(value));
  });

  it('never serves an old digest for a value that could still change', () => {
    const open = grid();
    const before = cachedContentHash(open);
    open.u_kt[0] = 9;
    expect(cachedContentHash(open)).not.toBe(before);
    expect(cachedContentHash(open)).toBe(contentHash(open));
    // shallowly frozen, or frozen everywhere but one nested object: still hashed afresh
    const partly = Object.freeze({ ...grid(), u_kt: Object.freeze([1, null, 2]), v_kt: Object.freeze([0, null, 1]), time_axis: Object.freeze(['t']),
      source: Object.freeze({ mode: 'live' }), extra: { note: 'a' } });
    const first = cachedContentHash(partly);
    partly.extra.note = 'b';
    expect(cachedContentHash(partly)).not.toBe(first);
    expect(cachedContentHash(partly)).toBe(contentHash(partly));
    // a getter can answer differently later, even on a frozen object
    let flip = 0;
    const getter = Object.freeze(Object.defineProperty({ ...grid() }, 'run_id', { get: () => `r${flip}`, enumerable: true }));
    const g0 = cachedContentHash(getter);
    flip = 1;
    expect(cachedContentHash(getter)).not.toBe(g0);
  });

  it('hashes a deep-frozen value once per object, and a copy of it again', () => {
    // canonicalJson reads an object's entries once per hash: count those reads of each grid
    const entries = vi.spyOn(Object, 'entries');
    const hashesOf = (value: object) => entries.mock.calls.filter(([arg]) => arg === value).length;
    const frozen = freeze(grid());
    const digest = cachedContentHash(frozen);
    expect(cachedContentHash(frozen)).toBe(digest);
    expect(cachedContentHash(frozen)).toBe(digest);
    expect(hashesOf(frozen)).toBe(1);
    expect(() => { (frozen.u_kt as number[])[0] = 9; }).toThrow(TypeError);
    const copy = freeze(structuredClone(grid()));
    expect(cachedContentHash(copy)).toBe(digest);
    expect(hashesOf(copy)).toBe(1);
    const open = grid();
    cachedContentHash(open);
    cachedContentHash(open);
    expect(hashesOf(open)).toBe(2);
    entries.mockRestore();
  });
});
