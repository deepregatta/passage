import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { candidateDepartures, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { analyzeInBrowser, saveRoute } from '../src/lib/browserAnalysis.js';
import { toLocalDateTimeValue } from '../src/lib/format.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/lib/browserAnalysis.js', () => ({
  analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (importOriginal) => ({
  ...await importOriginal(), scanDepartures: vi.fn(),
}));

const departure = '2026-09-09T06:00:00Z';
const openSnapshot = vi.fn();
const comparison = () => within(screen.getByRole('region', { name: 'Departure comparison' }));
const checkButton = () => screen.getByRole('button', { name: 'Check this passage against my limits' });
const scanButton = () => screen.getByRole('button', { name: 'Compare departure times (next 5 days)' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({
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
    manifest: { snapshots: [] }, profileDefaults: {}, findings: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot,
  });
  saveRoute.mockResolvedValue(undefined);
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked-passage' });
  scanDepartures.mockResolvedValue({ candidates: [], best_index: null });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['seconds', 'milliseconds', 'offset'])('outlines the selected instant with %s candidate timestamps', (format) => {
  const scan = usePlanner.getState().scan;
  if (format === 'milliseconds') scan.candidates[0].departure_utc = '2026-09-09T06:00:00.000Z';
  if (format === 'offset') scan.candidates[0].departure_utc = '2026-09-09T08:00:00+02:00';
  render(<Planner />);
  const buttons = comparison().getAllByRole('button');
  expect(buttons[0]).toHaveClass('outline', 'outline-2', 'outline-ink');
  expect(buttons.slice(1).every(button => !button.classList.contains('outline'))).toBe(true);
});

it('picks a new departure, moves the outline and checks the chosen instant', async () => {
  render(<Planner />);
  fireEvent.click(comparison().getAllByRole('button')[1]);
  await waitFor(() => expect(openSnapshot).toHaveBeenCalled());
  expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe('2026-09-09T12:00:00Z');
  expect(comparison().getAllByRole('button')[0]).not.toHaveClass('outline');
  expect(comparison().getAllByRole('button')[1]).toHaveClass('outline');
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
    for (const button of comparison().getAllByRole('button')) {
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
    computed: { route: {
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
