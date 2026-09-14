import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateText } from '../src/i18n.js';
import { briefingStrings, collectCoverage, identityEntries, jsxLiterals } from './helpers/i18nCoverage.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const allowlist = JSON.parse(readFileSync(path.join(import.meta.dirname, 'i18n-coverage-allowlist.json'), 'utf8'));
const coverage = collectCoverage(repoRoot);

describe('French translation coverage', () => {
  it('discovers JSX sources and both golden and demo briefings', () => {
    expect(coverage.jsx.length).toBeGreaterThan(0);
    expect(coverage.golden.length).toBeGreaterThan(0);
    expect(coverage.demo.length).toBeGreaterThan(0);
  });

  it('allows only explicitly recorded identity translations, with no stale entries', () => {
    const actual = identityEntries(coverage.samples, translateText);
    const missing = coverage.samples.filter(({ text, source }) => {
      const file = source.split(/#|:\d/)[0];
      return translateText(text, 'fr') === text && !allowlist.entries[file]?.includes(text);
    });
    expect(missing, 'New identity translations (source location + exact text); translate them or explicitly review the allowlist').toEqual([]);
    expect(actual, 'Remove stale/duplicate exceptions when text is translated or removed; keep entries sorted').toEqual(allowlist.entries);
  });
});

describe('coverage scanner regressions', () => {
  it('captures JSX text, decoded attributes, expressions, both branches and template fragments', () => {
    const samples = jsxLiterals(`// "Ignore this comment"
      const note = "A newly introduced diagnostic.";
      const progress = \`Scanning \${count} departures…\`;
      const view = <p title="Sail &amp; wait">First line
        second line {flag ? 'Pending text' : 'Alternate text'}{' h old'}<b>avg</b></p>;`, 'example.jsx');
    expect(samples.map(({ text }) => text)).toEqual([
      'A newly introduced diagnostic.', 'Scanning', 'departures…', 'Sail & wait',
      'First line second line', 'Pending text', 'Alternate text', 'h old', 'avg',
    ]);
    expect(samples.every(({ source }) => /^example\.jsx:\d+:\d+$/.test(source))).toBe(true);
  });

  it('rejects malformed JSX rather than silently scanning a partial file', () => {
    expect(() => jsxLiterals('const view = <p title="unfinished', 'broken.jsx')).toThrow('Cannot parse broken.jsx');
  });

  it('visits nested briefing fields and individual sentences without splitting decimals', () => {
    const samples = briefingStrings({ sections: [{ register_pro: 'Start. An unexplained 0.8 m swell remains.' }], future_field: ['A new sentence.'] }, 'briefing.json');
    expect(samples).toContainEqual({ text: 'An unexplained 0.8 m swell remains.', source: 'briefing.json#/sections/0/register_pro' });
    expect(samples).toContainEqual({ text: 'A new sentence.', source: 'briefing.json#/future_field/0' });
    expect(identityEntries(samples, translateText)['briefing.json']).toContain('An unexplained 0.8 m swell remains.');
  });

  it('detects a new literal or lost translation and scopes exceptions to their file', () => {
    const samples = [
      ...jsxLiterals('const view = <p>Start</p>;', 'a.jsx'),
      ...jsxLiterals('const view = <p>A new untranslated diagnostic.</p>;', 'b.jsx'),
    ];
    expect(identityEntries(samples, translateText)).toEqual({ 'b.jsx': ['A new untranslated diagnostic.'] });
    expect(identityEntries(samples, (text) => text)).toEqual({ 'a.jsx': ['Start'], 'b.jsx': ['A new untranslated diagnostic.'] });
  });
});
