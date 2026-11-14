/**
 * What the passage page shows for a check read at several points per leg
 * (engine semantics passage-audit-4): the plume and its spread are the reading
 * at the boat's expected position, while the shading and the counts beside them
 * are the check's own (a scenario counts when it exceeds the limit at any point
 * the boat can be at in that hour). Older checks (one point per leg) read as before.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EvidenceSection from '../src/pages/briefing/EvidenceSection.jsx';
import EnsemblePlume from '../src/components/EnsemblePlume.jsx';
import RouteTimeline from '../src/components/RouteTimeline.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { scenarioSpreadSentences } from '../src/lib/scenarioSpreadSentence.js';
import { legWindArrow } from '../src/lib/legWindArrow.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedPlume from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/plume.json';

const charts = vi.hoisted(() => []);
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: (props) => { charts.push(props.option); return null; } }));

beforeEach(() => { charts.length = 0; });
afterEach(cleanup);

const NBSP = ' ';

/** The demo check made multi-point: leg 1 read at two points, and its gust counts set by hand. */
function multiPoint() {
  const findings = structuredClone(savedFindings);
  const leg = findings.legs[0];
  leg.sample_points = [
    { point_id: 'L1.1', lat: leg.sample_point.lat, lon: leg.sample_point.lon - 0.05, from_nm: 0, to_nm: leg.distance_nm / 2 },
    { point_id: 'L1.2', lat: leg.sample_point.lat, lon: leg.sample_point.lon + 0.05, from_nm: leg.distance_nm / 2, to_nm: leg.distance_nm },
  ];
  for (const hour of leg.hours) hour.exceedance = { sustained: { exceed: 0, total: 51 }, gust: { exceed: 0, total: 51 } };
  // two audited hours where 20 of 51 scenarios exceed the gust limit somewhere on the leg
  const flagged = leg.hours.slice(1, 3).map((h) => h.valid_time);
  for (const hour of leg.hours) if (flagged.includes(hour.valid_time)) hour.exceedance.gust = { exceed: 20, total: 51 };
  const plume = structuredClone(savedPlume);
  // the plume at the expected position never exceeds the limit
  const plumeLeg = plume.legs.find((l) => l.leg_id === leg.leg_id);
  plumeLeg.gust_members = plumeLeg.gust_members.map((series) => series.map((v) => (v === null ? null : 1)));
  const claim = { evidence_id: 'EX1', rule_id: 'W-GUST-03', model: 'scenario ensemble', run: null, leg_id: leg.leg_id, valid_time: flagged[0],
    value: 20, limit: findings.evidence.find((e) => e.rule_id === 'W-GUST-01' || e.rule_id === 'W-GUST-03')?.limit ?? 28, units: 'kt', source_kind: 'ensemble', member_fraction: { exceed: 20, total: 51 } };
  findings.evidence = [claim, ...findings.evidence.filter((e) => !(e.source_kind === 'ensemble' && e.member_fraction))];
  return { findings, plume, leg, flagged, claim, plumeLeg };
}

const setApp = (findings, plume) => useApp.setState({ ...useApp.getInitialState(), findings, plume, selectedEvidenceId: null }, true);

it('shades the plume from the check\'s own counts on a multi-point leg, never from the plume members', () => {
  const { findings, plume, flagged, claim, plumeLeg } = multiPoint();
  setApp(findings, plume);
  render(<EnsemblePlume evidence={claim} variable="gust" />);
  const option = charts.at(-1);
  const area = option.series.find((s) => s.markArea)?.markArea;
  const start = Date.parse(flagged[0]);
  const end = Date.parse(flagged[1]) + 3_600_000;
  expect(area.data).toEqual([[{ xAxis: start }, { xAxis: plumeLeg.times.map(Date.parse).find((t) => t >= end) }]]);
});

it('says on a multi-point leg what the plume lines and the counts are, in English and French', async () => {
  const { findings, plume, claim } = multiPoint();
  setApp(findings, plume);
  useApp.setState({ selectedEvidenceId: claim.evidence_id });
  const { container, unmount } = render(<EvidenceSection />);
  const caption = 'The scenario lines follow your expected position along this leg. The shading and the counts are the check’s own: a scenario counts when it exceeds your limit at any point of the leg you can be at in that hour.';
  expect(container.textContent).toContain(caption);
  unmount();
  const fr = render(<div id="root"><EvidenceSection /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(fr.container.textContent).toContain('Les lignes des scénarios suivent votre position prévue le long de ce tronçon.'));
  expect(fr.container.textContent).toContain('L’ombrage et les décomptes sont ceux de la vérification : un scénario compte dès qu’il dépasse votre limite en un point du tronçon où vous pouvez être à cette heure.');
});

it('lists the check\'s own count beside each plume hour on a multi-point leg', () => {
  const { findings, plume, claim, flagged } = multiPoint();
  setApp(findings, plume);
  useApp.setState({ selectedEvidenceId: claim.evidence_id });
  render(<EvidenceSection />);
  fireEvent.click(screen.getByText('Text/table alternative for the plume'));
  const table = screen.getByText('Text/table alternative for the plume').closest('details').querySelector('table');
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  const at = (iso) => rows.find((cells) => cells[1] === iso.slice(11, 16));
  const listed = flagged.find((iso) => at(iso));
  if (listed) expect(at(listed).at(-1)).toBe('20/51');
  // an hour the check did not audit on this leg has no count
  expect(rows.some((cells) => cells.at(-1) === 'not audited')).toBe(true);
});

it('keeps the plume shading and counts of a check read at one point per leg as before', () => {
  const findings = structuredClone(savedFindings);
  setApp(findings, structuredClone(savedPlume));
  const claim = findings.evidence.find((e) => e.source_kind === 'ensemble' && e.member_fraction);
  render(<EnsemblePlume evidence={claim} variable={claim.rule_id.startsWith('W-GUST') ? 'gust' : 'wind'} />);
  expect(charts.at(-1)).toBeTruthy();
  const { container } = render(<EvidenceSection />);
  expect(container.textContent).not.toContain('The scenario lines follow your expected position');
});

it('names the spread at the expected position when the check read several points on a leg, in both languages', async () => {
  expect(scenarioSpreadSentences({ wind: { median: 15.5, p90: 19.9, members: 31 }, gust: null, basis: 'expected_position' })).toEqual([{
    variable: 'wind',
    text: 'In half of the 31 forecast scenarios the strongest wind at your expected position along your route stays at or under 16 kt; in nine out of ten, at or under 20 kt.',
  }]);
  const { findings, plume } = multiPoint();
  setApp(findings, plume);
  const { container } = render(<div id="root"><EvidenceSection /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.querySelector('[data-testid="scenario-spread"]')?.textContent).toContain('à votre position prévue le long de votre route'));
  expect(container.querySelector('[data-testid="scenario-spread"] p').textContent)
    .toMatch(new RegExp(`^Dans la moitié des 51 scénarios de prévision simulés, le vent le plus fort à votre position prévue le long de votre route reste à \\d+ nd ou moins${NBSP}; dans neuf scénarios sur dix, à \\d+ nd ou moins\\.$`));
});

it('the route timeline table shows what its chart shows: the reading at the expected position', () => {
  const findings = structuredClone(savedFindings);
  let k = 0;
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      k += 1;
      hour.expected = { sample_point_id: `${leg.leg_id}.1`, wind_kt: 100 + k, gust_kt: 200 + k, wind_dir_deg: hour.wind_dir_deg, twa_deg: hour.twa_deg,
        point_of_sail: hour.point_of_sail, limit_status: { sustained: 'ok', gust: 'ok' } };
    }
  }
  setApp(findings, savedPlume);
  render(<RouteTimeline />);
  fireEvent.click(screen.getByText(/Show wind, gust and wave charts/));
  const option = charts.at(-1);
  const chartWind = new Set(option.series.find((s) => s.name === 'wind').data.map(([, v]) => v));
  const chartGust = new Set(option.series.find((s) => s.name === 'gusts').data.map(([, v]) => v));
  const table = screen.getByText('Table alternative for route timeline').closest('details').querySelector('table');
  const rows = within(table).getAllByRole('row', { hidden: true }).slice(1).map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  expect(rows.length).toBeGreaterThan(3);
  // every row is a chart point: the expected reading, never the worst row beside it
  for (const cells of rows) {
    expect(chartWind.has(Number(cells[3])), cells.join(' ')).toBe(true);
    expect(chartGust.has(Number(cells[4])), cells.join(' ')).toBe(true);
    expect(Number(cells[3])).toBeGreaterThan(100);
  }
});

it('a leg\'s wind arrow reads where the boat is expected at the leg\'s middle hour, drawn there', () => {
  const findings = structuredClone(savedFindings);
  const leg = findings.legs[0];
  const mid = leg.hours[Math.floor(leg.hours.length / 2)];
  expect(legWindArrow(leg)).toMatchObject({ lat: leg.sample_point.lat, lon: leg.sample_point.lon, kt: mid.wind_kt, dir: mid.wind_dir_deg });
  leg.sample_points = [{ point_id: 'L1.1', lat: 49.1, lon: -1.9, from_nm: 0, to_nm: 4 }, { point_id: 'L1.2', lat: 49.2, lon: -2.0, from_nm: 4, to_nm: 8 }];
  mid.expected = { sample_point_id: 'L1.2', wind_kt: 7, gust_kt: 9, wind_dir_deg: 200, twa_deg: 90, point_of_sail: 'reach', limit_status: { sustained: 'ok', gust: 'ok' } };
  expect(legWindArrow(leg)).toMatchObject({ lat: 49.2, lon: -2.0, kt: 7, dir: 200, time: mid.valid_time });
});
