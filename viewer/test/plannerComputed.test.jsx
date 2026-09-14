import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, saveRoute } from '../src/lib/browserAnalysis.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../src/lib/format.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => <div data-testid="route-line" />,
  useMap: () => ({ fitBounds: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: ({ onSelect }) =>
  <button onClick={() => onSelect({ polar_id: 'other-boat', label: 'Other boat' })}>Other boat</button>,
}));
vi.mock('../src/lib/routingInputs.js', () => ({ loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn() }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(), computeRoute: vi.fn(), scanDepartures: vi.fn(),
}));

const computeButton = () => screen.getByRole('button', { name: 'Compute route', exact: true });
const checkButton = () => screen.getByRole('button', { name: /^(Check this passage against my limits|computing route…)$/ });
const scanButton = () => screen.getByRole('button', { name: 'Compare departure times (next 5 days)' });
const summary = () => screen.queryByText('12.3 nm');
const changeDate = (value = '2030-09-15') => fireEvent.change(screen.getByLabelText('Departure date'), { target: { value } });
const noSummary = () => {
  expect(summary()).not.toBeInTheDocument();
  expect(screen.queryByTestId('route-line')).not.toBeInTheDocument();
  expect(checkButton()).toBeDisabled();
  expect(scanButton()).toBeDisabled();
};
const result = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'sun-fast-3200' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
async function compute() {
  fireEvent.click(computeButton());
  await waitFor(() => expect(summary()).toBeInTheDocument());
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', departureLocal: '2026-09-15T08:00',
    endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: {}, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120 });
  computeRoute.mockImplementation(({ departureUtc }) => result(departureUtc));
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked' });
});

it('removes an earlier arrival after departure change and failed recomputation, then recovers', async () => {
  render(<Planner />);
  await compute();
  changeDate();
  loadRoutingInputs.mockRejectedValueOnce(new Error('This departure is beyond the forecast horizon'));
  fireEvent.click(computeButton());
  await screen.findByText('This departure is beyond the forecast horizon');
  noSummary();
  changeDate('2026-09-15');
  await compute();
  expect(checkButton()).toBeEnabled();
});

it.each(['date', 'time', 'boat', 'endpoints', 'empty date'])('immediately invalidates on changed %s', async (input) => {
  render(<Planner />);
  await compute();
  if (input === 'date') changeDate();
  if (input === 'empty date') changeDate('');
  if (input === 'time') fireEvent.change(screen.getByLabelText('Departure time, 24-hour clock'), { target: { value: '09:00' } });
  if (input === 'boat') fireEvent.click(screen.getByText('Other boat'));
  if (input === 'endpoints') act(() => usePlanner.getState().patch({ endpoints: [{ lat: 50, lng: -1 }, { lat: 51, lng: -2 }] }));
  noSummary();
});

it('clears a previous summary while retrying the same inputs, including a routing failure', async () => {
  render(<Planner />);
  await compute();
  let resolve;
  loadRoutingInputs.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  fireEvent.click(computeButton());
  noSummary();
  computeRoute.mockImplementationOnce(() => { throw new Error('No sea route found'); });
  await act(async () => resolve({ notes: [] }));
  await screen.findByText('No sea route found');
  noSummary();
});

it.each(['success', 'failure'])('does not publish a late %s for inputs edited during loading', async (outcome) => {
  render(<Planner />);
  let resolve, reject;
  loadRoutingInputs.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
  fireEvent.click(computeButton());
  changeDate();
  await act(async () => outcome === 'success' ? resolve({ notes: [] }) : reject(new Error('Old request failure')));
  noSummary();
  expect(screen.queryByText('Old request failure')).not.toBeInTheDocument();
  expect(usePlanner.getState().computed).toBeNull();
  expect(computeButton()).toBeEnabled();
});

it('preserves matching results on remount and rejects restored results with changed inputs or no provenance', async () => {
  let view = render(<Planner />);
  await compute();
  const saved = usePlanner.getState().computed;
  view.unmount();
  view = render(<Planner />);
  expect(summary()).toBeInTheDocument();
  view.unmount();
  usePlanner.setState({ departureLocal: '2030-09-15T08:00' });
  view = render(<Planner />);
  noSummary();
  view.unmount();
  usePlanner.setState({ computed: { ...result('2026-09-15T06:00:00Z') }, departureLocal: '2026-09-15T08:00' });
  view = render(<Planner />);
  noSummary();
  expect(saved).not.toBeNull();
});

it('selects a rerouted scan candidate with its matching summary and checks that route', async () => {
  render(<Planner />);
  await compute();
  const departure = '2026-09-15T12:00:00Z';
  scanDepartures.mockImplementation(async ({ routeFor }) => {
    routeFor(departure);
    return { candidates: [{ departure_utc: departure, verdict: 'within', passage_h: 2 }], best_index: 0 };
  });
  fireEvent.click(scanButton());
  const region = await screen.findByRole('region', { name: 'Departure comparison' });
  fireEvent.click(within(region).getAllByRole('button')[0]);
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
  expect(summary()).toBeInTheDocument();
  expect(usePlanner.getState().departureLocal).toBe(toLocalDateTimeValue(departure));
  expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe(departure);
  expect(saveRoute).toHaveBeenCalledWith(usePlanner.getState().computed.route);
  expect(localDateTimeToIso(usePlanner.getState().departureLocal)).toBe(new Date(departure).toISOString());
});
