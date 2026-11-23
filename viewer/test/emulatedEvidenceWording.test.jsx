import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { checkWording } from '../src/pages/briefing/checkWording.js';
import savedFindings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';
import savedBriefing from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/briefing.json';
import savedRoute from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/route.json';

// The engine writes this sentence into every check with emulated evidence, and saved checks and
// goldens keep it. The page shows it in the current wording ("check", not "snapshot").

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));

const FROZEN = 'Emulated evidence entries: E23. Provider modes are recorded in the snapshot inputs.';
const EN = 'Emulated evidence entries: E23. Provider modes are recorded with this check.';
const FR = 'Entrées probantes simulées : E23. Les modes des fournisseurs sont consignés avec cette vérification.';

beforeEach(() => {
  const briefing = structuredClone(savedBriefing);
  expect(briefing.sections.find((section) => section.id === 'emulated_disclosure').register_pro).toBe(FROZEN);
  useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(savedFindings), briefing,
    route: structuredClone(savedRoute), page: 'briefing' }, true);
  usePlanner.setState(usePlanner.getInitialState(), true);
  usePlayback.setState(usePlayback.getInitialState(), true);
});
afterEach(() => { cleanup(); useApp.setState(useApp.getInitialState(), true); });

const professionalRegister = () => {
  fireEvent.click(screen.getByRole('button', { name: /Why this assessment|Pourquoi cette évaluation/ }));
  return screen.getByText(/^(Professional register|Registre professionnel)$/).closest('details');
};

it('shows the emulated-evidence sentence of a saved check as "check" in English, saved text untouched', () => {
  render(<div id="root"><Briefing /></div>);
  expect(professionalRegister()).toHaveTextContent(EN);
  expect(document.body.textContent).not.toMatch(/snapshot inputs/);
  expect(useApp.getState().briefing.sections.find((section) => section.id === 'emulated_disclosure').register_pro).toBe(FROZEN);
});

it('shows it as "vérification" in French', async () => {
  useApp.setState({ language: 'fr' });
  render(<div id="root"><Briefing /><LocalizedDocument language="fr" /></div>);
  const register = professionalRegister();
  await waitFor(() => expect(register.textContent).toContain(FR));
  expect(document.body.textContent).not.toMatch(/snapshot inputs|données d’entrée/);
});

it('rewrites only the whole sentence, keeps any evidence ids, and leaves other text alone', () => {
  expect(checkWording(FROZEN)).toBe(EN);
  expect(checkWording('Emulated evidence entries: E1, E2, E30. Provider modes are recorded in the snapshot inputs.'))
    .toBe('Emulated evidence entries: E1, E2, E30. Provider modes are recorded with this check.');
  expect(checkWording(`${FROZEN} More.`)).toBe(`${FROZEN} More.`);
  expect(checkWording('Provider modes are recorded in the snapshot inputs.')).toBe('Provider modes are recorded in the snapshot inputs.');
  expect(checkWording(EN)).toBe(EN);
});
