import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, saveRoute } from '../src/lib/browserAnalysis.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../src/lib/format.js';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn() }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: ({ position, draggable, eventHandlers }) => <button aria-label={`Waypoint ${position.lat},${position.lng}`}
    disabled={!draggable} onClick={() => eventHandlers.dragend({ target: { getLatLng: () => ({ lat: 51, lng: -2 }) } })} />,
  Polyline: () => <div data-testid="route-line" />,
  useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
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
  render(<Planner />);
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

it('edits map points, carries endpoints between modes, and clears the draft', () => {
  usePlanner.setState({ mode: 'draw', endpoints: [] });
  render(<Planner />);
  act(() => mapEvents.click({ latlng: { lat: 50.5, lng: -1.5 } }));
  act(() => mapEvents.click({ latlng: { lat: 50.6, lng: -1.4 } }));
  expect(mapEvents.fitBounds).not.toHaveBeenCalled();
  expect(checkButton()).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Waypoint 50.6,-1.4' }));
  expect(usePlanner.getState().waypoints[1]).toEqual({ lat: 51, lng: -2 });
  expect(mapEvents.fitBounds).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Compute a route' }));
  expect(usePlanner.getState().endpoints).toEqual(usePlanner.getState().waypoints);
  expect(mapEvents.fitBounds).toHaveBeenCalled();
  expect(mapEvents.fitBounds.mock.lastCall[0].getNorthEast()).toMatchObject({ lat: 51, lng: -1.5 });
  act(() => mapEvents.click({ latlng: { lat: 49, lng: -3 } }));
  expect(usePlanner.getState().endpoints).toEqual([{ lat: 49, lng: -3 }]);
  expect(computeButton()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'clear', exact: true }));
  act(() => mapEvents.click({ latlng: { lat: 50, lng: -1 } }));
  act(() => mapEvents.click({ latlng: { lat: 51, lng: -2 } }));
  fireEvent.click(screen.getByRole('tab', { name: 'Draw my route' }));
  expect(usePlanner.getState().waypoints).toEqual(usePlanner.getState().endpoints);
  fireEvent.click(screen.getByRole('button', { name: 'undo', exact: true }));
  expect(usePlanner.getState().waypoints).toHaveLength(1);
  expect(checkButton()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'clear', exact: true }));
  expect(usePlanner.getState()).toMatchObject({ waypoints: [], endpoints: [], computed: null });
});

it('runs a queued automatic scan once after an active audit finishes, using the latest departure', async () => {
  usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  let finishAudit;
  analyzeInBrowser.mockReturnValueOnce(new Promise(resolve => { finishAudit = resolve; }));
  scanDepartures.mockResolvedValue({ candidates: [], best_index: null });
  render(<Planner />);
  fireEvent.click(checkButton());
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalledOnce());
  act(() => usePlanner.getState().patch({ autoScan: true }));
  changeDate('2026-09-16');
  expect(scanDepartures).not.toHaveBeenCalled();
  await act(async () => finishAudit({ snapshotId: 'checked' }));
  await waitFor(() => expect(scanDepartures).toHaveBeenCalledOnce());
  expect(usePlanner.getState().autoScan).toBe(false);
  expect(Date.parse(scanDepartures.mock.calls[0][1][0])).toBe(Date.parse(localDateTimeToIso(usePlanner.getState().departureLocal)));
  act(() => usePlanner.getState().patch({ name: 'Updated passage' }));
  expect(scanDepartures).toHaveBeenCalledOnce();
});

it('fits a restored or newly computed route without recentering on unrelated renders', async () => {
  render(<Planner />);
  expect(mapEvents.fitBounds).toHaveBeenCalledOnce();
  await compute();
  expect(mapEvents.fitBounds).toHaveBeenCalledTimes(2);
  act(() => usePlanner.getState().patch({ name: 'Renamed passage' }));
  expect(mapEvents.fitBounds).toHaveBeenCalledTimes(2);
});

it('imports GPX into the draft and fits the imported route without running an audit', async () => {
  usePlanner.setState({ mode: 'draw' });
  const view = render(<Planner />);
  const input = view.container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [{ text: async () =>
    '<gpx><rte><name>Imported passage</name><rtept lat="50.5" lon="-1.5"/><rtept lat="51" lon="-2"/></rte></gpx>' }] } });
  await waitFor(() => expect(usePlanner.getState().name).toBe('Imported passage'));
  expect(usePlanner.getState().waypoints).toEqual([{ lat: 50.5, lng: -1.5 }, { lat: 51, lng: -2 }]);
  expect(mapEvents.fitBounds).toHaveBeenCalled();
  expect(input.value).toBe('');
  expect(checkButton()).toBeEnabled();
  expect(analyzeInBrowser).not.toHaveBeenCalled();
});

it('keeps partial departure times local to the field and restores the valid time on blur', () => {
  render(<Planner />);
  const input = screen.getByLabelText('Departure time, 24-hour clock');
  fireEvent.change(input, { target: { value: '2' } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(usePlanner.getState().departureLocal).toBe('2026-09-15T08:00');
  fireEvent.blur(input);
  expect(input).toHaveValue('08:00');
  fireEvent.change(input, { target: { value: '23:45' } });
  expect(usePlanner.getState().departureLocal).toBe('2026-09-15T23:45');
  changeDate('2026-09-16');
  expect(usePlanner.getState().departureLocal).toBe('2026-09-16T23:45');
});
