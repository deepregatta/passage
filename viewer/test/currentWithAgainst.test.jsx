import { render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CURRENT_ALONG_TRACK_THRESHOLD_KT, routeSummary } from '@deepweather/engine';
import CurrentSummary from '../src/pages/briefing/CurrentSummary.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
// A check saved by the engine before checks recorded the current grid's time step (never regenerated).
import legacyFindings from '../../engine/test/fixtures/legacy-current-snapshot/findings.json';
import legacyRoute from '../../engine/test/fixtures/legacy-current-snapshot/route.json';

const HOUR = 3_600_000;
const FORBIDDEN_EN = /tidal|tide|fair|foul|favourable|\bGO\b|best|probabilit|chance|likel|odds|%/i;
const FORBIDDEN_FR = /de marée|marée|favorable|défavorable|meilleur|probabilit|chance|probable|%/i;
const IBI_HOURLY = { source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run_id: 'cmems-ibi-20260719T19Z', current_source: 'prepared', time_step_h: 1 };
const GLO12_TILES = { source: 'tiles', layer: 'currents', model: 'cmems_glo12 tiles (currents-20260720T00Z)', run_id: 'currents-20260720T00Z', mode: 'live', current_source: 'tiles', time_step_h: 6 };

// An along-track current turning through the hours (a made-up test signal, not a tide model): from +1.4 to -1.1 kt.
const alongAt = (t) => Math.round((1.25 * Math.sin((2 * Math.PI * t) / (12.4 * HOUR)) + 0.15) * 100) / 100;

/** The demo passage's saved findings with a current at every audited hour (some missing) and the given records. */
function withCurrent(records, { missing = [] } = {}) {
  const findings = structuredClone(savedFindings);
  findings.inputs.forecast_tiles = [...findings.inputs.forecast_tiles.filter((item) => item.layer !== 'currents'), ...records];
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      const t = Date.parse(hour.valid_time);
      hour.current = missing.includes(hour.valid_time) ? null : {
        u_kt: alongAt(t), v_kt: 0.4, speed_kt: Math.round(Math.hypot(alongAt(t), 0.4) * 100) / 100, set_deg: 120,
        along_kt: alongAt(t), cross_kt: 0.4, wind_against_current: false,
      };
    }
  }
  return findings;
}

/** Independent count: each whole hour of the expected timing, by the signal above, without the engine. */
function independentCount(findings, missing = []) {
  const start = Date.parse(findings.legs[0].enter_range.nominal);
  const end = Date.parse(findings.legs.at(-1).eta_range.nominal);
  const count = { with: 0, against: 0, weak: 0, missing: 0, hours: 0 };
  for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) {
    count.hours += 1;
    if (missing.includes(new Date(t).toISOString().replace('.000Z', 'Z'))) count.missing += 1;
    else if (alongAt(t) > 0.5) count.with += 1;
    else if (alongAt(t) < -0.5) count.against += 1;
    else count.weak += 1;
  }
  return count;
}

const lineTexts = (container) => [...container.querySelectorAll('[data-testid="current-summary"] [data-line]')].map((node) => node.textContent);
const view = (findings, route = null) => render(<CurrentSummary findings={findings} route={route} />).container;
const LINE = /^On the expected timing, at each leg’s midpoint: /;
const englishLine = (c) => `On the expected timing, at each leg’s midpoint: ${c.with} h with the current · ${c.against} h against · ${c.weak} h across or weak (0.5 kt or less along the track)`;
const frenchLine = (c) => `Selon l’horaire prévu, au milieu de chaque tronçon\u00A0: ${c.with} h avec le courant · ${c.against} h contre · ${c.weak} h de travers ou faible (0,5 nd ou moins dans l’axe de la route)`;

it('shows hours with and against the current for an hourly grid of a product that includes tide, with numbers that add up', () => {
  const missing = ['2026-07-20T08:00:00Z'];
  const findings = withCurrent([IBI_HOURLY], { missing });
  const expected = independentCount(findings, missing);
  // not trivial: every kind occurs, and the hours are the C2 hours
  expect(expected.with).toBeGreaterThan(0);
  expect(expected.against).toBeGreaterThan(0);
  expect(expected.weak).toBeGreaterThan(0);
  expect(expected.missing).toBe(1);
  expect(expected.hours).toBe(routeSummary(findings).total_hours);
  expect(CURRENT_ALONG_TRACK_THRESHOLD_KT).toBe(0.5);
  const texts = lineTexts(view(findings));
  const line = texts.find((text) => LINE.test(text));
  expect(line).toBe(englishLine(expected));
  // the missing hour is stated right after, never folded into "across or weak"
  expect(texts[texts.indexOf(line) + 1]).toBe('No current value for 1 h of the passage.');
  expect(expected.with + expected.against + expected.weak + expected.missing).toBe(expected.hours);
  expect(line).not.toMatch(FORBIDDEN_EN);
});

it('leaves the block exactly as before for any other source: no step, a coarse step, tiles, unrecorded tide, two records', () => {
  const { time_step_h: _step, ...older } = IBI_HOURLY;
  const before = lineTexts(view(withCurrent([older])));
  expect(before.some((text) => LINE.test(text))).toBe(false);
  const shown = lineTexts(view(withCurrent([IBI_HOURLY])));
  // the hourly record differs from the older record by exactly one line
  expect(shown.filter((text) => !LINE.test(text))).toEqual(before);
  expect(shown.length).toBe(before.length + 1);
  for (const records of [
    [{ ...IBI_HOURLY, time_step_h: 3 }],
    [{ ...IBI_HOURLY, time_step_h: null }],
    [GLO12_TILES],
    [{ ...GLO12_TILES, time_step_h: 1 }],
    [{ ...IBI_HOURLY, model: 'cmems_ibi tiles (currents-ibi-20260720T00Z)', source: 'tiles', current_source: 'tiles' }],
    [{ ...IBI_HOURLY, model: 'cmems_mod_nws_phy-cur_anfc_0.027deg-2D_PT1H-m' }],
    [{ ...IBI_HOURLY, model: 'cmems' }],
    [IBI_HOURLY, GLO12_TILES],
  ]) {
    const texts = lineTexts(view(withCurrent(records)));
    expect(texts.some((text) => LINE.test(text)), JSON.stringify(records)).toBe(false);
  }
});

it('a passage saved before checks recorded the time step opens with the block it had: every figure, no with/against line', () => {
  expect(legacyFindings.inputs.forecast_tiles.find((item) => item.layer === 'currents')).not.toHaveProperty('time_step_h');
  const texts = lineTexts(view(structuredClone(legacyFindings), structuredClone(legacyRoute)));
  expect(texts).toEqual([
    'The model current at the points checked along your passage, on the expected timing.',
    // by hand from the fixture's samples: L1 -1.06 nm, L2 +0.69 nm
    'Distance lost to the current: 0.4 nm',
    'An estimate from one current value per leg, at its midpoint, over the leg’s expected time.',
    expect.stringMatching(/^Strongest current at the points checked, anywhere in your arrival range: 1\.4 kt at the midpoint of leg 1 around /),
    'Regional model currents including tide.',
    'Not an official tidal-stream prediction.',
  ]);
  // the same check recorded today: the same block and one more line. By hand, the expected-timing hours
  // 06:00 and 07:00 (leg 1: -1.15, -0.56 kt) are against, 08:00 (leg 2: 0.16 kt) weak, 09:00 (0.86 kt) with.
  const today = structuredClone(legacyFindings);
  today.inputs.forecast_tiles.find((item) => item.layer === 'currents').time_step_h = 1;
  const recorded = lineTexts(view(today, structuredClone(legacyRoute)));
  expect(recorded.filter((text) => !LINE.test(text))).toEqual(texts);
  expect(recorded.find((text) => LINE.test(text))).toBe(englishLine({ with: 1, against: 2, weak: 1 }));
});

it('emulated values keep the heading stamp and get no with/against line and no credit line', () => {
  for (const emulated of [
    { ...IBI_HOURLY, mode: 'synthetic', source_kind: 'emulated' },
    { ...IBI_HOURLY, source_kind: 'emulated' },
    { ...IBI_HOURLY, source: 'synthetic' },
  ]) {
    const container = view(withCurrent([emulated]));
    expect(container.querySelector('[data-testid="current-summary"]'), JSON.stringify(emulated)).not.toBeNull();
    expect(lineTexts(container).some((text) => LINE.test(text)), JSON.stringify(emulated)).toBe(false);
    expect(container.querySelector('[data-testid="current-summary"] h3 .stamp-emulated')).not.toBeNull();
    expect(container.querySelector('[data-testid="current-credit"]')).toBeNull();
  }
  // a scenario model names no product: no line
  expect(lineTexts(view(withCurrent([{ ...IBI_HOURLY, model: 'scenario', mode: 'synthetic' }]))).some((text) => LINE.test(text))).toBe(false);
});

it('writes the line in French on the real French path, as a whole line', async () => {
  const missing = ['2026-07-20T08:00:00Z'];
  const findings = withCurrent([IBI_HOURLY], { missing });
  const expected = independentCount(findings, missing);
  const en = render(<CurrentSummary findings={structuredClone(findings)} />);
  const english = lineTexts(en.container);
  en.unmount();
  const { container } = render(<div id="root"><CurrentSummary findings={findings} /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.querySelector('h3').textContent).toContain('Courant le long de votre route'));
  const texts = lineTexts(container);
  const index = english.findIndex((text) => LINE.test(text));
  expect(texts[index]).toBe(frenchLine(expected));
  expect(texts[index + 1]).toBe('Aucune valeur de courant pour 1 h de la traversée.');
  expect(texts).toEqual(english.map((text) => translateText(text, 'fr')));
  expect(texts[index]).not.toMatch(FORBIDDEN_FR);
  expect(container.textContent).not.toMatch(/\bkt\b|\bnm\b|with the current|across or weak/);
});

it('translates the composed line by its anchored pattern for any counts, and leaves a changed line in English rather than half-translated', () => {
  for (const c of [{ with: 0, against: 0, weak: 0 }, { with: 12, against: 7, weak: 103 }]) {
    expect(translateText(englishLine(c), 'fr')).toBe(frenchLine(c));
  }
  // a line the pattern does not match is not partly translated into French
  const changed = 'On the expected timing, at each leg’s midpoint: 3 h with the current · 2 h against';
  expect(translateText(changed, 'fr')).not.toMatch(/avec le courant|contre/);
});
