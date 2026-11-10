import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { localDateTimeToIso } from '../src/lib/format.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import savedRoute from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));

let findings, briefing, route;
beforeEach(() => {
  findings = structuredClone(savedFindings);
  briefing = structuredClone(savedBriefing);
  route = structuredClone(savedRoute);
  useApp.setState({ ...useApp.getInitialState(), findings, briefing, route, page: 'briefing' }, true);
  usePlanner.setState(usePlanner.getInitialState(), true);
  usePlayback.setState(usePlayback.getInitialState(), true);
});

it.each([true, false])('hands the saved route to the planner with recorded speeds: %s', (recordedSpeeds) => {
  const draftSpeeds = { slow: 3, nominal: 4, fast: 5 };
  usePlanner.getState().patch({ mode: 'compute', speeds: draftSpeeds, computed: { stale: true }, scan: { stale: true } });
  if (!recordedSpeeds) delete route.speeds_kt;
  const before = structuredClone(route);
  render(<Briefing />);
  fireEvent.click(screen.getByRole('button', { name: 'Find a departure that fits' }));
  const planner = usePlanner.getState();
  expect(planner).toMatchObject({
    mode: 'draw', name: route.name, autoScan: true, computed: null, scan: null,
    waypoints: route.waypoints.map(({ lat, lon }) => ({ lat, lng: lon })),
    speeds: recordedSpeeds ? route.speeds_kt : draftSpeeds,
  });
  expect(Date.parse(localDateTimeToIso(planner.departureLocal))).toBe(Date.parse(findings.departure_utc));
  if (recordedSpeeds) expect(planner.speeds).not.toBe(route.speeds_kt);
  expect(route).toEqual(before);
  expect(useApp.getState().page).toBe('planner');
});

it('expands the ordered reasoning once, with one professional-register disclosure, then collapses it', () => {
  const orderedTitles = briefing.sections.map(({ title }) => title);
  briefing.sections.reverse();
  render(<Briefing />);
  const why = screen.getByRole('button', { name: 'Why this assessment' });
  expect(why).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(why);
  expect(why).toHaveAttribute('aria-expanded', 'true');
  const details = why.nextElementSibling;
  // the per-leg route-impact list repeats the timeline and leg table: it is not rendered here
  const shown = orderedTitles.filter((title) => title !== 'Route impact, leg by leg');
  expect(within(details).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(shown);
  expect(details.querySelector('li')).toBeNull();
  expect(details.className).not.toMatch(/overflow|max-h/);
  // one disclosure for the whole block, not one per section
  expect(within(details).getAllByText('Professional register')).toHaveLength(1);
  expect(details.querySelectorAll('details')).toHaveLength(1);
  // coverage is stated once, under Models and coverage
  expect(within(details).queryByRole('region', { name: 'Capability coverage' })).toBeNull();
  expect(details).toHaveTextContent('No flag does not mean no risk.');
  const register = details.querySelector('details');
  expect(register).toHaveTextContent('Authority override: bulletin');
  fireEvent.click(within(register).getAllByRole('button', { name: 'E23' })[0]);
  expect(useApp.getState()).toMatchObject({ inspectorOpen: true, selectedEvidenceId: 'E23' });
  fireEvent.click(why);
  expect(why).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('heading', { name: 'Official warning active', level: 3 })).toBeNull();
  expect(briefing.sections.map(({ title }) => title)).toEqual([...orderedTitles].reverse());
});

it('keeps the story expanded and evidence selected as playback crosses every phase boundary', () => {
  // the story follows the causal event on the leg the verdict sentence names (L3 here)
  const event = findings.causal_events.find((e) => e.route_intersection?.leg_id === 'L3');
  event.route_intersection.window_start = '2026-07-20T08:00:00Z';
  event.route_intersection.window_end = '2026-07-20T10:00:00Z';
  render(<Briefing />);
  const why = screen.getByRole('button', { name: 'Why this assessment' });
  fireEvent.click(why);
  act(() => useApp.getState().openEvidence(findings.verdict.driver_evidence_id));
  for (const [hours, phase] of [
    [0, 'what sets this up'], [2, 'while you are out there'], [4, 'while you are out there'],
    [4.01, 'right after your passage'], [10, 'right after your passage'], [10.01, 'easing off'],
  ]) {
    act(() => usePlayback.getState().setCursor(hours));
    expect(screen.getByText(phase, { exact: true })).toBeVisible();
    expect(why).toHaveAttribute('aria-expanded', 'true');
    expect(useApp.getState().selectedEvidenceId).toBe(findings.verdict.driver_evidence_id);
  }
});

it('shows the verdict state on the chip and the personal-limit result in the sentence beside it', () => {
  render(<Briefing />);
  const band = within(screen.getByTestId('decision-band'));
  // chip and sentence describe the same state: the warning
  expect(band.getByText('Official warning active', { exact: true })).toBeVisible();
  expect(band.queryByText(/Exceeds your limits|Within your declared limits|Approaching your limits/)).toBeNull();
  const sentence = band.getByRole('heading', { level: 1 });
  expect(sentence).toHaveTextContent(/^Synthetic warning scenario for Casquets: offshore marine bulletin \(BMS\) from Météo-France BMS \(synthetic\)\. Your 18 kt wind limit is exceeded near Casquets TSS crossing \(leg 3\)/);
});

it('keeps the legacy chart fallback and route endpoints and distances', () => {
  render(<Briefing />);
  expect(screen.getByText(/No synoptic chart was archived with this briefing/)).toBeVisible();
  expect(screen.getByTestId('passage-map')).toBeVisible();
  const legs = document.querySelector('[aria-label="Legs"]');
  expect(legs).toHaveTextContent('Cherbourg');
  expect(legs).toHaveTextContent('Plymouth breakwater');
  for (const leg of findings.legs) expect(legs).toHaveTextContent(`${Math.round(leg.distance_nm)} NM`);
});
