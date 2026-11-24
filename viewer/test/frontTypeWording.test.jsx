import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { checkWording } from '../src/pages/briefing/checkWording.js';
import savedFindings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';
import savedBriefing from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/briefing.json';
import savedRoute from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/route.json';

// The engine writes "(§4.1)" into the synoptic section of every check; saved checks and goldens keep it.
// The page shows the sentence without the reference, in both languages.

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));

const stored = () => useApp.getState().briefing.sections.find((section) => section.id === 'synoptic_story').register_pro;

beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(savedFindings), briefing: structuredClone(savedBriefing),
    route: structuredClone(savedRoute), page: 'briefing' }, true);
  usePlanner.setState(usePlanner.getInitialState(), true);
  usePlayback.setState(usePlayback.getInitialState(), true);
});
afterEach(() => { cleanup(); useApp.setState(useApp.getInitialState(), true); });

const professionalRegister = () => {
  fireEvent.click(screen.getByRole('button', { name: /Why this assessment|Pourquoi cette évaluation/ }));
  return screen.getByText(/^(Professional register|Registre professionnel)$/).closest('details');
};

it('shows the synoptic sentence of a saved check without the section reference, in English; no "§" is left', () => {
  const saved = stored();
  expect(saved).toContain('Front-type labels withheld pending corroboration (§4.1).');
  render(<div id="root"><Briefing /></div>);
  const register = professionalRegister();
  expect(register).toHaveTextContent('Front-type labels withheld pending corroboration.');
  expect(register.textContent).not.toContain('§');
  expect(stored()).toBe(saved);
});

it('shows it without the reference in French; no "§" is left', async () => {
  useApp.setState({ language: 'fr' });
  render(<div id="root"><Briefing /><LocalizedDocument language="fr" /></div>);
  const register = professionalRegister();
  await waitFor(() => expect(register.textContent).toContain('Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration.'));
  expect(register.textContent).not.toContain('§');
  expect(register.textContent).toContain('Systèmes détectés (reference-demo-20260719T18Z)');
});

const SYSTEMS = 'lows L1 (1002 hPa near 49°N 7°W), deepening 18 hPa/24h, moving ENE 31 kt; highs H1 (1024.5 hPa near 45°N 12°W), steady';
const BODIES = [
  `Detected systems (reference-demo-20260719T18Z): ${SYSTEMS}.`,
  `Detected systems (run-1): lows none; highs none.`,
  `Detected systems (run-1): ${SYSTEMS}. Named regime active: R1, R2.`,
];

it.each(BODIES)('drops only the reference, at the end of the whole sentence (%#)', (body) => {
  expect(checkWording(`${body} Front-type labels withheld pending corroboration (§4.1).`)).toBe(`${body} Front-type labels withheld pending corroboration.`);
  expect(checkWording(`${body} Front-type labels withheld pending corroboration.`)).toBe(`${body} Front-type labels withheld pending corroboration.`);
});

it('leaves other text, and text that only looks like it, alone', () => {
  for (const text of [
    'Front-type labels withheld pending corroboration (§4.1).',
    'Other. Detected systems (run-1): lows none; highs none. Front-type labels withheld pending corroboration (§4.1).',
    'Detected systems (run-1): lows none; highs none. Front-type labels withheld pending corroboration (§4.1). More.',
    'See §4.1 for the method (§4.1).',
    'Plain text',
  ]) expect(checkWording(text)).toBe(text);
  expect(checkWording(undefined)).toBeUndefined();
});

it.each(BODIES)('translates the new sentence exactly as the frozen one minus the reference (%#)', (body) => {
  const frozen = translateText(`${body} Front-type labels withheld pending corroboration (§4.1).`, 'fr');
  const current = translateText(`${body} Front-type labels withheld pending corroboration.`, 'fr');
  expect(frozen).toMatch(/ \(§4\.1\)\.$/);
  expect(current).toBe(frozen.replace(' (§4.1)', ''));
  expect(current).toMatch(/^Systèmes détectés \(.+\) : .+ Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration\.$/);
  expect(current).not.toContain('§');
});

it('translates the sentence in full for the example check', () => {
  expect(translateText('Detected systems (reference-demo-20260719T18Z): lows L1 (1002 hPa near 49°N 7°W), deepening 18 hPa/24h, moving ENE 31 kt; highs none. Front-type labels withheld pending corroboration.', 'fr'))
    .toBe('Systèmes détectés (reference-demo-20260719T18Z) : dépressions L1 (1002 hPa près de 49°N 7°O), se creusant de 18 hPa/24 h, se déplaçant vers l’ENE à 31 nd ; aucun anticyclone. Les types de fronts ne sont pas indiqués dans l’attente d’une corroboration.');
});
