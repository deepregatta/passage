import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: ({ onSelect }) =>
  <button onClick={() => onSelect({ polar_id: 'other-boat', label: 'Other boat' })}>Other boat</button>,
}));
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
  prepareAnalysisInputs: vi.fn(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] })),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(), computeRoute: vi.fn(), scanDepartures: vi.fn(),
}));

const NOW = '2026-09-10T09:00:00Z';
const computeButton = () => screen.getByRole('button', { name: /^(Compute route|Computing route…)$/ });
const checkButton = () => screen.getByRole('button', { name: /^(Check this passage|Checking this passage…)$/ });
const scanButton = () => screen.getByRole('button', { name: /^(Compare departure times \(next 5 days\)|Comparing departure times…)$/ });
const summary = () => screen.queryByText('12.3 nm');
const dateInput = () => screen.getByLabelText('Departure date');
const timeInput = () => screen.getByLabelText('Departure time, 24-hour clock');
const changeDate = (value) => fireEvent.change(dateInput(), { target: { value } });
const result = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'boat-a' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const near = (button) => button.parentElement;

async function compute() {
  fireEvent.click(computeButton());
  await waitFor(() => expect(summary()).toBeInTheDocument());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
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

it('shows Compute progress on the Compute button, in plain words, and leaves Check alone', async () => {
  let release;
  loadRoutingInputs.mockImplementationOnce(async ({ onProgress }) => {
    onProgress('loading forecast tiles');
    await new Promise((resolve) => { release = resolve; });
    return { notes: [], maxHours: 120 };
  });
  render(<Planner />);
  fireEvent.click(computeButton());
  expect(computeButton()).toHaveTextContent('Computing route…');
  expect(computeButton()).toBeDisabled();
  const status = within(near(computeButton())).getByText('Loading the forecast…');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(checkButton()).toHaveTextContent('Check this passage');
  expect(within(near(checkButton())).queryByText(/Loading the forecast/)).not.toBeInTheDocument();
  await act(async () => release());
  await waitFor(() => expect(summary()).toBeInTheDocument());
  expect(computeButton()).toHaveTextContent('Compute route');
});

it('gives visible feedback when Compute is run again on a computed route', async () => {
  render(<Planner />);
  await compute();
  expect(within(near(computeButton())).getByText('Route computed')).toBeInTheDocument();
  let release;
  loadRoutingInputs.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  fireEvent.click(computeButton());
  expect(computeButton()).toHaveTextContent('Computing route…');
  expect(within(near(computeButton())).queryByText('Route computed')).not.toBeInTheDocument();
  await act(async () => release({ notes: [], maxHours: 120 }));
  await waitFor(() => expect(summary()).toBeInTheDocument());
  expect(within(near(computeButton())).getByText('Route updated')).toBeInTheDocument();
});

it('reports a Compute failure next to Compute in plain words, with the raw message as technical detail', async () => {
  loadRoutingInputs.mockRejectedValueOnce(new Error('forecast fetch failed: HTTP 404 for latest.json'));
  render(<Planner />);
  fireEvent.click(computeButton());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The forecast could not be loaded. Check your connection and try again.');
  expect(alert).not.toHaveTextContent('latest.json');
  expect(near(computeButton()).contains(alert)).toBe(true);
  expect(near(checkButton()).contains(alert)).toBe(false);
  const details = within(near(computeButton())).getByText('Technical detail').closest('details');
  expect(details).toHaveTextContent('forecast fetch failed: HTTP 404 for latest.json');
  // Retry re-runs the action that failed
  fireEvent.click(within(near(computeButton())).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(summary()).toBeInTheDocument());
  expect(loadRoutingInputs).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps friendly failure messages as they are and maps a network error to plain language', async () => {
  loadRoutingInputs.mockRejectedValueOnce(new Error('No sea route found'));
  render(<Planner />);
  fireEvent.click(computeButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('No sea route found');
  expect(screen.queryByText('Technical detail')).not.toBeInTheDocument();
  loadRoutingInputs.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  fireEvent.click(within(near(computeButton())).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The forecast could not be loaded.'));
  expect(screen.getByText('Technical detail').closest('details')).toHaveTextContent('Failed to fetch');
});

it('offers Draw my route when boat polars are unavailable', async () => {
  loadRoutingInputs.mockRejectedValueOnce(new Error('Boat polars are unavailable right now. Use Draw my route instead.'));
  render(<Planner />);
  fireEvent.click(computeButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('Boat polars are unavailable right now.');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Draw my route' }));
  expect(usePlanner.getState().mode).toBe('draw');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('reports a Check failure under the Check button and a Scan failure under the scan button', async () => {
  await act(async () => { usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] }); });
  analyzeInBrowser.mockRejectedValueOnce(new Error('Snapshot write failed: HTTP 500'));
  render(<Planner />);
  fireEvent.click(checkButton());
  const alert = await screen.findByRole('alert');
  expect(near(checkButton()).contains(alert)).toBe(true);
  scanDepartures.mockRejectedValueOnce(new Error('Scan broke'));
  fireEvent.click(scanButton());
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Scan broke'));
  expect(near(scanButton()).contains(screen.getByRole('alert'))).toBe(true);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

// What analyzeInBrowser rejects with when the save fails (browserAnalysis.js saveError).
const saveFailure = (saveFailure, text) => Object.assign(new Error(text), { name: 'SnapshotSaveError', saveFailure });
it.each([
  ['storage-full', 'QuotaExceededError: The quota has been exceeded.', 'This check was not saved: this browser’s storage for this site is full, so nothing was stored. To free space, delete saved checks you no longer need in My passages.',
    'Cette vérification n’a pas été enregistrée\u00A0: l’espace de stockage de ce navigateur pour ce site est plein, rien n’a donc été enregistré. Pour libérer de la place, supprimez dans Mes traversées les vérifications enregistrées dont vous n’avez plus besoin.'],
  ['blocked', 'Snapshot snapshot_v2_0123456789abcdef is incomplete, legacy or conflicting. Snapshots are write-once.',
    'This check could not be saved: this browser already holds an earlier save of the same check that cannot be reopened, and saved checks are never overwritten. Nothing new was stored. A check on a newer forecast, or after a change to the route, departure or limits, can be saved normally.',
    'Cette vérification n’a pas pu être enregistrée\u00A0: ce navigateur contient déjà un enregistrement antérieur de la même vérification qui ne peut pas être rouvert, et les vérifications enregistrées ne sont jamais remplacées. Rien de nouveau n’a été enregistré. Une vérification sur une prévision plus récente, ou après une modification de la route, du départ ou des limites, pourra être enregistrée normalement.'],
  ['failed', 'This browser cannot store briefings (no IndexedDB)', 'This check was not saved in this browser, and nothing was stored.',
    'Cette vérification n’a pas été enregistrée dans ce navigateur, et rien n’a été enregistré.'],
])('says in plain words that a %s save stored nothing, in English and French, with the browser text only as detail', async (kind, raw, english, french) => {
  await act(async () => { usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] }); });
  analyzeInBrowser.mockRejectedValueOnce(saveFailure(kind, raw));
  const view = render(<div id="root"><Planner /></div>);
  fireEvent.click(checkButton());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(english);
  expect(alert).not.toHaveTextContent(raw);
  expect(near(checkButton()).contains(alert)).toBe(true);
  expect(within(near(checkButton())).getByText('Technical detail').closest('details')).toHaveTextContent(raw);
  expect(within(near(checkButton())).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  // the same failure on the French page
  view.unmount();
  useApp.setState({ language: 'fr' });
  const { LocalizedDocument } = await import('../src/i18n.js');
  analyzeInBrowser.mockRejectedValueOnce(saveFailure(kind, raw));
  render(<div id="root"><Planner /><LocalizedDocument language="fr" /></div>);
  fireEvent.click(screen.getByRole('button', { name: /^(Vérifier cette traversée|Check this passage)$/ }));
  const frAlert = await screen.findByRole('alert');
  // toHaveTextContent folds the no-break space before the colon into a space
  await waitFor(() => expect(frAlert).toHaveTextContent(french.replace(/\u00A0/g, ' ')));
  expect(frAlert).not.toHaveTextContent(raw);
});

it.each(['date', 'boat', 'mode'])('clears a failure when the %s it depended on changes', async (change) => {
  loadRoutingInputs.mockRejectedValueOnce(new Error('No sea route found'));
  render(<Planner />);
  fireEvent.click(computeButton());
  await screen.findByRole('alert');
  if (change === 'date') changeDate('2026-09-13');
  if (change === 'boat') fireEvent.click(screen.getByText('Other boat'));
  if (change === 'mode') fireEvent.click(screen.getByRole('tab', { name: 'Draw my route' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each([
  ['boat', () => fireEvent.click(screen.getByText('Other boat')), 'Boat changed — recompute the route'],
  ['departure', () => changeDate('2026-09-13'), 'Departure changed — recompute the route'],
  ['points', () => act(() => mapEvents.click({ latlng: { lat: 49, lng: -3 } })), 'Route points changed — recompute the route'],
])('says why the computed route disappeared when the %s changes', async (_what, change, message) => {
  render(<Planner />);
  await compute();
  change();
  expect(summary()).not.toBeInTheDocument();
  const note = within(near(computeButton())).getByText(message);
  expect(note.closest('[aria-live="polite"]')).not.toBeNull();
  // a recompute removes the explanation
  if (_what !== 'points') {
    await compute();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  }
});

const scanResult = (departure) => async ({ routeFor }) => {
  routeFor?.(departure);
  return { candidates: [{ departure_utc: departure, verdict: 'within', passage_h: 2 }], best_index: 0 };
};

it.each(['boat', 'date', 'time', 'endpoints', 'mode'])('drops the departure comparison when the %s it was run for changes', async (change) => {
  render(<Planner />);
  await compute();
  scanDepartures.mockImplementation(scanResult('2026-09-12T12:00:00Z'));
  fireEvent.click(scanButton());
  await screen.findByRole('region', { name: 'Departure comparison' });
  expect(screen.getByText(/Departure comparison ready/)).toBeInTheDocument();
  if (change === 'boat') fireEvent.click(screen.getByText('Other boat'));
  if (change === 'date') changeDate('2026-09-13');
  if (change === 'time') fireEvent.change(timeInput(), { target: { value: '09:00' } });
  if (change === 'endpoints') act(() => usePlanner.getState().patch({ endpoints: [{ lat: 50, lng: -1 }, { lat: 51, lng: -2 }] }));
  if (change === 'mode') fireEvent.click(screen.getByRole('tab', { name: 'Draw my route' }));
  expect(screen.queryByRole('region', { name: 'Departure comparison' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Departure comparison ready/)).not.toBeInTheDocument();
  expect(usePlanner.getState().scan).toBeNull();
});

it('keeps the comparison when a time from it is picked, even if the Check then fails', async () => {
  render(<Planner />);
  await compute();
  const departure = '2026-09-12T12:00:00Z';
  scanDepartures.mockImplementation(scanResult(departure));
  fireEvent.click(scanButton());
  const region = await screen.findByRole('region', { name: 'Departure comparison' });
  analyzeInBrowser.mockRejectedValueOnce(new Error('Snapshot write failed: HTTP 500'));
  fireEvent.click(within(region).getAllByTitle(/ local time \(/)[0]);
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('region', { name: 'Departure comparison' })).toContainElement(alert);
  expect(usePlanner.getState().scan).not.toBeNull();
  // moving off the compared times still invalidates it
  changeDate('2026-09-13');
  expect(screen.queryByRole('region', { name: 'Departure comparison' })).not.toBeInTheDocument();
});

it('starts without a boat and says why Compute is not available', async () => {
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', departureLocal: '2026-09-12T08:00',
    endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  expect(usePlanner.getState()).toMatchObject({ polarId: null, polarLabel: null });
  render(<Planner />);
  expect(computeButton()).toBeDisabled();
  const hint = within(near(computeButton())).getByText('Choose your boat first');
  expect(hint.closest('[aria-live="polite"]')).not.toBeNull();
  fireEvent.click(screen.getByText('Other boat'));
  expect(computeButton()).toBeEnabled();
  expect(screen.queryByText('Choose your boat first')).not.toBeInTheDocument();
});

it('blocks Compute, Scan and Check for a departure in the past, naming the reason, without routing', async () => {
  render(<Planner />);
  await compute();
  changeDate('2026-09-08');
  expect(computeButton()).toBeDisabled();
  expect(scanButton()).toBeDisabled();
  expect(checkButton()).toBeDisabled();
  expect(screen.getAllByText('Choose a departure that is not in the past').length).toBeGreaterThanOrEqual(2);
  expect(within(screen.getByRole('alert')).getByText('Choose a departure that is not in the past')).toBeInTheDocument();
  loadRoutingInputs.mockClear();
  fireEvent.click(computeButton());
  expect(loadRoutingInputs).not.toHaveBeenCalled();
  changeDate('2026-09-12');
  expect(computeButton()).toBeEnabled();
});

it('blocks a departure beyond the forecast and names the last date', () => {
  render(<Planner />);
  changeDate('2026-10-30');
  expect(computeButton()).toBeDisabled();
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(/^Choose a departure within the forecast, up to \w{3} \d{1,2} \w{3}$/);
  expect(alert.textContent.endsWith('Sep')).toBe(true);
});

it('limits the date picker to today and the forecast horizon and states the horizon', () => {
  render(<Planner />);
  expect(dateInput()).toHaveAttribute('min', '2026-09-10');
  expect(dateInput()).toHaveAttribute('max', '2026-09-19');
  expect(screen.getByText(/^Forecasts cover the next 9 days, up to \w{3} 19 Sep$/)).toBeInTheDocument();
});

it.each([['0830', '08:30'], ['08.30', '08:30'], ['8:30', '08:30'], ['1745', '17:45']])('reads %s as %s', (typed, expected) => {
  render(<Planner />);
  fireEvent.change(timeInput(), { target: { value: typed } });
  fireEvent.blur(timeInput());
  expect(timeInput()).toHaveValue(expected);
  expect(usePlanner.getState().departureLocal).toBe(`2026-09-12T${expected}`);
});

it('formats four typed digits into HH:mm straight away and reads 830 and 8 on blur', () => {
  render(<Planner />);
  fireEvent.change(timeInput(), { target: { value: '0915' } });
  expect(timeInput()).toHaveValue('09:15');
  expect(usePlanner.getState().departureLocal).toBe('2026-09-12T09:15');
  fireEvent.change(timeInput(), { target: { value: '830' } });
  expect(usePlanner.getState().departureLocal).toBe('2026-09-12T09:15');
  fireEvent.blur(timeInput());
  expect(timeInput()).toHaveValue('08:30');
  fireEvent.change(timeInput(), { target: { value: '8' } });
  fireEvent.blur(timeInput());
  expect(timeInput()).toHaveValue('08:00');
});

it('explains an invalid time instead of silently reverting, and blocks actions until it is fixed', async () => {
  render(<Planner />);
  await compute();
  fireEvent.change(timeInput(), { target: { value: '25:00' } });
  fireEvent.blur(timeInput());
  expect(timeInput()).toHaveValue('25:00');
  expect(timeInput()).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('Enter the time as HH:mm, for example 08:30.');
  expect(timeInput().getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  expect(computeButton()).toBeDisabled();
  expect(checkButton()).toBeDisabled();
  fireEvent.change(timeInput(), { target: { value: '0930' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(usePlanner.getState().departureLocal).toBe('2026-09-12T09:30');
  expect(computeButton()).toBeEnabled();
});

it('defaults a new draft to the next quarter hour', () => {
  vi.setSystemTime(new Date(2026, 8, 10, 10, 7, 30));
  usePlanner.getState().reset();
  expect(usePlanner.getState().departureLocal).toBe('2026-09-10T10:15');
  vi.setSystemTime(new Date(2026, 8, 10, 10, 30, 0));
  usePlanner.getState().reset();
  expect(usePlanner.getState().departureLocal).toBe('2026-09-10T10:30');
});
