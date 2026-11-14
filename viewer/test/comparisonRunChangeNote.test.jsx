// The fixed caption under the comparison's results: a verdict near a limit can change on the next forecast run.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DepartureComparison from '../src/pages/planner/DepartureComparison.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { LocalizedDocument } from '../src/i18n.js';

const EN = 'Verdicts close to a limit often change when the next forecast run arrives; a time well inside your limits rarely does. Check again after the next run.';
const FR = 'Les verdicts proches d’une limite changent souvent à l’arrivée du prochain cycle du modèle ; une heure de départ bien à l’intérieur de vos limites change rarement. Vérifiez à nouveau après le prochain cycle.';
const START = Date.parse('2026-11-13T18:00:00Z');
const at = (h) => new Date(START + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cand = (h, verdict) => ({
  departure_utc: at(h), verdict, worst_ratio: 0.5, max_fraction: null, ensemble_covered: false, max_members: null, driver_summary: null,
  passage_h: null, arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0,
});
const SCAN = { candidates: [cand(0, 'within'), cand(6, 'approaching'), cand(12, 'exceeds')], best_index: 0, skipped: [], rerouted: false };
const REFINED = { ...SCAN, candidates: [...SCAN.candidates, cand(14, 'within')], refined: { departures: [at(14)] } };
const ROUTED = { ...SCAN, rerouted: true };

const props = { departureLocal: '2026-11-13T19:00', busy: null, disabled: false, onPick: () => {} };
const note = (container) => container.querySelector('[data-testid="comparison-run-change-note"]');

beforeEach(() => { usePlanner.getState().reset(); });
afterEach(cleanup);

describe('comparison run-change note', () => {
  it.each([['same-route', SCAN], ['computed-route', ROUTED], ['refined', REFINED]])('shows the English sentence once for a %s comparison', (_name, scan) => {
    const { container } = render(<DepartureComparison scan={scan} {...props} />);
    expect(container.querySelectorAll('[data-testid="comparison-run-change-note"]')).toHaveLength(1);
    expect(note(container).textContent).toBe(EN);
  });

  it('is absent while something is running', () => {
    const { container } = render(<DepartureComparison scan={SCAN} {...props} busy="scanning departures 3/21" />);
    expect(note(container)).toBeNull();
  });

  it('is absent when no departure was assessed', () => {
    const { container } = render(<DepartureComparison scan={{ ...SCAN, candidates: [], skipped: [{ departure_utc: at(0), reason: 'x' }], requested: 1 }} {...props} />);
    expect(note(container)).toBeNull();
  });

  it('reads in French on the French page', () => {
    const { container } = render(<div id="root"><DepartureComparison scan={SCAN} {...props} /><LocalizedDocument language="fr" /></div>);
    expect(note(container).textContent).toBe(FR);
  });
});
