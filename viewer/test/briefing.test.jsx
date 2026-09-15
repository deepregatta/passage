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

it('expands ordered assessment sections, coverage and evidence, then collapses them', () => {
  const orderedTitles = briefing.sections.map(({ title }) => title);
  briefing.sections.reverse();
  render(<Briefing />);
  const why = screen.getByRole('button', { name: 'Why this assessment' });
  expect(why).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(why);
  expect(why).toHaveAttribute('aria-expanded', 'true');
  const details = why.nextElementSibling;
  expect(within(details).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
    .toEqual([...orderedTitles, 'Capability coverage']);
  const coverage = within(details).getByRole('region', { name: 'Capability coverage' });
  expect(within(coverage).getByText('official warnings').closest('li')).toHaveTextContent('assessed emulated');
  expect(within(coverage).getByText('tidal gates').closest('li')).toHaveTextContent('not assessed');
  expect(details).toHaveTextContent('No flag does not mean no risk.');
  const routeSection = briefing.sections.find(({ id }) => id === 'route_impact');
  const section = within(details).getByRole('heading', { name: routeSection.title }).parentElement;
  fireEvent.click(within(section).getAllByRole('button', { name: 'evidence', exact: true })[0]);
  expect(useApp.getState()).toMatchObject({ inspectorOpen: true, selectedEvidenceId: routeSection.per_leg[0].evidence_ids[0] });
  fireEvent.click(why);
  expect(why).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Capability coverage' })).toBeNull();
  expect(briefing.sections.map(({ title }) => title)).toEqual([...orderedTitles].reverse());
});

it('keeps the story expanded and evidence selected as playback crosses every phase boundary', () => {
  findings.causal_events[0].route_intersection.window_start = '2026-07-20T08:00:00Z';
  findings.causal_events[0].route_intersection.window_end = '2026-07-20T10:00:00Z';
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

it.each([
  ['ok', 'Within your declared limits'],
  ['approaching', 'Approaching your limits'],
  ['exceeded', 'Exceeds your limits'],
])('shows personal %s limits alongside the separate warning decision', (status, label) => {
  for (const leg of findings.legs) for (const hour of leg.hours) hour.limit_status = { wind: 'ok' };
  findings.legs.at(-1).hours.at(-1).limit_status = { wind: status };
  render(<Briefing />);
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(within(screen.getByTestId('decision-band')).getByRole('heading', { name: 'Official warning active' })).toBeVisible();
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
