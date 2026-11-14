// The comparison's near-line mark: a cell whose worst reading decides its verdict and sits close to a verdict line
// (engine `near_verdict_line`) shows a small sign, one more tooltip sentence and a legend entry; nothing else changes.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import DepartureComparison from '../src/pages/planner/DepartureComparison.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { LocalizedDocument, translateText } from '../src/i18n.js';

const H = 3600_000;
const START = Date.parse('2026-11-13T18:00:00Z');
const at = (h) => new Date(START + h * H).toISOString().replace(/\.\d{3}Z$/, 'Z');
const base = {
  worst_ratio: null, max_fraction: null, ensemble_covered: false, max_members: null, driver_summary: null,
  passage_h: 12, arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0,
};
const cand = (h, extra) => ({ ...base, departure_utc: at(h), ...extra });
const SENTENCE = 'The worst reading here is close to the line between two verdicts, so this verdict often changes on the next forecast run.';
const SENTENCE_FR = 'La pire valeur prévue ici est proche de la frontière entre deux verdicts, donc ce verdict change souvent au prochain cycle du modèle.';
const LEGEND = 'close to the line between two verdicts';
const LEGEND_FR = 'proche de la frontière entre deux verdicts';

// A marked cell can carry the other signs too: the third one also misses forecast values.
const MARKED = [
  cand(0, { verdict: 'within', worst_reading_ratio: 0.5, near_verdict_line: false }),
  cand(6, { verdict: 'within', worst_reading_ratio: 0.7, near_verdict_line: true, arrival_hours_no_data: 0, delta: { peak_gust_kt: 3 } }),
  cand(12, { verdict: 'approaching', worst_reading_ratio: 0.95, near_verdict_line: true, arrival_hours_approaching: 3, arrival_hours_no_data: 2 }),
  cand(18, { verdict: 'exceeds', worst_reading_ratio: 1.4, near_verdict_line: false, arrival_hours_over_limit: 4 }),
];
const props = { departureLocal: '2026-11-13T19:00', busy: null, disabled: false, onPick: () => {} };
const show = (candidates, extra) => render(<DepartureComparison scan={{ candidates, best_index: 0, skipped: [] }} {...props} />, extra);
const cellsOf = (container) => [...container.querySelectorAll('button[title]')];

beforeEach(() => { usePlanner.getState().reset(); });
afterEach(cleanup);

it('shows the sign and the tooltip sentence on a marked cell only, without changing its size or colour', () => {
  const { container } = show(MARKED);
  const cells = cellsOf(container);
  const unmarked = show(MARKED.map(({ near_verdict_line: _n, ...c }) => c)).container;
  const plainCells = cellsOf(unmarked);
  cells.forEach((cell, i) => {
    const mark = cell.querySelector('[data-testid="near-line-mark"]');
    expect(Boolean(mark), cell.title).toBe(MARKED[i].near_verdict_line);
    expect(cell.title.includes(SENTENCE)).toBe(MARKED[i].near_verdict_line);
    // the verdict colour and the cell's classes (and so its size) are those of the cell without the mark
    expect(cell.style.backgroundColor).toBe(plainCells[i].style.backgroundColor);
    expect(cell.className).toBe(plainCells[i].className);
    if (mark) {
      expect(mark).toHaveTextContent('±');
      expect(mark).toHaveAttribute('aria-hidden');
      expect(mark).toHaveClass('absolute'); // out of the flow: it cannot push the other signs or grow the cell
      expect(cell.title.endsWith(` · ${SENTENCE}`)).toBe(true);
    }
  });
  // a marked cell keeps its other signs: the missing-values mark is still there
  expect(cells[2].querySelector('[data-testid="missing-values-mark"]')).toHaveTextContent('?');
});

it('adds the legend entry only when a cell is marked', () => {
  expect(show(MARKED).getByTestId('near-line-legend')).toHaveTextContent(`±${LEGEND}`);
  cleanup();
  const none = show(MARKED.map((c) => ({ ...c, near_verdict_line: false })));
  expect(none.queryByTestId('near-line-legend')).toBeNull();
  expect(none.queryByText(LEGEND)).toBeNull();
  expect(none.container.querySelector('[data-testid="near-line-mark"]')).toBeNull();
});

it('renders a scan without the new fields exactly as one with every mark off', () => {
  const old = MARKED.map(({ near_verdict_line: _n, worst_reading_ratio: _r, ...c }) => c);
  const before = show(old).container.innerHTML;
  cleanup();
  const off = show(MARKED.map((c) => ({ ...c, near_verdict_line: false }))).container.innerHTML;
  expect(before).toBe(off);
  expect(before).not.toContain('near-line');
  expect(before).not.toContain(SENTENCE);
  // the fixed caption stays as it is, marked or not
  cleanup();
  const caption = show(old).getByTestId('comparison-run-change-note').textContent;
  cleanup();
  expect(show(MARKED).getByTestId('comparison-run-change-note').textContent).toBe(caption);
});

it('translates the sentence and the legend into French', () => {
  expect(translateText(SENTENCE, 'fr')).toBe(SENTENCE_FR);
  expect(translateText(LEGEND, 'fr')).toBe(LEGEND_FR);
  expect(translateText(SENTENCE, 'en')).toBe(SENTENCE);
  const { container } = show(MARKED);
  const titles = cellsOf(container).map((cell) => translateText(cell.title, 'fr'));
  expect(titles[1].endsWith(` · ${SENTENCE_FR}`)).toBe(true);
  expect(titles[2].endsWith(` · ${SENTENCE_FR}`)).toBe(true);
  for (const title of titles) expect(title).not.toMatch(/worst reading|between two verdicts|forecast run/);
  cleanup();
  const page = render(<div id="root"><DepartureComparison scan={{ candidates: MARKED, best_index: 0, skipped: [] }} {...props} /><LocalizedDocument language="fr" /></div>);
  expect(page.container).toHaveTextContent(LEGEND_FR);
  expect(page.container).not.toHaveTextContent(LEGEND);
});

it('shows both signs on a cell that is tied and near a line, and each legend entry once', () => {
  // two identical "within" times: the second is effectively tied with the first, and both are near a line
  const both = [
    cand(0, { verdict: 'within', worst_reading_ratio: 0.7, near_verdict_line: true }),
    cand(6, { verdict: 'within', worst_reading_ratio: 0.7, near_verdict_line: true }),
  ];
  const view = show(both);
  const tied = cellsOf(view.container)[1];
  expect(tied.title).toContain('effectively tied with the least-exposure time');
  expect(tied.querySelector('[data-testid="near-line-mark"]')).toHaveTextContent('±');
  const glyphs = [...tied.querySelectorAll('span[aria-hidden]')].find((s) => s.textContent.includes('≈'));
  expect(glyphs.textContent).toContain('≈');
  expect(glyphs.textContent).not.toContain('±');
  expect(view.getAllByText('effectively tied with the least exposure')).toHaveLength(1);
  expect(view.getAllByText(LEGEND)).toHaveLength(1);
  expect(view.getByTestId('near-line-legend')).toHaveTextContent(`±${LEGEND}`);
});
