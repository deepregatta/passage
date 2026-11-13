// The departure grid's tooltip is one composed English title; the French page must translate every part of it.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import DepartureComparison from '../src/pages/planner/DepartureComparison.jsx';
import { BUSY_BUTTON_LABEL, STOP_REFINE_LABEL, STOP_SCAN_LABEL, refineAddsText, refinedText } from '../src/pages/planner/plannerFeedback.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { localTimeZoneName } from '../src/lib/format.js';
import { translateText } from '../src/i18n.js';

const H = 3600_000;
const START = Date.parse('2026-11-13T18:00:00Z');
const at = (h) => new Date(START + h * H).toISOString().replace(/\.\d{3}Z$/, 'Z');
const base = {
  worst_ratio: 0.5, max_fraction: null, ensemble_covered: false, max_members: null, driver_summary: null,
  passage_h: null, arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0,
};
const cand = (h, extra) => ({ ...base, departure_utc: at(h), ...extra });
const tz = localTimeZoneName();

const CANDIDATES = [
  cand(0, { verdict: 'within', passage_h: 12.6 }),
  cand(6, { verdict: 'approaching', arrival_hours_approaching: 3, passage_h: 13 }),
  cand(12, { verdict: 'exceeds', arrival_hours_over_limit: 6, expected_hours_over_limit: 2, passage_h: 13 }),
  cand(18, { verdict: 'exceeds', arrival_hours_over_limit: 5, expected_hours_over_limit: 0, arrival_hours_approaching: 2, max_members: { exceed: 7, total: 31 } }),
  cand(24, { verdict: 'insufficient', arrival_hours_no_data: 4 }),
  cand(30, { verdict: 'warning_active', max_members: { exceed: 0, total: 31 }, arrival_hours_over_limit: 1, expected_hours_over_limit: 1 }),
  cand(36, { verdict: 'within', max_members: { exceed: 1, total: 31 }, delta: { peak_gust_kt: -4.2 }, passage_h: 9 }),
  cand(38, { verdict: 'approaching', delta: { peak_gust_kt: 6.4 }, passage_h: 9, max_members: { exceed: 2, total: 31 } }),
  cand(42, { verdict: 'within', passage_h: 2 }),
  // a cell can end right after its verdict
  ...['within', 'approaching', 'exceeds', 'insufficient', 'warning_active'].map((verdict, i) => cand(48 + 6 * i, { verdict })),
];
const SCAN = { candidates: CANDIDATES, best_index: 0, skipped: [], refined: { departures: [at(38)] }, rerouted: true };

// English words that must not survive in a French tooltip ("passage" alone is French for a crossing, so only the English phrasings are guarded).
const LEAK = /local time|\bwithin\b|\bapproaching\b|\bexceeds?\b|\bh passage\b|\blimits\b|\bover a limit\b|\bscenarios\b|\badded by\b|\bvs first\b|\bof which\b|\bdisagree\b|\bofficial warning\b|\bforecast\b|\bexpected timing\b|\bmissing\b|\barrival range\b/i;

beforeEach(() => { usePlanner.getState().reset(); });
afterEach(cleanup);

const tooltips = () => {
  const { container } = render(<DepartureComparison scan={SCAN} departureLocal="2026-11-13T19:00" busy={null} disabled={false} onPick={() => {}} />);
  return [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
};
const rest = (title) => title.slice(title.indexOf(`(${tz}) · `) + `(${tz}) · `.length);
const TIE_EN = 'effectively tied with the least-exposure time';
const TIE_FR = 'à égalité effective avec l’heure la moins exposée';
const NEAR = 'dans votre fenêtre d’arrivée estimée';

it('keeps the English tooltips as they are', () => {
  const titles = tooltips();
  expect(titles).toHaveLength(CANDIDATES.length);
  expect(titles.map(rest)).toContain('within limits · ≈13 h passage');
  expect(titles.every((t) => t.includes(` local time (${tz}) · `))).toBe(true);
});

it('translates every part of every grid tooltip into French, whole string', () => {
  const FR = {
    'within limits · ≈13 h passage': 'dans les limites · ≈13 h de traversée',
    'approaching · ≈13 h passage · 3 h approaching a limit in your arrival range': `proche des limites · ≈13 h de traversée · 3 h à l’approche d’une limite ${NEAR}`,
    'exceeds · ≈13 h passage · 6 h over a limit in your arrival range · of which 2 h on the expected timing':
      `dépassement · ≈13 h de traversée · 6 h au-dessus d’une limite ${NEAR} · dont 2 h selon l’horaire prévu`,
    'exceeds · 5 h over a limit in your arrival range · none on the expected timing · 2 h approaching a limit in your arrival range · 7 of 31 forecast scenarios exceed a limit':
      `dépassement · 5 h au-dessus d’une limite ${NEAR} · aucune selon l’horaire prévu · 2 h à l’approche d’une limite ${NEAR} · 7 scénarios sur 31 dépassent une limite`,
    'models disagree · a forecast value needed for your limits is missing for 4 h of your arrival range':
      'divergence des modèles · il manque une valeur de prévision nécessaire à vos limites pendant 4 h de votre fenêtre d’arrivée estimée',
    'official warning · 1 h over a limit in your arrival range · 0 of 31 forecast scenarios exceed a limit':
      `alerte officielle · 1 h au-dessus d’une limite ${NEAR} · 0 scénario sur 31 dépasse une limite`,
    'within limits · ≈9 h passage · 1 of 31 forecast scenarios exceed a limit · gusts -4 kt vs first option':
      'dans les limites · ≈9 h de traversée · 1 scénario sur 31 dépasse une limite · rafales -4 nd par rapport à la première option',
    'approaching · added by refining · ≈9 h passage · 2 of 31 forecast scenarios exceed a limit · gusts +6 kt vs first option':
      'proche des limites · ajoutée par l’affinage · ≈9 h de traversée · 2 scénarios sur 31 dépassent une limite · rafales +6 nd par rapport à la première option',
    'within limits · ≈2 h passage': 'dans les limites · ≈2 h de traversée',
    'within limits': 'dans les limites',
    approaching: 'proche des limites',
    exceeds: 'dépassement',
    'models disagree': 'divergence des modèles',
    'official warning': 'alerte officielle',
  };
  const seen = new Set();
  for (const title of tooltips()) {
    // a time the ranking ties with the least-exposure time carries one more part, ahead of the gust delta
    const tied = title.includes(` · ${TIE_EN}`);
    const key = rest(title).replace(` · ${TIE_EN}`, '');
    expect(Object.keys(FR), title).toContain(key);
    seen.add(key);
    const parts = FR[key].split(' · ');
    if (tied) parts.splice(parts.findIndex((p) => p.startsWith('rafales')) === -1 ? parts.length : parts.findIndex((p) => p.startsWith('rafales')), 0, TIE_FR);
    const fr = translateText(title, 'fr');
    expect(fr.endsWith(` · ${parts.join(' · ')}`), fr).toBe(true);
    expect(fr).toContain(` heure locale (${tz}) · `);
    expect(fr).not.toMatch(LEAK);
  }
  expect(seen.size).toBe(Object.keys(FR).length);
});

it('leaves no English in the rest of the comparison on the French page', () => {
  const { container } = render(
    <DepartureComparison scan={{ ...SCAN, skipped: [{ departure_utc: at(80), reason: 'x' }] }} departureLocal="2026-11-13T19:00" busy={null} disabled={false} onPick={() => {}} />,
  );
  const strings = [
    refineAddsText(4), refineAddsText(1, true), refinedText(0), refinedText(1), refinedText(4),
    ...Object.values(BUSY_BUTTON_LABEL), STOP_REFINE_LABEL, STOP_SCAN_LABEL,
  ];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) strings.push(n.data);
  for (const el of container.querySelectorAll('[aria-label],[title]')) {
    if (el.matches('button[title]')) continue; // the grid cells are checked above
    strings.push(el.getAttribute('aria-label') ?? el.getAttribute('title'));
  }
  // Every sentence with words must change; what stays is a time, a zone or a glyph.
  const untouched = strings.filter((s) => /[A-Za-z]{3,}/.test(s.replace(tz, '').replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, '')) && translateText(s, 'fr') === s);
  expect(untouched).toEqual([]);
  expect(strings.map((s) => translateText(s, 'fr')).filter((s) => LEAK.test(s))).toEqual([]);
});
