import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateText } from '../src/i18n.js';
import { briefingStrings, collectCoverage, identityEntries, jsxLiterals } from './helpers/i18nCoverage.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const allowlist = JSON.parse(readFileSync(path.join(import.meta.dirname, 'i18n-coverage-allowlist.json'), 'utf8'));
const coverage = collectCoverage(repoRoot);
const invariants = JSON.parse(readFileSync(path.join(import.meta.dirname, 'i18n-coverage-invariants.json'), 'utf8'));
const classified = Object.values(invariants.categories).flatMap((files) => Object.entries(files).flatMap(([file, texts]) => texts.map((text) => ({ text, source: file }))));

describe('French translation coverage', () => {
  it('discovers JSX sources and both golden and demo briefings', () => {
    expect(coverage.jsx.length).toBeGreaterThan(0);
    expect(coverage.golden.length).toBeGreaterThan(0);
    expect(coverage.demo.length).toBeGreaterThan(0);
  });

  it('has no untranslated prose exceptions and only reviewed invariant identities', () => {
    expect(allowlist.entries).toEqual({});
    const actual = identityEntries(coverage.samples, translateText);
    const expected = identityEntries(classified, (text) => text);
    expect(Object.keys(invariants.categories).sort()).toEqual(['french', 'notation', 'technical']);
    expect(classified.length).toBe(Object.values(expected).flat().length);
    const missing = coverage.samples.filter(({ text, source }) => translateText(text, 'fr') === text
      && !expected[source.split(/#|:\d/)[0]]?.includes(text));
    expect(missing, 'New identity translations with exact source locations').toEqual([]);
    expect(actual, 'Translate new prose; review technical/French/notation identities explicitly and remove stale entries').toEqual(expected);
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

  it('excludes syntax by AST role but retains accessible copy and unknown expressions', () => {
    const samples = jsxLiterals(`import thing from './module.js';
      const view = <p className="text-sm" style={{ color: 'red' }} title="A new title" aria-label="A new label">
        {flag ? 'New text' : 'Alternate text'}<Panel label="Custom label" name="Custom name" /></p>;`, 'example.jsx');
    expect(samples.map(({ text }) => text)).toEqual(['A new title', 'A new label', 'New text', 'Alternate text', 'Custom label', 'Custom name']);
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

it('ignores intrinsic table scope while retaining custom scope copy', () => {
  const samples = jsxLiterals('<table><tr><th scope="col">Heading</th><th scope="row">Row</th></tr></table>; <Panel scope="Visible copy" />', 'table.jsx');
  expect(samples.map(({ text }) => text)).toEqual(['Heading', 'Row', 'Visible copy']);
});
