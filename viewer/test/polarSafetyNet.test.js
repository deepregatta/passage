import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@deepweather/engine';
import { holdsPolarData } from '../src/lib/polarSafetyNet.js';

// The no-polar-data safety net's precomputed canonical texts (lib/polarSafetyNet.js).
// Invented, polar-shaped and built at run time, so this source holds no polar table.
const key = ['speeds', 'kt'].join('_');
const table = [[4.1, 5.2], [6.3, 7.4]];

describe('holdsPolarData with canonical texts already built', () => {
  it('reads the given text in place of the value\'s own canonical JSON, for that value only', () => {
    const clean = { a: 1 };
    // a stand-in text that matches proves the given text is the one scanned
    expect(holdsPolarData({ values: [clean] })).toBe(false);
    expect(holdsPolarData({ values: [clean], canonicalTexts: new Map([[clean, canonicalJson({ [key]: table })]]) })).toBe(true);
    // keyed by the value itself: an equal copy gets its own canonical JSON
    expect(holdsPolarData({ values: [{ a: 1 }], canonicalTexts: new Map([[clean, canonicalJson({ [key]: table })]]) })).toBe(false);
  });

  it('still builds the other values\' canonical JSON and walks every long string', () => {
    const inputs = { a: 1 };
    const canonicalTexts = new Map([[inputs, canonicalJson(inputs)]]);
    // behind an escaped key: only the canonical JSON of the parsed value shows it
    const escaped = JSON.parse(`{"debug": {"${key.replace('_', '\\u005f')}": ${JSON.stringify(table)}}}`);
    expect(holdsPolarData({ values: [inputs, escaped], canonicalTexts })).toBe(true);
    // inside a JSON string of the value whose canonical text was given
    const nested = { debug: JSON.stringify({ [key]: table }) };
    expect(holdsPolarData({ values: [nested], canonicalTexts: new Map([[nested, '{}']]) })).toBe(true);
    // and the raw texts first
    expect(holdsPolarData({ texts: [JSON.stringify({ [key]: table })], values: [inputs], canonicalTexts })).toBe(true);
    expect(holdsPolarData({ texts: ['{}'], values: [inputs], canonicalTexts })).toBe(false);
  });
});
