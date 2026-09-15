import { readFileSync } from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import Verification from '../src/pages/Verification.jsx';
import CaseStudy from '../src/pages/CaseStudy.jsx';

const source = readFileSync(path.join(import.meta.dirname, '../src/i18n.js'), 'utf8');
const tree = ts.createSourceFile('i18n.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function catalogueKeys() {
  let keys;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'FR') {
      keys = node.initializer.properties.map((property) => property.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return keys;
}

it('has no duplicate French catalogue keys hidden by object literal overwrites', () => {
  const seen = new Set();
  expect(catalogueKeys().filter((key) => seen.has(key) || !seen.add(key))).toEqual([]);
});

it.each([
  ['1 pass · 1 fail · 0 pending', '1 réussite · 1 échec · 0 en attente'],
  ['0 pass · 2 fail · 1 pending', '0 réussites · 2 échecs · 1 en attente'],
  ['2 pass · 0 fail · 3 pending', '2 réussites · 0 échecs · 3 en attente'],
  ['1 emulated case shown for demo only.', '1 cas simulé affiché uniquement pour la démonstration.'],
  ['0 emulated cases shown for demo only.', '0 cas simulés affichés uniquement pour la démonstration.'],
  ['2 emulated cases shown for demo only.', '2 cas simulés affichés uniquement pour la démonstration.'],
])('translates verification counts through the shared catalogue: %s', (english, french) => {
  expect(translateText(english, 'fr')).toBe(french);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); useApp.setState({ findings: null, language: 'en' }); });

it.each([[Verification, 'Track record'], [CaseStudy, 'Open a briefing to view its case study.']])(
  'keeps page copy English until the document localiser translates it', (Page, english) => {
    useApp.setState({ findings: null, language: 'fr' });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const content = <Page />;
    const view = render(<div id="root">{content}<LocalizedDocument language="en" /></div>);
    expect(view.container.textContent).toContain(english);
    view.rerender(<div id="root">{content}<LocalizedDocument language="fr" /></div>);
    expect(view.container.textContent).toContain(translateText(english, 'fr'));
    view.rerender(<div id="root">{content}<LocalizedDocument language="en" /></div>);
    expect(view.container.textContent).toContain(english);
  },
);

it('localises asynchronously loaded verification counts and restores English', async () => {
  useApp.setState({ findings: null, language: 'fr' });
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => url.endsWith('corpus.json')
    ? { cases: 2, pass: 1, fail: 1, pending: 0 }
    : url.endsWith('index.json') ? { cases: [{ observation_source: 'emulated' }] } : { records: [] } })));
  const content = <Verification />;
  const view = render(<div id="root">{content}<LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(view.container.textContent).toContain('1 réussite · 1 échec · 0 en attente'));
  expect(view.container.textContent).toContain('1 cas simulé affiché uniquement pour la démonstration.');
  view.rerender(<div id="root">{content}<LocalizedDocument language="en" /></div>);
  expect(view.container.textContent).toContain('1 pass · 1 fail · 0 pending');
  expect(view.container.textContent).toContain('1 emulated case shown for demo only.');
});

// Exact keys assembled at runtime or supplied by Leaflet, with their owner.
// New exceptions need a concrete producer; ordinary obsolete copy is removed.
const dynamicKeys = {
  'Latest run': 'SynopticCompare.jsx: SystemCard appends run to its Latest label',
  'forecast scenarios exceed your wind limit': 'Evidence.jsx: variable is interpolated into a whole text node',
  'forecast scenarios exceed your gust limit': 'Evidence.jsx: variable is interpolated into a whole text node',
  'contributors, seamarks © OpenSeaMap': 'Leaflet joins OSM and OpenSeaMap attribution text',
  'slow speed': 'Planner.jsx: accessible speed input label is built from k',
  'nominal speed': 'Planner.jsx: accessible speed input label is built from k',
  'fast speed': 'Planner.jsx: accessible speed input label is built from k',
  'A weather system crosses your passage window': 'WeatherStoryCard.jsx: headline uses capitalize(plainEventNoun(...))',
  'A low-pressure system crosses your passage window': 'WeatherStoryCard.jsx: headline uses capitalize(plainEventNoun(...))',
  'A deepening low crosses your passage window': 'WeatherStoryCard.jsx: headline uses capitalize(plainEventNoun(...))',
  'A high-pressure ridge crosses your passage window': 'WeatherStoryCard.jsx: headline uses capitalize(plainEventNoun(...))',
  'A weather front crosses your passage window': 'WeatherStoryCard.jsx: headline uses capitalize(plainEventNoun(...))',
  'partially assessed': 'ModelsUsed.jsx and AssessmentDetails.jsx: status.replaceAll replaces underscores with spaces',
  'model agreement': 'AssessmentDetails.jsx: capability.replaceAll replaces underscores with spaces',
  'Zoom in': 'Leaflet zoom control title and aria-label',
  'Zoom out': 'Leaflet zoom control title and aria-label',
};

it('keeps only referenced catalogue keys or documented runtime labels', async () => {
  const { walkFiles } = await import('./helpers/i18nCoverage.js');
  const root = path.resolve(import.meta.dirname, '../..');
  const files = ['viewer/src', 'engine/src', 'analysis/src', 'config', 'contracts', 'engine/test/golden', 'viewer/test/fixtures/demo']
    .flatMap((dir) => walkFiles(path.join(root, dir), (file) => /\.(jsx?|tsx?|json|py)$/.test(file)))
    .filter((file) => file !== path.join(root, 'viewer/src/i18n.js'));
  const corpus = files.map((file) => {
    const text = readFileSync(file, 'utf8');
    const literals = [];
    // Decoded string values cover escaped apostrophes/quotes and HTML entities.
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    if (/\.[jt]sx?$/.test(file)) visit(ast);
    return [text, ...literals].join('\n');
  }).join('\n').replaceAll('&copy;', '©').replace(/\s+/g, ' ');
  const keys = catalogueKeys();
  const missing = keys.filter((key) => !corpus.includes(key) && !dynamicKeys[key]);
  expect(missing, 'Remove stale copy or document its exact runtime producer').toEqual([]);
  expect(Object.keys(dynamicKeys).filter((key) => !keys.includes(key) || corpus.includes(key)), 'Remove obsolete runtime exceptions').toEqual([]);
});

it.each(['emulated', 'station'])('localises the loaded case study, including its %s source and error interpretations', async (observationSource) => {
  useApp.setState({ findings: { snapshot_id: 'case-34', causal_events: [] }, language: 'en' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    observation_source: observationSource,
    pairs: [1, 5].map((error) => ({ leg_id: 'L1', valid_time: '2026-07-20T12:00:00Z', variable: 'wind_kt', forecast: 12, observed: 12 - error, error })),
  }) })));
  const content = <CaseStudy />;
  const view = render(<div id="root">{content}<LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(view.container.textContent).toContain('écart significatif, marge à élargir'));
  expect(view.container.textContent).toContain('intensité utile');
  expect(view.container.textContent).toContain('L’analyse initiale ne permettait pas d’attribuer les conditions à un système météo.');
  expect(view.container.textContent).toContain(observationSource === 'emulated'
    ? 'DÉMONSTRATION SIMULÉE · AUCUN RÉSULTAT RÉEL' : 'SOURCE DES OBSERVATIONS · station');
  view.rerender(<div id="root">{content}<LocalizedDocument language="en" /></div>);
  expect(view.container.textContent).toContain('material miss; widen margin');
  expect(view.container.textContent).toContain(observationSource === 'emulated'
    ? 'EMULATED DEMO · NOT A SKILL CLAIM' : 'OBSERVATION SOURCE · station');
});

it('translates the analysis title while preserving the snapshot identifier', () => {
  expect(translateText('This analysis · case-34', 'fr')).toBe('Cette analyse · case-34');
});
