import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASSAGE_NAME_MAX_LENGTH, cleanPassageName, stripInvisibleControls } from '../src/index.js';

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
    ['Hangul fillers that render blank', '\u3164\u3164', ''],
    ['a halfwidth Hangul filler and choseong/jungseong fillers', '\uFFA0 \u115F\u1160', ''],
    ['nothing but joiners and variation selectors', '\u200D\u200C\uFE0F\uFE0E \u200D', ''],
    ['a soft hyphen and a grapheme joiner', 'Bre\u00ADst\u034F', 'Brest'],
    ['Khmer inherent vowels and Mongolian variation selectors', 'a\u17B4\u17B5b\u180B\u180Fc', 'abc'],
    ['invisible operators and deprecated format controls', 'a\u2061\u2064b\u206A\u206Fc', 'abc'],
    ['variation selectors 1 to 14, keeping 15 and 16', 'a\uFE00\uFE0Db\uFE0Ec\uFE0F', 'ab\uFE0Ec\uFE0F'],
    ['specials U+FFF0 to U+FFFB', 'a\uFFF0\uFFF9\uFFFBb', 'ab'],
    ['shorthand format controls and musical formatting', 'a\uD82F\uDCA0\uD82F\uDCA3b\uD834\uDD73\uD834\uDD7Ac', 'abc'],
    ['tag characters, alone or in a subdivision flag, and the variation-selector supplement', 'Cardiff \uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC7F x\uDB40\uDD00\uDB40\uDDEF\uDB43\uDFFF\uDB40\uDC00', 'Cardiff \uD83C\uDFF4 x'],
  ])('also removes %s (tightened 2026-11-16)', (_case, input, output) => {
    expect(cleanPassageName(input)).toBe(output);
  });

  it.each([
    ['braille pattern blanks', '\u2800\u2800', ''],
    ['a braille blank inside a name', 'Brest\u2800Yeu', 'BrestYeu'],
    ['a name of combining marks only', '\u0301\u0308 \u1AB0\u1DC0\u20D0\uFE20', ''],
    ['combining marks with joiners and presentation selectors only', '\u0301\u200D\uFE0F', ''],
  ])('empties or cleans %s (tightened again 2026-11-16)', (_case, input, output) => {
    expect(cleanPassageName(input)).toBe(output);
  });

  it('keeps combining marks on a visible letter: é written as e and U+0301 stays as given', () => {
    for (const name of ['Le Ve\u0301lo', 'e\u0301', 'Cafe\u0301 \u20DD']) expect(cleanPassageName(name)).toBe(name);
  });

  it.each([
    ['a zero width joiner in an emoji sequence', 'Crew 👩\u200D👩\u200D👧'],
    ['a zero width non-joiner', 'می\u200Cخواهم'],
    ['a regional flag', 'Brest 🇫🇷'],
    ['accents, arrows and dashes', 'Île d’Yeu → Les Sables-d’Olonne – retour'],
    ['Arabic', 'من الدار البيضاء إلى طنجة'],
    ['Hebrew', 'מחיפה לאשדוד'],
    ['CJK', '横浜から神戸へ'],
    ['an emoji presentation selector', 'Brest \u2693\uFE0F'],
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

  // Explicit timeout: a CPU-bound property test over generated cases (fixed seeds, no I/O or timers). The default 5 s is too tight beside other work on the machine; a real hang still fails.
  it('is idempotent, never leaves a lone surrogate and never leaves a blank name, over 22,000 random strings', () => {
    // a fixed pseudo-random sequence over the code units the rule cares about, and ordinary ones
    const pool = [0x20, 0x09, 0x0a, 0x00, 0x7f, 0x85, 0x9f, 0xa0, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069,
      0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d, 0xde00, 0x41, 0x7a, 0xe9, 0x2192, 0x3000, 0xfeff,
      // the classes added on 2026-11-16, and the halves of the astral ranges removed
      0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x180b, 0x2061, 0x206a, 0x3164, 0xfe00, 0xfe0d, 0xfe0e, 0xfe0f, 0xffa0, 0xfff0, 0xfffb,
      0xd82f, 0xdca0, 0xd834, 0xdd73, 0xdb40, 0xdb43, 0xdc67, 0xdfff, 0x5d0, 0x627,
      0x2800, 0x300, 0x36f, 0x1ab0, 0x1aff, 0x1dc0, 0x1dff, 0x20d0, 0x20ff, 0xfe20, 0xfe2f];
    let state = 2463534242;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let i = 0; i < 22_000; i++) {
      const text = String.fromCharCode(...Array.from({ length: next() % 120 }, () => pool[next() % pool.length]!));
      const once = cleanPassageName(text);
      expect(cleanPassageName(once), JSON.stringify(text)).toBe(once);
      expect(LONE.test(once)).toBe(false);
      expect(once.length).toBeLessThanOrEqual(80);
      expect(once).toBe(once.trim());
      expect(/\s\s/.test(once)).toBe(false);
      // eslint-disable-next-line no-misleading-character-class -- single code units: the joiners and the presentation selectors
      if (once) expect(/[^ \u200C\u200D\uFE0E\uFE0F\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/.test(once)).toBe(true);
    }
  }, 60_000);

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

describe('cleanPassageName and stripInvisibleControls share their classes', () => {
  it('removes from a name exactly the code units it removed before the classes were shared', () => {
    // the rule's literal class as committed in 990538c: white space becomes a space first
    // eslint-disable-next-line no-control-regex, no-misleading-character-class -- the committed class, controls and combining code units included
    const BEFORE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0D\uFFA0\uFFF0-\uFFFB]/;
    const wrong: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      if (unit >= 0xd800 && unit <= 0xdfff) continue;
      const ch = String.fromCharCode(unit);
      const expected = /\s/.test(ch) ? 'a b' : BEFORE.test(ch) ? 'ab' : `a${ch}b`;
      if (cleanPassageName(`a${ch}b`) !== expected) wrong.push(unit.toString(16));
    }
    expect(wrong).toEqual([]);
  });
});

describe('stripInvisibleControls', () => {
  it('removes exactly the C0 and C1 controls but ordinary white space, and the bidirectional controls', () => {
    const removed: number[] = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      if (stripInvisibleControls(`a${String.fromCharCode(unit)}b`) === 'ab') removed.push(unit);
    }
    const expected = [
      ...Array.from({ length: 9 }, (_, i) => i), ...Array.from({ length: 0x12 }, (_, i) => 0x0e + i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ];
    expect(removed).toEqual(expected);
  });

  it('turns a right-to-left override in a sentence back into the sentence', () => {
    expect(stripInvisibleControls('Wind \u202Egnisae\u202C later.')).toBe('Wind gnisae later.');
    expect(stripInvisibleControls('Off\u2066 Cherbourg\u2069 at\u200F dawn\u0007\u0085')).toBe('Off Cherbourg at dawn');
  });

  it('changes nothing else: white space, blank characters, joiners, no-break spaces and length stay as given', () => {
    for (const text of [
      '  two  spaces, a tab\t, a line\nbreak, \u000B\u000C\r ',
      'soft\u00ADhyphen, zero\u200Bwidth, braille\u2800blank, word\u2060joiner, \u3164filler',
      'joiners \uD83D\uDC68\u200D\uD83D\uDC69 and \u2764\uFE0F, e\u0301, 1\u00A0kn, 20\u202F%, \uFEFF',
      'lone \uD800 surrogate',
      'x'.repeat(5000),
      '',
    ]) expect(stripInvisibleControls(text)).toBe(text);
  });

  it('returns anything that is not a string as is', () => {
    const object = { register_plain: '\u202E' };
    for (const value of [null, undefined, 42, object, ['\u202E']]) expect(stripInvisibleControls(value)).toBe(value);
  });
});
