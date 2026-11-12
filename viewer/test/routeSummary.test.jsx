import { render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import RouteSummary from '../src/pages/briefing/RouteSummary.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { routeSummaryLines } from '../src/lib/routeSummaryLines.js';
import compatibilityFindings from './fixtures/compatibility/20260720T060000Z_44d2cd5f_4196266b/findings.json';
import goldenFindings from '../../engine/test/golden/findings-cherbourg-plymouth.json';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

const HOUR = 3_600_000;
const FORBIDDEN_EN = /probabilit|chance|likel|odds|%|tidal|deepweather/i;
const FORBIDDEN_FR = /probabilit|chance|probable|cote|%|marée|deepweather/i;

/** Independent reading of the fixture: each whole UTC hour of the nominal passage, read from the leg whose nominal window holds it. */
function expectedFromFixture() {
  const legs = savedFindings.legs;
  const start = Date.parse(legs[0].enter_range.nominal);
  const end = Date.parse(legs.at(-1).eta_range.nominal);
  const sail = { upwind: 0, reach: 0, downwind: 0 };
  const wind = [0, 0, 0, 0, 0];
  for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) {
    const leg = legs.find((l) => t >= Date.parse(l.enter_range.nominal) && t < Date.parse(l.eta_range.nominal));
    const hr = leg.hours.find((h) => Date.parse(h.valid_time) === t);
    sail[hr.point_of_sail] += 1;
    wind[[10, 15, 20, 25].filter((edge) => hr.wind_kt >= edge).length] += 1;
  }
  return { sail, wind };
}

const LABELS = { en: { sail: ['Upwind', 'Reaching', 'Downwind'], wind: ['Under 10 kt', '10–15 kt', '15–20 kt', '20–25 kt', '25 kt and over'] } };

function expectedLines() {
  const { sail, wind } = expectedFromFixture();
  const join = (labels, counts) => labels.map((label, i) => [label, counts[i]]).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n} h`).join(' · ');
  return {
    sail: `Point of sail: ${join(LABELS.en.sail, [sail.upwind, sail.reach, sail.downwind])}`,
    wind: `Wind: ${join(LABELS.en.wind, wind)}`,
    sailCounts: sail,
    windCounts: wind,
  };
}

const lineTexts = (container) => [...container.querySelectorAll('[data-testid="route-summary"] p')].map((p) => p.textContent);

it('shows the two breakdowns from the saved findings alone, with the numbers of an independent reading', () => {
  const expected = expectedLines();
  const { container } = render(<RouteSummary findings={structuredClone(savedFindings)} />);
  expect(container.querySelector('h3').textContent).toContain('Hours by point of sail and wind');
  expect(lineTexts(container)).toEqual([
    'Hours of your passage at the forecast wind, on the expected timing.',
    expected.sail,
    expected.wind,
  ]);
  // the demo passage really has several buckets, so the check above is not trivial
  expect(Object.values(expected.sailCounts).filter((n) => n > 0).length).toBeGreaterThan(1);
  expect(expected.windCounts.filter((n) => n > 0).length).toBeGreaterThan(1);
  expect(container.textContent).not.toMatch(FORBIDDEN_EN);
});

it('carries the EMULATED stamp for the demo passage, whose forecast is an emulated scenario', () => {
  const { container } = render(<RouteSummary findings={structuredClone(savedFindings)} />);
  expect(container.querySelector('[data-testid="route-summary"] .stamp-emulated')).not.toBeNull();
});

it('drops the stamp for a named real forecast', () => {
  const findings = structuredClone(savedFindings);
  for (const layer of findings.inputs.forecast_tiles) layer.model = 'gfs';
  const { container } = render(<RouteSummary findings={findings} />);
  expect(container.querySelector('.stamp-emulated')).toBeNull();
  expect(lineTexts(container)).toHaveLength(3);
});

const stamped = (findings) => render(<RouteSummary findings={findings} />).container.querySelector('.stamp-emulated') !== null;
const clone = (findings) => structuredClone(findings);

it('stamps from the wind forecast\'s recorded provenance: tile layer first', () => {
  expect(stamped(clone(savedFindings))).toBe(true);
  expect(stamped(clone(goldenFindings))).toBe(true);
  // a named real weather layer is not stamped, whatever else in the check is emulated (the demo's warning evidence is)
  const real = clone(savedFindings);
  real.inputs.forecast_tiles.find((layer) => layer.layer === 'weather').model = 'gfs';
  expect(real.evidence.some((item) => item.source_kind === 'emulated')).toBe(true);
  expect(stamped(real)).toBe(false);
});

it('does not stamp an older check whose wind forecast was real, though its synthetic warning is emulated', () => {
  expect(compatibilityFindings.inputs.forecast_tiles).toBeUndefined();
  expect(compatibilityFindings.inputs.openmeteo.find((item) => item.api === 'forecast').model).toBe('ecmwf_ifs025');
  expect(compatibilityFindings.evidence.find((item) => item.rule_id === 'A-WARN-01').source_kind).toBe('emulated');
  expect(stamped(clone(compatibilityFindings))).toBe(false);
});

it('stamps an older check whose recorded wind forecast is a scenario', () => {
  const legacy = clone(compatibilityFindings);
  legacy.inputs.openmeteo.find((item) => item.api === 'forecast').model = 'scenario';
  expect(stamped(legacy)).toBe(true);
});

it('falls through to the wind-rule evidence only when no source names the wind forecast', () => {
  const bare = clone(compatibilityFindings);
  delete bare.inputs.openmeteo;
  expect(stamped(bare)).toBe(false); // only the warning is emulated
  const windEvidence = bare.evidence.find((item) => item.rule_id === 'W-SUST-01');
  windEvidence.source_kind = 'emulated';
  expect(stamped(bare)).toBe(true);
});

it('treats forecast_tiles without a weather layer as unknown and falls through', () => {
  const noWeather = clone(compatibilityFindings);
  noWeather.inputs.forecast_tiles = [{ layer: 'waves', model: 'scenario', source: 'fixture' }];
  expect(stamped(noWeather)).toBe(false); // the waves layer says nothing about the wind; legacy wind is real
  delete noWeather.inputs.openmeteo;
  expect(stamped(noWeather)).toBe(false);
  noWeather.evidence.find((item) => item.rule_id === 'W-GUST-01').source_kind = 'emulated';
  expect(stamped(noWeather)).toBe(true);
});

it('leaves out zero buckets and keeps hours with no wind value or point of sail as "Not available"', () => {
  const lines = routeSummaryLines({
    total_hours: 9,
    by_point_of_sail: { upwind: 0, reach: 6, downwind: 1, unknown: 2 },
    by_wind_band: { under_10: 0, from_10_to_15: 7, from_15_to_20: 0, from_20_to_25: 0, from_25_up: 0, unknown: 2 },
  });
  expect(lines.map((l) => l.text)).toEqual([
    'Point of sail: Reaching 6 h · Downwind 1 h · Not available 2 h',
    'Wind: 10–15 kt 7 h · Not available 2 h',
  ]);
});

it('renders nothing when the findings have no usable hours', () => {
  const none = structuredClone(savedFindings);
  for (const leg of none.legs) leg.hours = [];
  expect(render(<RouteSummary findings={none} />).container.innerHTML).toBe('');
  expect(render(<RouteSummary findings={{ ...savedFindings, legs: [] }} />).container.innerHTML).toBe('');
  expect(routeSummaryLines(null)).toEqual([]);
});

it('writes the same block in French, with nd for knots', async () => {
  const expected = expectedLines();
  const { container } = render(<div id="root"><RouteSummary findings={structuredClone(savedFindings)} /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.querySelector('h3').textContent).toContain('Heures par allure et par vent'));
  const fr = { Upwind: 'Au près', Reaching: 'Au travers', Downwind: 'Au portant', 'Under 10 kt': 'Moins de 10 nd', '10–15 kt': '10–15 nd', '15–20 kt': '15–20 nd', '20–25 kt': '20–25 nd', '25 kt and over': '25 nd et plus' };
  const translate = (text, head, frHead) => `${frHead}\u00A0: ${text.slice(head.length + 2).split(' · ').map((item) => {
    const [, label, n] = /^(.+) (\d+) h$/.exec(item);
    return `${fr[label]} ${n} h`;
  }).join(' · ')}`;
  expect(lineTexts(container)).toEqual([
    'Heures de votre traversée au vent prévu, selon l’horaire prévu.',
    translate(expected.sail, 'Point of sail', 'Allure'),
    translate(expected.wind, 'Wind', 'Vent'),
  ]);
  expect(container.textContent).not.toMatch(FORBIDDEN_FR);
  expect(container.textContent).not.toMatch(/\bkt\b/);
});
