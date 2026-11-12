import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { candidateDepartures, computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import LimitsDrawer from '../src/components/LimitsDrawer.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, saveRoute, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../src/lib/format.js';
import limits from '../../config/profiles/default-limits.json';
import { auditStore, DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));

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
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
  prepareAnalysisInputs: vi.fn(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] })),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(), computeRoute: vi.fn(), scanDepartures: vi.fn(),
}));

const computeButton = () => screen.getByRole('button', { name: /^(Compute route|Computing route…)$/ });
const checkButton = () => screen.getByRole('button', { name: /^(Check this passage|Checking this passage…)$/ });
const scanButton = () => screen.getByRole('button', { name: 'Compare departure times (next 5 days)' });
const summary = () => screen.queryByText('12.3 nm');
const changeDate = (value = '2026-09-16') => fireEvent.change(screen.getByLabelText('Departure date'), { target: { value } });
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
  // A departure in the past or beyond the forecast is refused, so pin the clock just before it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200', departureLocal: '2026-09-15T08:00',
    endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120 });
  computeRoute.mockImplementation(({ departureUtc }) => result(departureUtc));
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked' });
  prepareAnalysisInputs.mockImplementation(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] }));
});

afterEach(() => vi.useRealTimers());

it.each([2, -2, 0])('carries real routed timing through Compute, Check, Scan and candidate Check with %s kt current', async (along) => {
  vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
  const engine = await vi.importActual('@deepweather/engine');
  const inputs = routingInputs(along);
  const store = auditStore(engine, inputs.currentGrid);
  useApp.setState({ profileDefaults: limits });
  usePlanner.setState({ departureLocal: toLocalDateTimeValue(DEPARTURE),
    endpoints: [inputs.start, inputs.finish].map(({ lat, lon }) => ({ lat, lng: lon })) });
  loadRoutingInputs.mockResolvedValue(inputs);
  computeRoute.mockImplementation(engine.computeRoute);
  scanDepartures.mockImplementation((options, ...rest) => engine.scanDepartures({ ...options, store }, ...rest));
  const audits = [];
  analyzeInBrowser.mockImplementation(async (options) => {
    const result = await engine.runAnalysis({ ...options, store });
    audits.push(result.findings);
    return { snapshotId: result.findings.snapshot_id };
  });
  render(<Planner />);
  fireEvent.click(computeButton());
  await waitFor(() => expect(usePlanner.getState().computed?.route.timing.basis).toBe('routed'));
  const routed = usePlanner.getState().computed;
  fireEvent.click(checkButton());
  await waitFor(() => expect(useApp.getState().openSnapshot).toHaveBeenCalledOnce());
  expect(audits[0].legs.at(-1).eta_range.nominal).toBe(routed.arrival_utc);
  fireEvent.click(scanButton());
  const region = await screen.findByRole('region', { name: 'Departure comparison' });
  const scan = usePlanner.getState().scan;
  expect(scan.skipped).toEqual([]);
  expect(scan.candidates.map(c => c.passage_h)).toEqual(scan.candidates.map(c => scan.routes[c.departure_utc].duration_h));
  fireEvent.click(within(region).getAllByTitle(/ local time \(/)[0]);
  await waitFor(() => expect(audits).toHaveLength(2));
  expect(audits[1].legs.at(-1).eta_range.nominal).toBe(usePlanner.getState().computed.arrival_utc);
  expect(saveRoute.mock.lastCall[0].timing).toEqual(usePlanner.getState().computed.route.timing);
});

it.each([
  ['prepared', 'the routing area', {}],
  ['tiles', 'only a corridor', { lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3, u_kt: Array(18).fill(2), v_kt: Array(18).fill(0) }],
])('Compute, its Check and a computed scan use %s currents when the prepared grid covers %s', async (source, _, extra) => {
  vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
  const engine = await vi.importActual('@deepweather/engine');
  const inputs = routingInputs(1);
  const store = auditStore(engine, inputs.currentGrid);
  const prepared = { ...routingInputs(2).currentGrid, run_id: 'prepared', under_resolved_note: 'stride-subsampled x2 from native', ...extra };
  const preparedCurrent = { currentGrid: prepared, currentGridProvenance: { source: 'prepared-artifact', layer: 'currents', model: 'Synthetic current', run_id: 'prepared' } };
  usePlanner.setState({ departureLocal: toLocalDateTimeValue(DEPARTURE),
    endpoints: [inputs.start, inputs.finish].map(({ lat, lon }) => ({ lat, lng: lon })) });
  loadRoutingInputs.mockImplementation(async ({ prepared: loadPrepared }) => ({ ...inputs, ...(loadPrepared ? { preparedCurrent } : {}) }));
  prepareAnalysisInputs.mockImplementation(async draft => ({ ...draft, store, tileRuns: {}, inputRecords: [], ...preparedCurrent }));
  computeRoute.mockImplementation(engine.computeRoute);
  scanDepartures.mockImplementation((options, ...rest) => engine.scanDepartures({ ...options, store }, ...rest));
  const audits = [];
  analyzeInBrowser.mockImplementation(async (options) => {
    const result = await engine.runAnalysis({ ...options, store });
    audits.push(result.findings);
    return { snapshotId: result.findings.snapshot_id };
  });
  const currents = (records) => records.find(x => x.layer === 'currents');
  render(<Planner />);
  fireEvent.click(computeButton());
  await waitFor(() => expect(usePlanner.getState().computed?.route.timing.basis).toBe('routed'));
  const routed = usePlanner.getState().computed;
  // 5 kt boat plus 1 kt (tiles) or 2 kt (prepared) of current along the route
  expect(routed.avg_sog_kt).toBeCloseTo(source === 'prepared' ? 7 : 6, 1);
  expect(routed.notes).toEqual([]); // never the prepared grid's English factory note
  // The corridor is tried on the prepared grid, meets a gap and is routed once more on tiles.
  expect(computeRoute).toHaveBeenCalledTimes(source === 'prepared' ? 1 : 2);
  expect(screen.getByTestId('route-currents')).toHaveTextContent(`Currents · ${source === 'prepared' ? 'Synthetic current' : 'Copernicus global ocean currents'}`);
  fireEvent.click(checkButton());
  await waitFor(() => expect(audits).toHaveLength(1));
  expect(currents(audits[0].inputs.forecast_tiles)).toMatchObject({ current_source: source, run_id: source === 'prepared' ? 'prepared' : inputs.currentGrid.run_id });
  computeRoute.mockClear();
  fireEvent.click(scanButton());
  await screen.findByRole('region', { name: 'Departure comparison' });
  const scan = usePlanner.getState().scan;
  // Prepared: every candidate once. Corridor: the first candidate meets the gap, then every candidate on tiles.
  const candidates = candidateDepartures(Date.parse(DEPARTURE), 120, 6).length;
  expect(computeRoute).toHaveBeenCalledTimes(source === 'prepared' ? candidates : candidates + 1);
  // One source for every candidate's route and audit: this prepared grid runs to 30 July, past the whole scan.
  expect(currents(scan.input_records).current_source).toBe(source);
  expect(Object.values(scan.routes).every(r => r.avg_sog_kt === Object.values(scan.routes)[0].avg_sog_kt)).toBe(true);
});

it('disables Check and Scan when real routing cannot arrive within the horizon', async () => {
  vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
  const engine = await vi.importActual('@deepweather/engine');
  usePlanner.setState({ departureLocal: toLocalDateTimeValue(DEPARTURE) });
  loadRoutingInputs.mockResolvedValue(routingInputs(0, 0.1));
  computeRoute.mockImplementation(engine.computeRoute);
  render(<Planner />);
  fireEvent.click(computeButton());
  await screen.findByText(/No route found within 0.1 h/);
  noSummary();
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
  usePlanner.setState({ departureLocal: '2026-09-16T08:00' });
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
  fireEvent.click(within(region).getAllByTitle(/ local time \(/)[0]);
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
  expect(summary()).toBeInTheDocument();
  expect(usePlanner.getState().departureLocal).toBe(toLocalDateTimeValue(departure));
  expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe(departure);
  expect(saveRoute).toHaveBeenCalledWith({ ...usePlanner.getState().computed.route, passage_id: usePlanner.getState().passageId, name: 'My passage' });
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
  // Scan slots round up to a six-hour UTC boundary, independent of local time.
  const selectedMs = Date.parse(localDateTimeToIso(usePlanner.getState().departureLocal));
  const firstCandidateMs = Date.parse(scanDepartures.mock.calls[0][1][0]);
  expect(firstCandidateMs).toBeGreaterThanOrEqual(selectedMs);
  expect(firstCandidateMs).toBeLessThan(selectedMs + 6 * 3600_000);
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

it('keeps partial departure times local to the field until they can be read', () => {
  render(<Planner />);
  const input = screen.getByLabelText('Departure time, 24-hour clock');
  fireEvent.change(input, { target: { value: '2' } });
  expect(usePlanner.getState().departureLocal).toBe('2026-09-15T08:00');
  fireEvent.blur(input);
  expect(input).toHaveValue('02:00');
  expect(usePlanner.getState().departureLocal).toBe('2026-09-15T02:00');
  fireEvent.change(input, { target: { value: '23:45' } });
  expect(usePlanner.getState().departureLocal).toBe('2026-09-15T23:45');
  changeDate('2026-09-16');
  expect(usePlanner.getState().departureLocal).toBe('2026-09-16T23:45');
});

it.each(['audit', 'scan'])('recovers malformed or blocked storage for %s', async (action) => {
  localStorage.setItem('deepweather.profile-draft', '{broken');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  scanDepartures.mockResolvedValue({ candidates: [] });
  render(<Planner />);
  await compute();
  fireEvent.click(action === 'audit' ? checkButton() : scanButton());
  const operation = action === 'audit' ? analyzeInBrowser : scanDepartures;
  await waitFor(() => expect(operation).toHaveBeenCalled());
  expect(operation.mock.calls[0][0].profile).toEqual(limits);
});

it.each(['audit', 'scan'])('uses the visible limits after a failed persistence write for %s', async (action) => {
  localStorage.setItem('deepweather.profile-draft', JSON.stringify(limits));
  scanDepartures.mockResolvedValue({ candidates: [] });
  render(<><Planner /><LimitsDrawer /></>);
  await compute();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  fireEvent.change(screen.getByLabelText(/Max gusts/), { target: { value: '31' } });
  expect(screen.getByLabelText(/Max gusts/)).toHaveValue(31);
  expect(JSON.parse(localStorage.getItem('deepweather.profile-draft')).max_gust_kt).toBe(28);
  fireEvent.click(action === 'audit' ? checkButton() : scanButton());
  const operation = action === 'audit' ? analyzeInBrowser : scanDepartures;
  await waitFor(() => expect(operation).toHaveBeenCalled());
  expect(operation.mock.calls[0][0].profile.max_gust_kt).toBe(31);
});


it.each(['audit', 'scan'])('pins the visible profile while %s discovery is running', async action => {
  useApp.setState({ limits: structuredClone(limits) });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  prepareAnalysisInputs.mockImplementation(async draft => { await held; return { ...draft, store: {}, tileRuns: {}, inputRecords: [] }; });
  scanDepartures.mockResolvedValue({ candidates: [] });
  render(<Planner />);
  await compute();
  fireEvent.click(action === 'audit' ? checkButton() : scanButton());
  await waitFor(() => expect(prepareAnalysisInputs).toHaveBeenCalledOnce());
  act(() => useApp.getState().updateLimit(['max_gust_kt'], 19));
  release();
  const operation = action === 'audit' ? analyzeInBrowser : scanDepartures;
  await waitFor(() => expect(operation).toHaveBeenCalledOnce());
  expect(operation.mock.calls[0][0].profile.max_gust_kt).toBe(28);
  expect(useApp.getState().limits.max_gust_kt).toBe(19);
});

// Percent of polar: a user setting that routes Compute and Scan and invalidates a result when it changes.
const percentInput = () => screen.getByRole('spinbutton', { name: 'Percent of polar' });
const setPercent = (value) => fireEvent.change(percentInput(), { target: { value } });
const scaledResult = ({ departureUtc, polarScaling }) => {
  const base = result(departureUtc);
  return { ...base, route: { ...base.route, provenance: { routing_request: { polar_scaling: polarScaling } } } };
};

it('shows the percentage beside the boat, 100 by default, and routes Compute with it', async () => {
  computeRoute.mockImplementation(scaledResult);
  render(<Planner />);
  expect(percentInput()).toHaveValue(100);
  expect(percentInput()).toHaveAttribute('aria-invalid', 'false');
  await compute();
  expect(computeRoute.mock.lastCall[0].polarScaling).toBe(1);
  expect(screen.queryByText(/^Routed at/)).not.toBeInTheDocument();
  setPercent('90');
  noSummary();
  expect(screen.getByText('Boat speed changed — recompute the route')).toBeInTheDocument();
  await compute();
  expect(computeRoute.mock.lastCall[0].polarScaling).toBe(0.9);
  expect(screen.getByText('Routed at 90% of the boat polar speeds')).toBeInTheDocument();
  expect(JSON.parse(usePlanner.getState().computed.inputKey)).toHaveLength(4);
});

it.each(['', '49', '121', '0', '-10', '90.5'])('does not route with the percentage "%s"', async (value) => {
  render(<Planner />);
  setPercent(value);
  expect(percentInput()).toHaveAttribute('aria-invalid', 'true');
  expect(computeButton()).toBeDisabled();
  expect(screen.getAllByText('Enter a percent of polar from 50 to 120.').length).toBeGreaterThan(0);
  fireEvent.click(computeButton());
  expect(loadRoutingInputs).not.toHaveBeenCalled();
  expect(computeRoute).not.toHaveBeenCalled();
  setPercent('75');
  expect(percentInput()).toHaveAttribute('aria-invalid', 'false');
  expect(computeButton()).toBeEnabled();
});

it('rejects a restored result computed at another percentage, and still restores a stored three-element key at 100', async () => {
  let view = render(<Planner />);
  await compute();
  const saved = usePlanner.getState().computed;
  view.unmount();
  // The key stored by a version that had no percentage: exactly three elements.
  const legacyKey = JSON.stringify([[[50.5, -1.5], [50.6, -1.4]], 'sun-fast-3200', localDateTimeToIso('2026-09-15T08:00')]);
  expect(saved.inputKey).toBe(legacyKey);
  usePlanner.setState({ computed: { ...saved, inputKey: legacyKey } });
  view = render(<Planner />);
  expect(summary()).toBeInTheDocument();
  view.unmount();
  usePlanner.setState({ computed: saved, polarPercent: 90 });
  view = render(<Planner />);
  noSummary();
  expect(screen.getByText('Boat speed changed — recompute the route')).toBeInTheDocument();
  view.unmount();
  // A result computed at 90 % is not current at 100 %, and is current again at 90 %.
  usePlanner.setState({ computed: { ...saved, inputKey: legacyKey.replace(/\]$/, ',90]') }, polarPercent: 100 });
  view = render(<Planner />);
  noSummary();
  view.unmount();
  usePlanner.setState({ computed: { ...saved, inputKey: legacyKey.replace(/\]$/, ',90]') }, polarPercent: 90 });
  render(<Planner />);
  expect(summary()).toBeInTheDocument();
});

it('takes the default percentage from a stored draft that has none', async () => {
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 3, state: { passageId: 'saved', name: 'Old', nameAuto: false, polarId: 'old-boat' } }));
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState().polarPercent).toBe(100);
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 3, state: { passageId: 'saved', polarPercent: 85 } }));
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState().polarPercent).toBe(85);
});

it('routes every scan candidate with the percentage and keeps the picked time\'s route', async () => {
  computeRoute.mockImplementation(scaledResult);
  usePlanner.setState({ polarPercent: 90 });
  render(<Planner />);
  await compute();
  const departures = ['2026-09-15T12:00:00Z', '2026-09-15T18:00:00Z', '2026-09-16T00:00:00Z'];
  computeRoute.mockClear();
  scanDepartures.mockImplementation(async ({ routeFor }) => {
    for (const departure of departures) routeFor(departure);
    return { candidates: departures.map((departure_utc) => ({ departure_utc, verdict: 'within', passage_h: 2 })), best_index: 0 };
  });
  fireEvent.click(scanButton());
  const region = await screen.findByRole('region', { name: 'Departure comparison' });
  // Every candidate is routed once, in order, before the scan audits any (one current source for all).
  const anchor = localDateTimeToIso(usePlanner.getState().departureLocal);
  expect(computeRoute.mock.calls.map(([request]) => [request.departureUtc, request.polarScaling]))
    .toEqual(candidateDepartures(Date.parse(anchor), 120, 6).map((departure) => [departure, 0.9]));
  // The scan survives the percentage it was run for and is dropped when it changes.
  fireEvent.click(within(region).getAllByTitle(/ local time \(/)[1]);
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
  expect(usePlanner.getState().departureLocal).toBe(toLocalDateTimeValue(departures[1]));
  expect(usePlanner.getState().computed).not.toBeNull();
  expect(usePlanner.getState().computed.route.provenance.routing_request.polar_scaling).toBe(0.9);
  expect(summary()).toBeInTheDocument();
  expect(saveRoute).toHaveBeenCalledWith(expect.objectContaining({ route_id: 'computed', provenance: { routing_request: { polar_scaling: 0.9 } } }));
  expect(analyzeInBrowser.mock.calls[0][0].departureUtc).toBe(departures[1]);
  expect(usePlanner.getState().scan).not.toBeNull();
  setPercent('95');
  expect(usePlanner.getState().scan).toBeNull();
});
