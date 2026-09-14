import { createElement } from 'react';
import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import Evidence from '../src/pages/Evidence.jsx';
import EvidenceInspector from '../src/components/EvidenceInspector.jsx';
import BulletinPanel from '../src/components/BulletinPanel.jsx';
import SynopticCompare from '../src/components/SynopticCompare.jsx';
import { useApp } from '../src/stores/appStore.js';
import phrases from './fixtures/i18n-leaks.json';

const initialState = useApp.getState();
afterEach(() => { cleanup(); useApp.setState(initialState, true); });

it.each(Object.entries(phrases))('translates the complete leak: %s', (english, french) => {
  expect(translateText(english, 'fr')).toBe(french);
  expect(translateText(english, 'en')).toBe(english);
});

it.each([
  ['computing route…', 'calcul de la route…'],
  ['reading 31-member ensemble tiles…', 'lecture des tuiles d’ensemble à 31 membres…'],
  ['reading 51-member ensemble tiles', 'lecture des tuiles d’ensemble à 51 membres'],
  ['reading deterministic forecast tiles…', 'lecture des tuiles de prévision déterministe…'],
  ['No route found within 48 h (wind coverage, land, or no-go conditions)', 'Aucune route trouvée en 48 h (couverture du vent, terre ou conditions impraticables)'],
  ['Boat polar “sun-fast-3200” not found. Regenerate and publish the ORC polar database.', 'Polaire du bateau « sun-fast-3200 » introuvable. Régénérez et publiez la base de polaires ORC.'],
  ['Forecast grid coarsened to 0.5° to keep this crossing within the browser point budget.', 'Grille de prévision ramenée à 0.5° pour respecter le nombre de points gérable par le navigateur pour cette traversée.'],
  ['scanning departures 3/21…', 'comparaison des départs 3/21…'],
  [' · 12 h old', ' · il y a 12 h'],
  ['Seas to 0.8 m significant (deterministic wave model; no wave ensembles exist).', 'Mer significative jusqu’à 0.8 m (modèle de vagues déterministe ; aucun ensemble de vagues).'],
  ['Authority override: bulletin casquets:BMS-large:2026-07-20T12:00:00Z active during the passage window.', 'Priorité à l’autorité : le bulletin casquets:BMS-large:2026-07-20T12:00:00Z est actif pendant la fenêtre de traversée.'],
  ['Emulated evidence entries: E23.', 'Entrées probantes simulées : E23.'],
  ['Previous synoptic chart', 'Carte synoptique précédente'],
  ['Latest synoptic chart', 'Dernière carte synoptique'],
])('translates runtime parameters and sentence fragments: %s', (english, french) => {
  expect(translateText(english, 'fr')).toBe(french);
  expect(translateText(english, 'en')).toBe(english);
});

it('localises real split React nodes, attributes and bulletin age, and restores English', async () => {
  const evidence = { evidence_id: 'E1', source_kind: 'ensemble', member_fraction: { exceed: 3, total: 10 }, limit: 18, units: 'kt', model: 'GEFS', bulletin_ref: { issued_at: new Date(Date.now() - 12 * 3600_000).toISOString(), zone_ids: [] } };
  useApp.setState({ selectedEvidenceId: 'E1', inspectorOpen: true, evidenceById: () => evidence, findings: { legs: [], inputs: { forecast_tiles: [] } }, warnings: { source: { mode: 'synthetic' }, bulletins: [{ raw_text: 'Original bulletin text must stay unchanged.', zone_id: 'casquets' }] } });
  const synoptic = { systems: [{ kind: 'low', system_id: 'L1', track: [{ center_hpa: 996 }] }], chart_captions: [{ file: 'chart.svg', caption: 'Previous run keeps the low west of the route longer.' }] };
  const content = <><EvidenceInspector /><BulletinPanel evidence={evidence} onClose={() => {}} /><SynopticCompare previous={synoptic} latest={synoptic} /></>;
  const view = render(<div id="root">{content}{createElement(LocalizedDocument, { language: 'fr' })}</div>);
  await waitFor(() => expect(view.container.textContent).toContain('il y a 12 h'));
  expect(view.container.textContent).toContain('scénarios de prévision dépassent 18 nd. Il s’agit d’un décompte brut (30%), et non d’une probabilité étalonnée.');
  expect(view.container.textContent).toContain('3 sur 10');
  expect(view.container.textContent).toContain('L’analyse précédente maintient la dépression');
  expect(view.container.querySelector('figcaption').textContent).toContain('Analyse précédente');
  expect(view.container.querySelectorAll('figcaption')[1].textContent).toContain('Dernière analyse');
  expect(view.container.querySelector('img').alt).toBe('Carte synoptique précédente');
  expect(view.container.querySelector('pre').textContent).toBe('Original bulletin text must stay unchanged.');
  view.rerender(<div id="root">{content}{createElement(LocalizedDocument, { language: 'en' })}</div>);
  expect(view.container.textContent).toContain('forecast scenarios exceed 18 kt. This is a raw count (30%), not a calibrated probability.');
  expect(view.container.textContent).toContain('12 h old');
});

it('translates whole briefing values and every sentence without partial English', async () => {
  const { collectCoverage } = await import('./helpers/i18nCoverage.js');
  const { default: path } = await import('node:path');
  const { samples } = collectCoverage(path.resolve(import.meta.dirname, '../..'));
  const english = /\b(?:Synoptic availability|Route conditions|checks remain|this run|all \d|gust limit|of this leg|Driver:|The forecasts|Unassessed hazard|Partial capability|Detected systems|Provider modes|not a calibrated|This state|no prepared synoptic|on L\d| at \d{4}-)\b/i;
  for (const { text, source } of samples.filter((sample) => sample.source.includes('.json#'))) {
    expect(translateText(text, 'fr'), `${source}: ${text}`).not.toMatch(english);
  }
});


it('keeps the evidence hazard phrase together for French word order', async () => {
  const evidence = { evidence_id: 'E1', rule_id: 'W-SUST-03', leg_id: 'L1', source_kind: 'ensemble', member_fraction: { exceed: 3, total: 10 }, limit: 18, units: 'kt' };
  useApp.setState({ selectedEvidenceId: 'E1', findings: { evidence: [evidence], legs: [{ leg_id: 'L1', name: 'Start → Finish' }] }, plume: null });
  const content = <Evidence />;
  const view = render(<div id="root">{content}<LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(view.getByRole('heading', { level: 1 }).textContent).toBe('3 sur 10 scénarios de prévision dépassent votre limite de vent'));
  view.rerender(<div id="root">{content}<LocalizedDocument language="en" /></div>);
  expect(view.getByRole('heading', { level: 1 }).textContent).toBe('3 of 10 forecast scenarios exceed your wind limit');
});
