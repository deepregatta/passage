import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { governingReason } from '@deepweather/engine';
import Briefing from '../src/pages/Briefing.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { fmtTextTime } from '../src/lib/format.js';
import { useApp } from '../src/stores/appStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { verdictSentences } from '../src/pages/briefing/verdictSentence.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import savedPlume from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/plume.json';
import savedWarnings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/warnings.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => null }));

let findings;
beforeEach(() => {
  findings = structuredClone(savedFindings);
  useApp.setState({ ...useApp.getInitialState(), findings, briefing: structuredClone(savedBriefing),
    plume: structuredClone(savedPlume), warnings: structuredClone(savedWarnings), page: 'example' }, true);
  usePlayback.setState(usePlayback.getInitialState(), true);
});

/** the boat leaves leg 3 at its slow ETA: the governing window start, in the header zone */
const L3_EXIT = fmtTextTime('2026-07-20T17:03:36Z');
const LIMIT = `Your 18 kt wind limit is exceeded near Casquets TSS crossing (leg 3) around ${L3_EXIT}: the emulated scenario forecast reaches 18.3 kt.`;
const COUNT = '24 of 51 emulated forecast scenarios exceed that limit.';

it('warning_active (the example): the warning, then what the forecast shows against your limits', () => {
  expect(verdictSentences(findings, governingReason(findings), { emulatedWarning: true })).toEqual([
    'Synthetic warning scenario for Casquets: offshore marine bulletin (BMS) from Météo-France BMS (synthetic).',
    LIMIT,
    COUNT,
  ]);
  const official = verdictSentences(findings, governingReason(findings));
  expect(official[0]).toBe('Official warning for Casquets: offshore marine bulletin (BMS) from Météo-France BMS (synthetic).');
});

it('exceeds: the earliest exceeded limit, the model that shows it and the scenario count, labelled', () => {
  findings.verdict = { ...findings.verdict, state: 'exceeds', warning_override: { active: false, bulletin_ref: null } };
  findings.evidence.find((e) => e.evidence_id === 'E3').model = 'gfs_0p25';
  expect(verdictSentences(findings, governingReason(findings))).toEqual([
    `Your 18 kt wind limit is exceeded near Casquets TSS crossing (leg 3) around ${L3_EXIT}: the GFS forecast reaches 18.3 kt.`,
    COUNT,
  ]);
});

function disagreeing() {
  const f = structuredClone(savedFindings);
  f.verdict = { ...f.verdict, state: 'insufficient', warning_override: { active: false, bulletin_ref: null } };
  f.evidence.push({
    evidence_id: 'E99', rule_id: 'D-DIVERGE-01', model: 'gfs_0p25,ecmwf_ifs_0p25', run: '2026-07-20T12:00Z,2026-07-20T06:00Z',
    leg_id: 'L5', valid_time: '2026-07-20T20:00:00Z', value: { gfs_0p25: 24.2, ecmwf_ifs_0p25: 15.1 }, limit: null,
    units: 'kt spread', source_kind: 'deterministic',
    model_runs: [
      { model: 'gfs_0p25', layer: 'weather', run_id: 'weather-20260720T12Z', cycle: '2026-07-20T12:00Z' },
      { model: 'ecmwf_ifs_0p25', layer: 'weather-ecmwf-short', run_id: 'weather-ecmwf-short-20260720T06Z', cycle: '2026-07-20T06:00Z' },
    ],
  });
  return f;
}

it('insufficient: which models and runs disagree, the run-age gap, and still the limits', () => {
  const f = disagreeing();
  const sentences = verdictSentences(f, governingReason(f));
  expect(sentences).toEqual([
    `The models disagree about the wind near Plymouth approach (E of Eddystone) (leg 5) around ${fmtTextTime('2026-07-20T20:00:00Z')}: GFS (20 Jul 12Z run) 24 kt vs ECMWF (20 Jul 06Z run) 15 kt.`,
    'These runs are 6 h apart in age, so part of the difference may come from that.',
    LIMIT,
    COUNT,
  ]);
  expect(sentences.map((s) => translateText(s, 'fr'))).toEqual([
    `Les modèles divergent sur le vent près de l’approche de Plymouth (E de Eddystone) (tronçon 5) vers ${translateText(fmtTextTime('2026-07-20T20:00:00Z'), 'fr')} : GFS (cycle 20 juil. 12Z) 24 nd contre ECMWF (cycle 20 juil. 06Z) 15 nd.`,
    'Ces cycles ont 6 h d’écart d’âge : une partie de la différence peut en venir.',
    `Votre limite de vent de 18 nd est dépassée près de traversée du DST des Casquets (tronçon 3) vers ${translateText(L3_EXIT, 'fr')} : la prévision du scénario simulé atteint 18.3 nd.`,
    '24 scénarios de prévision simulés sur 51 dépassent cette limite.',
  ]);
});

it('falls back to the chip label alone when a saved check has nothing structured to quote', () => {
  const reason = { state: 'exceeds', result: null, warning: null, disagreement: null, other: null, verdict_driver_evidence_id: null };
  expect(verdictSentences(findings, reason)).toEqual([]);
});

it('example page: chip and sentence agree, and the top and Evidence headline quote the same count', () => {
  render(<Briefing />);
  const band = within(screen.getByTestId('decision-band'));
  expect(band.getByText('Official warning active', { exact: true })).toBeVisible();
  const sentence = band.getByRole('heading', { level: 1 });
  expect(sentence.textContent).toBe([
    'Synthetic warning scenario for Casquets: offshore marine bulletin (BMS) from Météo-France BMS (synthetic).', LIMIT, COUNT,
  ].join(' '));
  expect(sentence.textContent).not.toMatch(/UTC/);
  const evidence = document.querySelector('[data-section="evidence"]');
  expect(within(evidence).getByRole('heading', { level: 2 })).toHaveTextContent('24 of 51 forecast scenarios exceed your wind limit');
  // the story card quotes no "N of M … exceed" sentence of its own
  const story = document.querySelector('[data-section="story"]');
  expect(story.textContent).not.toMatch(/\b(?:All \d+|\d+ of \d+) forecast scenarios exceed/i);
  expect(story.textContent).not.toMatch(/\bUTC\b|\(L\d\)/);
});

it('example page in French: one verdict sentence, no English left', async () => {
  const { container } = render(<div id="root"><Briefing /><LocalizedDocument language="fr" /></div>);
  const sentence = within(screen.getByTestId('decision-band')).getByRole('heading', { level: 1 });
  await waitFor(() => expect(sentence.textContent).toMatch(/^Scénario d’alerte synthétique pour Casquets/));
  expect(sentence.textContent).toBe([
    'Scénario d’alerte synthétique pour Casquets : bulletin météo marine du large (BMS) de Météo-France BMS (synthétique).',
    `Votre limite de vent de 18 nd est dépassée près de traversée du DST des Casquets (tronçon 3) vers ${translateText(L3_EXIT, 'fr')} : la prévision du scénario simulé atteint 18.3 nd.`,
    '24 scénarios de prévision simulés sur 51 dépassent cette limite.',
  ].join(' '));
  expect(container.querySelector('[data-testid="decision-band"]').textContent).not.toMatch(/\b(?:the|your|limit|forecast|scenarios)\b/i);
});
