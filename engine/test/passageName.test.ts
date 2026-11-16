import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASSAGE_NAME_MAX_LENGTH, cleanPassageName } from '../src/index.js';

// One cleaning rule for passage names (engine/src/passageName.ts): typed, saved in a
// route, or read from a check file.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cleanPassageName', () => {
  it.each([
    ['white space runs and ends', '  Cherbourg \t\n →\u00A0\u3000 Plymouth  ', 'Cherbourg → Plymouth'],
    ['C0 controls', 'Brest\u0000\u0007\u001B Yeu', 'Brest Yeu'],
    ['DEL and C1 controls', 'Brest\u007F\u0085\u009F Yeu', 'Brest Yeu'],
    ['the Arabic letter mark', 'a\u061Cb', 'ab'],
    ['left-to-right and right-to-left marks', 'a\u200Eb\u200Fc', 'abc'],
    ['embeddings and overrides', 'a\u202Ab\u202Bc\u202Cd\u202De\u202Ef', 'abcdef'],
    ['isolates', 'a\u2066b\u2067c\u2068d\u2069e', 'abcde'],
    ['a zero width space and a word joiner', 'a\u200Bb\u2060c', 'abc'],
    ['lone surrogates', 'a\uD800b\uDC00c', 'abc'],
    ['an override between two spaces', 'Brest \u202E Yeu', 'Brest Yeu'],
  ])('removes %s', (_case, input, output) => {
    expect(cleanPassageName(input)).toBe(output);
  });

  it.each([
    ['a zero width joiner in an emoji sequence', 'Crew 👩\u200D👩\u200D👧'],
    ['a zero width non-joiner', 'می\u200Cخواهم'],
    ['a flag of tag characters', 'Cardiff 🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73\uDB40\uDC7F'],
    ['a regional flag', 'Brest 🇫🇷'],
    ['accents, arrows and dashes', 'Île d’Yeu → Les Sables-d’Olonne – retour'],
    ['decomposed letters, as given (no normalisation)', 'Ilé'],
  ])('keeps %s', (_case, name) => {
    expect(cleanPassageName(name)).toBe(name);
  });

  it('cuts at 80 code units without splitting a surrogate pair, then trims', () => {
    expect(PASSAGE_NAME_MAX_LENGTH).toBe(80);
    expect(cleanPassageName('a'.repeat(100))).toBe('a'.repeat(80));
    expect(cleanPassageName(`${'a'.repeat(79)}😀`)).toBe('a'.repeat(79));
    expect(cleanPassageName(`${'a'.repeat(78)}😀`)).toBe(`${'a'.repeat(78)}😀`);
    expect(cleanPassageName(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
  });

  it('gives an empty name for anything that is not text or holds nothing to show', () => {
    for (const value of [null, undefined, 42, {}, ['a'], '', '   ', '\u202E\u200B\u0000']) expect(cleanPassageName(value)).toBe('');
  });

  it('is idempotent, and never leaves a lone surrogate, over random text', () => {
    // a fixed pseudo-random sequence over the code units the rule cares about, and ordinary ones
    const pool = [0x20, 0x09, 0x0a, 0x00, 0x7f, 0x85, 0x9f, 0xa0, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069,
      0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d, 0xde00, 0x41, 0x7a, 0xe9, 0x2192, 0x3000, 0xfeff];
    let state = 2463534242;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let i = 0; i < 2000; i++) {
      const text = String.fromCharCode(...Array.from({ length: next() % 120 }, () => pool[next() % pool.length]!));
      const once = cleanPassageName(text);
      expect(cleanPassageName(once), JSON.stringify(text)).toBe(once);
      expect(LONE.test(once)).toBe(false);
      expect(once.length).toBeLessThanOrEqual(80);
      expect(once).toBe(once.trim());
      expect(/\s\s/.test(once)).toBe(false);
    }
  });

  it('leaves every route name of the committed routes and demo checks as it is', () => {
    const names: string[] = [];
    const routes = resolve(import.meta.dirname, '../../config/routes');
    for (const file of readdirSync(routes).filter((name) => name.endsWith('.json'))) names.push(JSON.parse(readFileSync(join(routes, file), 'utf8')).name);
    const demo = resolve(import.meta.dirname, '../../viewer/test/fixtures/demo/snapshots');
    for (const dir of readdirSync(demo)) {
      try { names.push(JSON.parse(readFileSync(join(demo, dir, 'route.json'), 'utf8')).name); } catch { /* a served check without a route file */ }
    }
    const named = names.filter((name) => typeof name === 'string');
    expect(named.length).toBeGreaterThan(3);
    expect(named).toContain('Cherbourg → Plymouth');
    for (const name of named) expect(cleanPassageName(name)).toBe(name);
  });
});
