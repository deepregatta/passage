// A departure comparison runs off the page's thread, so the page answers while
// it runs: it shows the counts, can be stopped, and stops itself when what it
// compares changes.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { runScanJob, ScanCancelledError } from '../src/lib/scanRunner.js';
import { toLocalDateTimeValue } from '../src/lib/format.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null, Marker: () => null,
  Polyline: () => <div data-testid="route-line" />, useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: ({ onSelect }) =>
  <button onClick={() => onSelect({ polar_id: 'other-boat', label: 'Other boat' })}>Other boat</button>,
}));
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(), prepareAnalysisInputs: vi.fn() }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (original) => ({ ...await original(), computeRoute: vi.fn() }));
vi.mock('../src/lib/scanRunner.js', async (original) => ({ ...await original(), runScanJob: vi.fn() }));

const DEPARTURE = '2026-09-15T06:00:00Z';
const scanButton = () => screen.getByRole('button', { name: /^(Compare departure times \(next 5 days\)|Comparing departure times…)$/ });
const stopButton = () => screen.queryByRole('button', { name: 'Stop comparing' });
const routed = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15, arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const OUT = {
  scan: { candidates: [{ departure_utc: DEPARTURE, verdict: 'within', worst_ratio: 0.5, max_fraction: null, ensemble_covered: false,
    max_members: null, driver_summary: null, passage_h: 2, arrival_hours_over_limit: 0, arrival_hours_approaching: 0,
    arrival_hours_no_data: 0, expected_hours_over_limit: 0 }], best_index: 0, skipped: [] },
  routes: { [DEPARTURE]: routed(DEPARTURE) }, notes: ['note'], currents: null, rerouted: true, requested: 21,
};

/** The running job: its options, and a way to finish it the way the real runner does. */
let job;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200',
    departureLocal: toLocalDateTimeValue(DEPARTURE), endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits, language: 'en', loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 48 });
  computeRoute.mockImplementation(({ departureUtc }) => routed(departureUtc));
  runScanJob.mockImplementation((request, options) => new Promise((resolve, reject) => {
    job = { request, options, resolve };
    options.signal.addEventListener('abort', () => reject(new ScanCancelledError()));
  }));
  render(<Planner />);
  fireEvent.click(screen.getByRole('button', { name: /^Compute route$/ }));
  await waitFor(() => expect(usePlanner.getState().computed).not.toBeNull());
});
afterEach(() => vi.useRealTimers());

async function startScan() {
  fireEvent.click(scanButton());
  await waitFor(() => expect(runScanJob).toHaveBeenCalled());
}

it('shows the routing count, then the comparing count, while the comparison runs', async () => {
  await startScan();
  act(() => job.options.onProgress('routing departures 4/21'));
  expect(screen.getAllByText('Routing departures 4/21…').length).toBeGreaterThan(0);
  act(() => job.options.onProgress('scanning departures 9/21'));
  expect(screen.getAllByText('Comparing departure times 9/21…').length).toBeGreaterThan(0);
  await act(async () => job.resolve(OUT));
  await screen.findByRole('region', { name: 'Departure comparison' });
  const scan = usePlanner.getState().scan;
  expect(scan).toMatchObject({ rerouted: true, requested: 21, notes: ['note'], anchorMs: Date.parse(DEPARTURE) });
  expect(scan.routes[DEPARTURE]).toMatchObject({ notes: ['note'], currents: null, inputKey: expect.any(String) });
  expect(stopButton()).not.toBeInTheDocument();
});

it('stops on request: no comparison, the page is idle and says it stopped', async () => {
  await startScan();
  expect(Date.parse(job.request.departureUtc)).toBe(Date.parse(DEPARTURE));
  expect(job.request).toMatchObject({ mode: 'compute', polarId: 'sun-fast-3200', polarPercent: 100 });
  expect(structuredClone(job.request)).toEqual(job.request);
  fireEvent.click(stopButton());
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText('Comparison stopped.')).toBeInTheDocument());
  expect(stopButton()).not.toBeInTheDocument();
  expect(scanButton()).toBeEnabled();
  expect(usePlanner.getState().scan).toBeNull();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  // a second comparison runs normally
  await startScan();
  expect(runScanJob).toHaveBeenCalledTimes(2);
  await act(async () => job.resolve(OUT));
  await screen.findByRole('region', { name: 'Departure comparison' });
});

it('the phone bar\'s button stops the comparison while it runs', async () => {
  await startScan();
  const bar = screen.getByTestId('planner-action-bar');
  const barButton = bar.querySelector('button');
  expect(barButton).toHaveTextContent('Stop comparing');
  expect(barButton).toBeEnabled();
  fireEvent.click(barButton);
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText('Comparison stopped.')).toBeInTheDocument());
});

it('stops itself when the route changes while it runs', async () => {
  await startScan();
  act(() => usePlanner.getState().patch({ polarPercent: 90 }));
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText('Comparison stopped: the route or departure changed. Compare again.')).toBeInTheDocument());
  expect(usePlanner.getState().scan).toBeNull();
});

it('stops when the departure leaves the compared times, and keeps running for one of them', async () => {
  await startScan();
  act(() => usePlanner.getState().patch({ departureLocal: toLocalDateTimeValue('2026-09-16T00:00:00Z') }));
  expect(job.options.signal.aborted).toBe(false);
  act(() => usePlanner.getState().patch({ departureLocal: toLocalDateTimeValue('2026-09-16T01:00:00Z') }));
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText('Comparison stopped: the route or departure changed. Compare again.')).toBeInTheDocument());
});

it('ignores a result that arrives after the comparison was stopped', async () => {
  runScanJob.mockImplementationOnce((request, options) => new Promise((resolve) => { job = { request, options, resolve }; }));
  await startScan();
  fireEvent.click(stopButton());
  await act(async () => job.resolve(OUT));
  expect(usePlanner.getState().scan).toBeNull();
  expect(screen.getByText('Comparison stopped.')).toBeInTheDocument();
});
