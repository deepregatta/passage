import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { candidateDepartures, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { analyzeInBrowser, saveRoute } from '../src/lib/browserAnalysis.js';
import limits from '../../config/profiles/default-limits.json';
import { fmtLocalTime, toLocalDateTimeValue } from '../src/lib/format.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn(), eachLayer: vi.fn(), on: vi.fn(), off: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/lib/browserAnalysis.js', () => ({
  analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
  prepareAnalysisInputs: vi.fn(async draft => ({ ...draft, tileRuns: {}, inputRecords: [], store: {} })),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (importOriginal) => ({
  ...await importOriginal(), scanDepartures: vi.fn(),
}));

const departure = '2026-09-09T06:00:00Z';
const openSnapshot = vi.fn();
const comparison = () => within(screen.getByRole('region', { name: 'Departure comparison' }));
// The grid's time cells, not the ranking toggle that shares the region (a view setting, never disabled with them).
const cells = () => comparison().getAllByRole('button').filter(button => button.hasAttribute('title'));
const checkButton = () => screen.getByRole('button', { name: 'Check this passage' });
const scanButton = () => screen.getByRole('button', { name: 'Compare departure times (next 5 days)' });

beforeEach(() => {
  // A departure in the past or beyond the forecast is refused, so pin the clock just before it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  vi.clearAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({
    rankMode: 'typical',
    polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200',
    mode: 'draw',
    waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }],
    departureLocal: toLocalDateTimeValue(departure),
    scan: {
      candidates: candidateDepartures(Date.parse(departure), 12, 6).map(departure_utc => ({
        departure_utc, verdict: 'within', passage_h: 2,
      })),
      best_index: 0,
    },
  });
  useApp.setState({
    manifest: { snapshots: [] }, profileDefaults: limits, limits: null, findings: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot,
  });
  saveRoute.mockResolvedValue(undefined);
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked-passage' });
  scanDepartures.mockResolvedValue({ candidates: [], best_index: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['seconds', 'milliseconds', 'offset'])('outlines the selected instant with %s candidate timestamps', (format) => {
  const scan = usePlanner.getState().scan;
  if (format === 'milliseconds') scan.candidates[0].departure_utc = '2026-09-09T06:00:00.000Z';
  if (format === 'offset') scan.candidates[0].departure_utc = '2026-09-09T08:00:00+02:00';
  render(<Planner />);
  const buttons = cells();
  expect(buttons[0]).toHaveClass('outline', 'outline-2', 'outline-ink');
  expect(buttons.slice(1).every(button => !button.classList.contains('outline'))).toBe(true);
});

it('picks a new departure, moves the outline and checks the chosen instant', async () => {
  render(<Planner />);
  fireEvent.click(cells()[1]);
  await waitFor(() => expect(openSnapshot).toHaveBeenCalled());
  expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe('2026-09-09T12:00:00Z');
  expect(cells()[0]).not.toHaveClass('outline');
  expect(cells()[1]).toHaveClass('outline');
});

it.each([{}, undefined])('checks and opens a passage without secure-context crypto (%s)', async (crypto) => {
  vi.stubGlobal('crypto', crypto);
  render(<Planner />);
  for (let i = 1; i <= 2; i++) {
    fireEvent.click(checkButton());
    await waitFor(() => expect(openSnapshot).toHaveBeenCalledTimes(i));
  }
  expect(saveRoute).toHaveBeenCalledTimes(2);
  expect(analyzeInBrowser).toHaveBeenCalledTimes(2);
  const attempts = openSnapshot.mock.calls.map(([snapshotId, attempt]) => {
    expect(snapshotId).toBe('checked-passage');
    expect(attempt).toEqual(expect.any(String));
    expect(attempt.length).toBeGreaterThan(0);
    return attempt;
  });
  expect(new Set(attempts).size).toBe(2);
});

it('uses randomUUID when it is available', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'secure-attempt-id' });
  render(<Planner />);
  fireEvent.click(checkButton());
  await waitFor(() => expect(openSnapshot).toHaveBeenCalledWith('checked-passage', 'secure-attempt-id'));
});

it.each(['slow', 'nominal', 'fast'].flatMap(speed => ['', '0', '-1'].map(value => [speed, value])))(
  'rejects %s speed set to "%s", including an existing comparison, and recovers after correction',
  async (speed, value) => {
    const { container } = render(<Planner />);
    const input = screen.getByRole('spinbutton', { name: `${speed} speed` });
    fireEvent.change(input, { target: { value } });
    expect(checkButton()).toBeDisabled();
    expect(scanButton()).toBeDisabled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(container).not.toHaveTextContent(/Infinity|NaN|~\s*h/);
    for (const button of cells()) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    fireEvent.click(checkButton());
    fireEvent.click(scanButton());
    expect(saveRoute).not.toHaveBeenCalled();
    expect(analyzeInBrowser).not.toHaveBeenCalled();
    expect(scanDepartures).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '5.5' } });
    expect(checkButton()).toBeEnabled();
    expect(scanButton()).toBeEnabled();
    fireEvent.click(checkButton());
    await waitFor(() => expect(openSnapshot).toHaveBeenCalled());
    expect(analyzeInBrowser.mock.calls[0][0].route.speeds_kt[speed]).toBe(5.5);
  },
);

it.each([0, -1, NaN, Infinity, null, ''])('blocks automatic scans with invalid restored speed %s', async (speed) => {
  usePlanner.setState({ speeds: { slow: 4.5, nominal: speed, fast: 6.5 }, autoScan: true });
  render(<Planner />);
  await waitFor(() => expect(usePlanner.getState().autoScan).toBe(false));
  expect(scanDepartures).not.toHaveBeenCalled();
});

it('allows polar-based computed routes when the hidden drawn-speed inputs are invalid', async () => {
  usePlanner.setState({
    mode: 'compute', speeds: { slow: '', nominal: 0, fast: -1 },
    computed: { inputKey: JSON.stringify([[], 'sun-fast-3200', new Date(departure).toISOString()]), route: {
      schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
      waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
      polar_ref: 'sun-fast-3200',
    } },
  });
  render(<Planner />);
  expect(checkButton()).toBeEnabled();
  expect(scanButton()).toBeEnabled();
  fireEvent.click(checkButton());
  await waitFor(() => expect(openSnapshot).toHaveBeenCalled());
});

it.each([false, true])('shows actual skipped reasons when all candidates failed: %s', async (allFailed) => {
  const candidates = allFailed ? [] : usePlanner.getState().scan.candidates.slice(0, 1);
  usePlanner.setState({ scan: null });
  scanDepartures.mockResolvedValue({ candidates, best_index: allFailed ? null : 0, skipped: [
    { departure_utc: departure, reason: 'Tile service unavailable' },
    { departure_utc: '2026-09-09T12:00:00Z', reason: 'No sea route found' },
  ] });
  render(<Planner />);
  fireEvent.click(scanButton());
  await waitFor(() => expect(screen.getByText('Tile service unavailable')).toBeInTheDocument());
  expect(screen.getByText('No sea route found')).toBeInTheDocument();
  expect(screen.getByText('Unassessed departures')).toBeInTheDocument();
  expect(screen.getByText('A missing cell does not mean safe conditions.')).toBeInTheDocument();
  expect(screen.queryByText(/fall beyond the .*horizon/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Unassessed departures'));
  const times = screen.getAllByRole('time');
  expect(times.map(time => time.getAttribute('dateTime'))).toEqual([departure, '2026-09-09T12:00:00Z']);
});

// ---- Typical / Cautious ranking -------------------------------------------------------------
const toggle = (name) => comparison().getByRole('button', { name });
const cellFor = (utc) => cells().find(b => b.title.startsWith(fmtLocalTime(utc)));
const glyphOf = (utc) => cellFor(utc).querySelector('[aria-hidden]').textContent.trim();
const summary = () => comparison().getByText(/Least exposure this window/).closest('p');

/** Four 6-hourly times: the main forecast prefers the first, the scenarios prefer the second. */
function rankedScan(over = []) {
  const times = candidateDepartures(Date.parse(departure), 18, 6);
  const specs = [
    { worst_ratio: 0.2, max_fraction: 0.3, max_members: { exceed: 9, total: 31 } },
    { worst_ratio: 0.6, max_fraction: 0, max_members: { exceed: 0, total: 31 } },
    { worst_ratio: 0.22, max_fraction: 0.32, max_members: { exceed: 10, total: 31 } },
    { worst_ratio: 0.9, max_fraction: 0.03, max_members: { exceed: 1, total: 31 } },
  ];
  return {
    candidates: times.map((departure_utc, i) => ({
      departure_utc, verdict: 'within', passage_h: 2, ensemble_covered: true, ...specs[i], ...over[i],
    })),
    best_index: 0,
  };
}

it('toggles Typical and Cautious as pressed buttons of at least 44 px, without starting a scan', () => {
  usePlanner.setState({ scan: rankedScan() });
  render(<Planner />);
  expect(toggle('Typical')).toHaveAttribute('aria-pressed', 'true');
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'false');
  expect(toggle('Typical')).toHaveClass('min-h-11');
  expect(toggle('Cautious')).toHaveClass('min-h-11');
  expect(comparison().getByText(/ranked on the main forecast against your limits/)).toBeInTheDocument();
  expect(comparison().getByText(/ranked first on how many forecast scenarios exceed your limits/)).toBeInTheDocument();
});

it('re-ranks on the scan it holds when the toggle changes, and back', () => {
  usePlanner.setState({ scan: rankedScan() });
  const held = usePlanner.getState().scan;
  render(<Planner />);
  const [t0, t1] = held.candidates.map(c => c.departure_utc);
  expect(glyphOf(t0)).toBe('◎');
  expect(summary()).toHaveTextContent(fmtLocalTime(t0));
  fireEvent.click(toggle('Cautious'));
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'true');
  expect(glyphOf(t1)).toBe('◎');
  expect(glyphOf(t0)).not.toContain('◎');
  expect(summary()).toHaveTextContent(fmtLocalTime(t1));
  expect(usePlanner.getState().rankMode).toBe('cautious');
  fireEvent.click(toggle('Typical'));
  expect(glyphOf(t0)).toBe('◎');
  expect(scanDepartures).not.toHaveBeenCalled();
  expect(usePlanner.getState().scan).toBe(held);
});

it('names the effectively tied times in the summary and marks their cells, in each mode', () => {
  usePlanner.setState({ scan: rankedScan() });
  render(<Planner />);
  const times = usePlanner.getState().scan.candidates.map(c => c.departure_utc);
  // typical: 0.20 and 0.22 are within 5 % of the limit; 0.6 and 0.9 are not
  expect(summary()).toHaveTextContent(`≈ Effectively tied: ${fmtLocalTime(times[2])} local time`);
  expect(summary()).not.toHaveTextContent(fmtLocalTime(times[1]) + ' local time');
  expect(glyphOf(times[2])).toBe('✓ ≈');
  expect(glyphOf(times[1])).not.toContain('≈');
  expect(cellFor(times[2]).title).toContain('effectively tied with the least-exposure time');
  expect(cellFor(times[1]).title).not.toContain('effectively tied');
  expect(comparison().getByText('effectively tied with the least exposure')).toBeInTheDocument();
  // cautious: 0 and 0.03 (one scenario of 31) are tied, but only when the ratio is also close, which it is not here
  fireEvent.click(toggle('Cautious'));
  expect(summary()).not.toHaveTextContent('Effectively tied');
  expect(comparison().queryByText('effectively tied with the least exposure')).not.toBeInTheDocument();
});

it('shows no tie note and no tie legend when nothing is tied', () => {
  usePlanner.setState({ scan: rankedScan([{ worst_ratio: 0.1 }, { worst_ratio: 0.5 }, { worst_ratio: 0.7 }, { worst_ratio: 0.9 }]) });
  render(<Planner />);
  expect(summary()).not.toHaveTextContent('Effectively tied');
  expect(comparison().queryByText('effectively tied with the least exposure')).not.toBeInTheDocument();
  expect(comparison().queryAllByText(/≈\s*$/)).toHaveLength(0);
});

it('disables Cautious with a visible reason when no time has forecast scenarios, and keeps the preference', () => {
  usePlanner.setState({ rankMode: 'cautious', scan: rankedScan(Array.from({ length: 4 }, () => ({ ensemble_covered: false, max_fraction: null, max_members: null }))) });
  render(<Planner />);
  expect(toggle('Cautious')).toBeDisabled();
  expect(toggle('Typical')).toHaveAttribute('aria-pressed', 'true');
  const reason = comparison().getByText(/Cautious is unavailable: no forecast scenarios cover these departure times/);
  expect(reason).toBeVisible();
  expect(toggle('Cautious')).toHaveAttribute('aria-describedby', reason.id);
  fireEvent.click(toggle('Cautious'));
  expect(usePlanner.getState().rankMode).toBe('cautious'); // the stored choice is not rewritten
  expect(glyphOf(usePlanner.getState().scan.candidates[0].departure_utc)).toBe('◎'); // typical order
});

it('keeps Cautious available when only some times have forecast scenarios', () => {
  usePlanner.setState({ scan: rankedScan([{}, { ensemble_covered: false, max_fraction: null, max_members: null }, {}, {}]) });
  render(<Planner />);
  expect(toggle('Cautious')).toBeEnabled();
  expect(comparison().queryByText(/Cautious is unavailable/)).not.toBeInTheDocument();
});

it('adds the scenario count to the cell tooltip when it is known, including none', () => {
  usePlanner.setState({ scan: rankedScan([{}, {}, { ensemble_covered: false, max_fraction: null, max_members: null }]) });
  render(<Planner />);
  const times = usePlanner.getState().scan.candidates.map(c => c.departure_utc);
  expect(cellFor(times[0]).title).toContain('9 of 31 forecast scenarios exceed a limit');
  expect(cellFor(times[1]).title).toContain('0 of 31 forecast scenarios exceed a limit');
  expect(cellFor(times[2]).title).not.toContain('forecast scenarios');
});

it('picks a time from the grid the same way in both modes', async () => {
  for (const mode of ['typical', 'cautious']) {
    usePlanner.setState({ rankMode: mode, scan: rankedScan() });
    analyzeInBrowser.mockClear();
    const view = render(<Planner />);
    fireEvent.click(cellFor('2026-09-09T18:00:00Z'));
    await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
    expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe('2026-09-09T18:00:00Z');
    expect(usePlanner.getState().scan).not.toBeNull();
    view.unmount();
  }
});

it('survives the toggle changing while a scan is in progress and shows the result in that mode', async () => {
  let finish;
  scanDepartures.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  usePlanner.setState({ scan: null });
  render(<Planner />);
  fireEvent.click(scanButton());
  await waitFor(() => expect(scanDepartures).toHaveBeenCalled());
  expect(() => usePlanner.getState().patch({ rankMode: 'cautious' })).not.toThrow();
  const { candidates } = rankedScan();
  finish({ candidates, best_index: 0, skipped: [] });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Departure comparison' })).toBeInTheDocument());
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'true');
  expect(glyphOf(candidates[1].departure_utc)).toBe('◎');
  expect(usePlanner.getState().scan.candidates).toHaveLength(4);
});

it('leaves the stored scan intact when the preference changes under a rendered grid', () => {
  usePlanner.setState({ scan: rankedScan() });
  render(<Planner />);
  expect(() => { for (const next of ['cautious', 'typical', 'cautious']) fireEvent.click(toggle(next === 'cautious' ? 'Cautious' : 'Typical')); }).not.toThrow();
  expect(usePlanner.getState().scan.candidates).toHaveLength(4);
});

it('persists the ranking mode, defaults it for a draft saved without one, and keeps it across a new passage', async () => {
  usePlanner.getState().patch({ rankMode: 'cautious' });
  expect(JSON.parse(localStorage.getItem('deepweather.planner-draft'))).toMatchObject({ version: 3, state: { rankMode: 'cautious' } });
  usePlanner.getState().reset();
  expect(usePlanner.getState().rankMode).toBe('cautious');
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 3, state: { passageId: 'saved', name: 'Old', nameAuto: false } }));
  usePlanner.setState({ rankMode: 'typical' });
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState().rankMode).toBe('typical');
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 3, state: { passageId: 'saved', rankMode: 'cautious' } }));
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState().rankMode).toBe('cautious');
});
