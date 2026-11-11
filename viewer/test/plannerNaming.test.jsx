import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, saveRoute, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { userRouteName } from '../src/lib/passages.js';
import limits from '../../config/profiles/default-limits.json';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null, Rectangle: () => null,
  useMap: () => ({ fitBounds: vi.fn(), eachLayer: vi.fn(), on: vi.fn(), off: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
  prepareAnalysisInputs: vi.fn(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] })),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(), computeRoute: vi.fn(), scanDepartures: vi.fn(),
}));

const result = (departureUtc) => ({
  // the engine names a computed route "Start → Finish (computed)"
  route: { schema_version: 1, route_id: 'computed', name: 'Start → Finish (computed)', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'boat-a' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const nameInput = () => screen.getByRole('textbox', { name: 'Name' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'boat-a', polarLabel: 'Boat A', departureLocal: '2026-09-12T08:00',
    endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120 });
  computeRoute.mockImplementation(({ departureUtc }) => result(departureUtc));
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked' });
  prepareAnalysisInputs.mockImplementation(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] }));
  scanDepartures.mockResolvedValue({ candidates: [], best_index: null });
});
afterEach(() => vi.useRealTimers());

it('offers the Name field in Compute mode and saves the typed name with a computed route', async () => {
  render(<Planner />);
  fireEvent.change(nameInput(), { target: { value: 'Channel dash' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compute route' }));
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Check this passage' }));
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
  expect(saveRoute.mock.lastCall[0]).toMatchObject({ name: 'Channel dash', mode: 'computed', passage_id: usePlanner.getState().passageId });
  expect(analyzeInBrowser.mock.lastCall[0].route.name).toBe('Channel dash');
});

it('renaming does not discard the computed route', async () => {
  render(<Planner />);
  fireEvent.click(screen.getByRole('button', { name: 'Compute route' }));
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  fireEvent.change(nameInput(), { target: { value: 'Renamed' } });
  expect(screen.getByText('12.3 nm')).toBeInTheDocument();
  expect(usePlanner.getState().computed).not.toBeNull();
});

it('falls back to the default name when the field is emptied, and still names a time picked from a comparison', async () => {
  render(<Planner />);
  fireEvent.click(screen.getByRole('button', { name: 'Compute route' }));
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  fireEvent.change(nameInput(), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check this passage' }));
  await waitFor(() => expect(saveRoute).toHaveBeenCalled());
  expect(saveRoute.mock.lastCall[0].name).toBe('My passage');
  fireEvent.change(nameInput(), { target: { value: 'Picked' } });
  const departure = '2026-09-12T12:00:00Z';
  scanDepartures.mockImplementation(async ({ routeFor }) => {
    routeFor(departure);
    return { candidates: [{ departure_utc: departure, verdict: 'within', passage_h: 2 }], best_index: 0 };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare departure times (next 5 days)' }));
  const region = await screen.findByRole('region', { name: 'Departure comparison' });
  saveRoute.mockClear();
  fireEvent.click(region.querySelector('button[title]'));
  await waitFor(() => expect(saveRoute).toHaveBeenCalled());
  expect(saveRoute.mock.lastCall[0].name).toBe('Picked');
});

it('carries the typed name in Draw mode', async () => {
  usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  render(<Planner />);
  fireEvent.change(nameInput(), { target: { value: 'Drawn' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check this passage' }));
  await waitFor(() => expect(saveRoute).toHaveBeenCalled());
  expect(saveRoute.mock.lastCall[0].name).toBe('Drawn');
});

it.each([
  [{ mode: 'user', name: 'Channel dash' }, 'Channel dash'],
  [{ mode: 'computed', name: ' Dash ' }, 'Dash'],
  [{ mode: 'computed', name: 'Start → Finish (computed)' }, null],
  [{ mode: 'fixed', name: 'Cherbourg → Plymouth' }, null],
  [{ mode: 'user', name: '' }, null],
  [null, null],
])('uses a saved route name as the briefing title only when the sailor chose it: %j', (route, expected) => {
  expect(userRouteName(route)).toBe(expected);
});
