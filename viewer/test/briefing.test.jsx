import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { localDateTimeToIso } from '../src/lib/format.js';
import { PASSAGE_LABELS_KEY, passageLabels } from '../src/lib/passageLabels.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import savedSynoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';
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
  // nor the next-run time frozen at analysis time: the decision band states it, read at display time
  const shown = orderedTitles.filter((title) => !['Route impact, leg by leg', 'What could change'].includes(title));
  // one name for a result: "check", for saved checks too
  const asCheck = { 'Not assessed by this analysis': 'Not assessed by this check', 'Emulated data in this analysis': 'Emulated data in this check' };
  expect(within(details).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(shown.map((t) => asCheck[t] ?? t));
  expect(details).toHaveTextContent('Some values in this check come from EMULATED');
  expect(details.textContent).not.toMatch(/this (briefing|analysis)/);
  // the route-impact method line (a heading over one generic sentence) is not in the register either
  expect(within(details).queryByText('Route impact, leg by leg')).toBeNull();
  expect(details.querySelector('li')).toBeNull();
  expect(details.className).not.toMatch(/overflow|max-h/);
  // one disclosure for the whole block, not one per section
  expect(within(details).getAllByText('Professional register')).toHaveLength(1);
  expect(details.querySelectorAll('details')).toHaveLength(1);
  // coverage is stated once, under Models and coverage
  expect(within(details).queryByRole('region', { name: 'Capability coverage' })).toBeNull();
  expect(details).toHaveTextContent('No flag does not mean no risk.');
  // the why, not the number: the scenario count is stated at the top and in Evidence only
  expect(details.querySelector('[data-message-field="plain"]').textContent).not.toMatch(/forecast scenarios|main signal/);
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

it('names one event and one phase on the first screen: the hero chart follows the story card', () => {
  useApp.setState({ synoptic: structuredClone(savedSynoptic) });
  render(<Briefing />);
  const story = screen.getByTestId('story-phase');
  const hero = screen.getByTestId('hero-phase');
  // the story names the event on the governing leg (L3, on the route 08:38 to 18:03 UTC; the check departs 06:00 UTC)
  expect(story).toHaveTextContent('what sets this up');
  expect(hero.textContent).toBe('what sets this up · low-pressure system');
  for (const [hours, phase] of [[4, 'while you are out there'], [13, 'right after your passage'], [20, 'easing off'], [0, 'what sets this up']]) {
    act(() => usePlayback.getState().setCursor(hours));
    expect(story).toHaveTextContent(phase);
    expect(hero.textContent).toBe(`${phase} · low-pressure system`);
  }
  // evidence focus follows the same event and agrees with the claim the verdict sentence quotes (E5)
  expect(useApp.getState().selectedEvidenceId).toBe('E5');
  // the engine's system and leg ids stay out of the default reading register
  expect(screen.getByText(/· boat near /)).not.toHaveTextContent(/\b(L\d|CE\d|E\d+)\b/);
});

it('leads the page header with the name given on My passages, and the route name without one', () => {
  const check = { snapshot_id: 'snap-renamed', created_at: '2026-07-19T18:00:00Z', route_id: 'cherbourg-plymouth-v1', departure_utc: findings.departure_utc, identity_version: 2, passage_id: 'intent-1', local: true };
  useApp.setState({ manifest: { snapshots: [check] }, snapshotId: check.snapshot_id });
  const header = () => within(screen.getByTestId('decision-band')).getByText(/Cherbourg → Plymouth|Casquets run/);
  try {
    localStorage.clear();
    passageLabels.forgetMemory();
    const { unmount } = render(<Briefing />);
    expect(header()).toHaveTextContent('Cherbourg → Plymouth breakwater');
    unmount();
    // the label is stored under the passage's grouping key, as My passages does
    localStorage.setItem(PASSAGE_LABELS_KEY, JSON.stringify({ 'local|passage|intent-1': 'Casquets run' }));
    passageLabels.forgetMemory();
    render(<Briefing />);
    expect(header()).toHaveTextContent('Casquets run');
    expect(screen.queryByText('Cherbourg → Plymouth breakwater')).toBeNull();
  } finally {
    localStorage.clear();
    passageLabels.forgetMemory();
  }
});

it('shows the verdict state on the chip and the personal-limit result in the sentence beside it', () => {
  render(<Briefing />);
  const band = within(screen.getByTestId('decision-band'));
  // chip and sentence describe the same state: the warning
  expect(band.getByText('Official warning active', { exact: true })).toBeVisible();
  expect(band.queryByText(/Exceeds your limits|Within your declared limits|Approaching your limits/)).toBeNull();
  const sentence = band.getByRole('heading', { level: 1 });
  expect(sentence).toHaveTextContent(/^Synthetic warning scenario: offshore marine bulletin for Casquets from Météo-France BMS\.$/);
  expect(band.getByTestId('verdict-detail')).toHaveTextContent(/^Your 18 kt wind limit is exceeded near Casquets TSS crossing \(leg 3\)/);
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
