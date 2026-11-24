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

// The engine writes "(brief §5)" into the "not assessed" sentence of every check; saved checks and goldens
// keep it. The page shows the sentence without the reference, in both languages.

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));

const TAIL = 'Absence of a flag must not be read as absence of risk';
const stored = () => useApp.getState().briefing.sections.find((section) => section.id === 'unsupported').register_pro;

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

it('shows the "not assessed" sentence of a saved check without the brief reference, in English', () => {
  const saved = stored();
  expect(saved).toContain(`${TAIL} (brief §5).`);
  render(<div id="root"><Briefing /></div>);
  const register = professionalRegister();
  expect(register).toHaveTextContent(`${TAIL}.`);
  expect(register.textContent).not.toMatch(/§5/);
  expect(stored()).toBe(saved);
});

it('shows it without the briefing reference in French', async () => {
  useApp.setState({ language: 'fr' });
  render(<div id="root"><Briefing /><LocalizedDocument language="fr" /></div>);
  const register = professionalRegister();
  await waitFor(() => expect(register.textContent).toContain('L’absence de signalement ne doit pas être interprétée comme une absence de risque.'));
  expect(register.textContent).not.toMatch(/§5/);
  expect(register.textContent).toContain('Catégories de dangers non évaluées');
});

const WITH = 'Unassessed hazard classes: tidal currents (no current grid prepared); ice. Partial capability coverage: waves (deterministic wave model only). ';
const WITHOUT = 'Unassessed hazard classes: ice. ';

it.each([WITH, WITHOUT])('drops only the reference, at the end of the whole sentence (%#)', (lead) => {
  expect(checkWording(`${lead}${TAIL} (brief §5).`)).toBe(`${lead}${TAIL}.`);
  expect(checkWording(`${lead}${TAIL}.`)).toBe(`${lead}${TAIL}.`);
});

it('leaves other text, and text that only looks like it, alone', () => {
  for (const text of [
    `${TAIL} (brief §5).`,
    `Other. ${TAIL} (brief §5).`,
    `Unassessed hazard classes: ice. ${TAIL} (brief §5). More.`,
    'See brief §5 for the method (brief §5).',
    'Plain text',
  ]) expect(checkWording(text)).toBe(text);
  expect(checkWording(undefined)).toBeUndefined();
  expect(checkWording(5)).toBe(5);
});

it('translates the sentence in both shapes, with and without the reference', () => {
  const french = 'L’absence de signalement ne doit pas être interprétée comme une absence de risque';
  const withPartial = translateText(`${WITH}${TAIL}.`, 'fr');
  expect(withPartial).toMatch(/^Catégories de dangers non évaluées : .+\. Couverture partielle des capacités : .+\. /);
  expect(withPartial).toMatch(new RegExp(`${french}\\.$`));
  const without = translateText(`${WITHOUT}${TAIL}.`, 'fr');
  expect(without).toMatch(new RegExp(`^Catégories de dangers non évaluées : .+\\. ${french}\\.$`));
  for (const text of [withPartial, without]) expect(text).not.toMatch(/§|brief/);
  // the frozen wording still translates, reference included
  expect(translateText(`${WITHOUT}${TAIL} (brief §5).`, 'fr')).toMatch(/\(briefing §5\)\.$/);
});
