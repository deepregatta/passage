// A change from the page's own controls while an action runs: the boat, the
// percent of polar and the Typical / Cautious ranking, each during Compute, a
// departure comparison and a refinement. Nothing may throw or log an error, and the
// outcome is the stale-input rule's: a result made for other inputs is dropped (and
// a late one never shown), one the change does not concern is kept. The ranking is
// a view over a comparison, never an input, so it never stops or drops anything.
// What other files already hold (percent in compute mode while a comparison or a
// refinement runs) is in plannerScanStop.test.jsx and plannerRefine.test.jsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, rankCandidates, refinementDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { refineHeld, runRefineJob, runScanJob, ScanCancelledError } from '../src/lib/scanRunner.js';
import { fmtLocalTime, toLocalDateTimeValue } from '../src/lib/format.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));
const page = vi.hoisted(() => ({ runs: { weather: { layer: 'weather', run_id: 'w1' } } }));
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
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({ describe: () => page.runs }) }));
vi.mock('@deepweather/engine', async (original) => ({ ...await original(), computeRoute: vi.fn() }));
vi.mock('../src/lib/scanRunner.js', async (original) => ({
  ...await original(), runScanJob: vi.fn(), runRefineJob: vi.fn(), refineHeld: vi.fn(), releaseRefinable: vi.fn(),
}));

const H = 3600_000;
const START = Date.parse('2026-09-15T06:00:00Z');
const at = (h) => new Date(START + h * H).toISOString().replace(/\.\d{3}Z$/, 'Z');
const STALE = 'Comparison stopped: the route or departure changed. Compare again.';

// Four 6-hourly times, all within the limits: the main forecast prefers the first, the scenarios the second.
const SPECS = [
  { worst_ratio: 0.2, max_fraction: 0.3, max_members: { exceed: 9, total: 31 } },
  { worst_ratio: 0.6, max_fraction: 0, max_members: { exceed: 0, total: 31 } },
  { worst_ratio: 0.22, max_fraction: 0.32, max_members: { exceed: 10, total: 31 } },
  { worst_ratio: 0.9, max_fraction: 0.03, max_members: { exceed: 1, total: 31 } },
];
const candidate = (utc, spec) => ({
  departure_utc: utc, verdict: 'within', passage_h: 2, ensemble_covered: true, max_fraction: null, max_members: null,
  driver_summary: null, arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0,
  expected_hours_over_limit: 0, ...spec,
});
const COARSE = [0, 6, 12, 18].map((h, i) => candidate(at(h), SPECS[i]));
const T0 = COARSE[0].departure_utc;
const T1 = COARSE[1].departure_utc;
const routed = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15, arrival_utc: new Date(Date.parse(departureUtc) + 2 * H).toISOString(),
});
const scanOut = (rerouted) => ({
  scan: { candidates: COARSE, best_index: 0, skipped: [] },
  routes: rerouted ? Object.fromEntries(COARSE.map((c) => [c.departure_utc, routed(c.departure_utc)])) : {},
  notes: [], currents: null, rerouted, requested: 21, scanId: 5, forecastRuns: page.runs,
  dateWindow: { startDate: '2026-09-15', endDate: '2026-09-21' },
});
// The refinement adds the times the engine says it would add; they exceed, so the marks stay where they were.
const ADDED = refinementDepartures({ candidates: COARSE, skipped: [], dateWindow: scanOut(true).dateWindow }).departures;
const refinedOut = () => ({
  scan: { candidates: [...COARSE, ...ADDED.map((utc) => candidate(utc, { verdict: 'exceeds', worst_ratio: 1.4, max_fraction: 0.9, max_members: { exceed: 28, total: 31 } }))]
    .sort((a, b) => Date.parse(a.departure_utc) - Date.parse(b.departure_utc)), best_index: 0, skipped: [] },
  routes: Object.fromEntries(ADDED.map((utc) => [utc, routed(utc)])),
  notes: [], currents: null, added: ADDED, around: [T0], requested: ADDED.length,
});

const computeButton = () => screen.getByRole('button', { name: /^(Compute route|Computing route…)$/ });
const scanButton = () => screen.getByRole('button', { name: /^(Compare departure times \(next 5 days\)|Comparing departure times…)$/ });
const refineButton = () => screen.getByRole('button', { name: /^(Refine around the least-exposure times|Refining…)$/ });
const comparison = () => screen.queryByRole('region', { name: 'Departure comparison' });
const toggle = (name) => within(comparison()).getByRole('button', { name });
const cell = (utc) => within(comparison()).getAllByRole('button').find((b) => b.title?.startsWith(fmtLocalTime(utc)));
const glyph = (utc) => cell(utc).querySelector('[aria-hidden]').textContent.trim();
const summary = () => screen.queryByText('12.3 nm');
const percentInput = () => screen.getByRole('spinbutton', { name: 'Percent of polar' });
const changeBoat = () => fireEvent.click(screen.getByText('Other boat'));
const changePercent = () => fireEvent.change(percentInput(), { target: { value: '90' } });
// The boat and the percent have no control in draw mode (the draw page has its own speeds),
// so a draft that carries them there is written to the store the controls write to.
const changeBoatInStore = () => act(() => usePlanner.getState().patch({ polarId: 'other-boat', polarLabel: 'Other boat' }));
const changePercentInStore = () => act(() => usePlanner.getState().patch({ polarPercent: 90 }));
const nothingShown = () => {
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/recompute the route/)).not.toBeInTheDocument();
};

let errors;
let scanJob;
let refineJob;
let routing;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.clear();
  page.runs = { weather: { layer: 'weather', run_id: 'w1' } };
  usePlanner.getState().reset();
  usePlanner.setState({ rankMode: 'typical', mode: 'compute', polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200',
    departureLocal: toLocalDateTimeValue(T0), endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits, language: 'en', loadConfig: vi.fn(), openSnapshot: vi.fn() });
  computeRoute.mockImplementation(({ departureUtc }) => routed(departureUtc));
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 48 });
  refineHeld.mockImplementation((id) => id === 5);
  // A comparison that ends when stopped (as the real runner does), unless a test asks for a late result.
  runScanJob.mockImplementation((request, options) => new Promise((resolve, reject) => {
    scanJob = { request, options, resolve };
    if (!scanJob.late) options.signal.addEventListener('abort', () => reject(new ScanCancelledError()));
  }));
  runRefineJob.mockImplementation((scanId, options) => new Promise((resolve, reject) => {
    refineJob = { scanId, options, resolve };
    options.signal.addEventListener('abort', () => reject(new ScanCancelledError()));
  }));
});
afterEach(() => {
  // No throw reached React's error log, and nothing else logged an error (act warnings included).
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
  vi.useRealTimers();
});

/** Hold Compute at its forecast read: `routing.resolve()` lets it carry on. */
function holdCompute() {
  loadRoutingInputs.mockImplementation(() => new Promise((resolve) => { routing = { resolve: () => resolve({ notes: [], maxHours: 48 }) }; }));
}
async function startCompute() {
  fireEvent.click(computeButton());
  await waitFor(() => expect(loadRoutingInputs).toHaveBeenCalled());
}
/** Compute mode compares a computed route: compute it first, as the page asks. */
async function computeFirst() {
  if (usePlanner.getState().mode !== 'compute') return;
  fireEvent.click(computeButton());
  await waitFor(() => expect(usePlanner.getState().computed).not.toBeNull());
}
async function compareNow(out = scanOut(true)) {
  await computeFirst();
  fireEvent.click(scanButton());
  await waitFor(() => expect(runScanJob).toHaveBeenCalled());
  await act(async () => scanJob.resolve(out));
  await screen.findByRole('region', { name: 'Departure comparison' });
}
async function startScan() {
  await computeFirst();
  fireEvent.click(scanButton());
  await waitFor(() => expect(runScanJob).toHaveBeenCalled());
}
async function startRefine() {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
}
const drawMode = () => usePlanner.setState({ mode: 'draw', endpoints: [], waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });

it('has two rankings that disagree about the fixture (precondition of the toggle tests)', () => {
  expect(rankCandidates(COARSE, { mode: 'typical' }).best_index).toBe(0);
  expect(rankCandidates(COARSE, { mode: 'cautious' }).best_index).toBe(1);
  expect(ADDED.length).toBeGreaterThan(0);
});

// ---- Compute running -------------------------------------------------------------------------

it.each([['boat', changeBoat], ['percent of polar', changePercent]])(
  'drops a route still computing when the %s changes: no route, no error, no notice, and Compute is ready again',
  async (_what, change) => {
    render(<Planner />);
    holdCompute();
    await startCompute();
    expect(computeButton()).toHaveTextContent('Computing route…');
    change();
    await act(async () => routing.resolve());
    await waitFor(() => expect(computeButton()).toHaveTextContent('Compute route'));
    expect(computeRoute).not.toHaveBeenCalled();
    expect(summary()).not.toBeInTheDocument();
    expect(usePlanner.getState().computed).toBeNull();
    expect(computeButton()).toBeEnabled();
    // The late result is dropped without a message: the sailor made the change, and Compute is idle again.
    nothingShown();
  },
);

it('keeps the route when the ranking toggle changes while Compute runs, and the comparison on show is ranked by the new choice', async () => {
  render(<Planner />);
  await compareNow();
  expect(glyph(T0)).toBe('◎');
  const held = usePlanner.getState().scan;
  holdCompute();
  await startCompute();
  fireEvent.click(toggle('Cautious'));
  expect(glyph(T1)).toBe('◎');
  await act(async () => routing.resolve());
  await waitFor(() => expect(summary()).toBeInTheDocument());
  expect(usePlanner.getState().computed.route).toBeTruthy();
  expect(usePlanner.getState().scan).toBe(held);
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'true');
  expect(glyph(T1)).toBe('◎');
  expect(runScanJob).toHaveBeenCalledTimes(1);
  nothingShown();
});

// ---- Comparison running ----------------------------------------------------------------------

it('stops a compute-mode comparison when the boat changes, and never shows its late result', async () => {
  render(<Planner />);
  runScanJob.mockImplementation((request, options) => new Promise((resolve) => { scanJob = { request, options, resolve }; }));
  await startScan();
  changeBoat();
  expect(scanJob.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText(STALE)).toBeInTheDocument());
  await act(async () => scanJob.resolve(scanOut(true)));
  expect(comparison()).toBeNull();
  expect(usePlanner.getState().scan).toBeNull();
  // idle again; the boat change also dropped the computed route, so Compute is what is offered
  expect(scanButton()).not.toHaveTextContent('Comparing');
  expect(computeButton()).toBeEnabled();
  expect(screen.getByText(STALE)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each([['boat', changeBoatInStore], ['percent of polar', changePercentInStore]])(
  'keeps a drawn-route comparison running when the %s changes, and shows its result (a drawn route does not use it)',
  async (_what, change) => {
    drawMode();
    render(<Planner />);
    await startScan();
    expect(scanJob.request).toMatchObject({ mode: 'draw' });
    change();
    expect(scanJob.options.signal.aborted).toBe(false);
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    await act(async () => scanJob.resolve(scanOut(false)));
    await screen.findByRole('region', { name: 'Departure comparison' });
    expect(usePlanner.getState().scan).toMatchObject({ rerouted: false, anchorMs: START });
    expect(glyph(T0)).toBe('◎');
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    nothingShown();
  },
);

it('keeps a running comparison when the ranking choice changes (the toggle is not on screen yet), and ranks its result by it', async () => {
  render(<Planner />);
  await startScan();
  expect(comparison()).toBeNull();
  // The control is not rendered until a comparison is on show; it writes this store field.
  act(() => usePlanner.getState().patch({ rankMode: 'cautious' }));
  expect(scanJob.options.signal.aborted).toBe(false);
  await act(async () => scanJob.resolve(scanOut(true)));
  await screen.findByRole('region', { name: 'Departure comparison' });
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'true');
  expect(glyph(T1)).toBe('◎');
  expect(glyph(T0)).not.toContain('◎');
  expect(usePlanner.getState().scan).toMatchObject({ requested: 21 });
  expect(screen.queryByText(STALE)).not.toBeInTheDocument();
  nothingShown();
});

// ---- Refinement running ----------------------------------------------------------------------

it('stops a compute-mode refinement when the boat changes: the comparison goes with it and the late result is never shown', async () => {
  render(<Planner />);
  await compareNow();
  runRefineJob.mockImplementation((scanId, options) => new Promise((resolve) => { refineJob = { scanId, options, resolve }; }));
  await startRefine();
  changeBoat();
  expect(refineJob.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText(STALE)).toBeInTheDocument());
  await act(async () => refineJob.resolve(refinedOut()));
  expect(comparison()).toBeNull();
  expect(usePlanner.getState().scan).toBeNull();
  expect(screen.getByText(STALE)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each([['boat', changeBoatInStore], ['percent of polar', changePercentInStore]])(
  'keeps a drawn-route refinement running when the %s changes, and merges its result',
  async (_what, change) => {
    drawMode();
    render(<Planner />);
    await compareNow(scanOut(false));
    await startRefine();
    change();
    expect(refineJob.options.signal.aborted).toBe(false);
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    await act(async () => refineJob.resolve(refinedOut()));
    await waitFor(() => expect(usePlanner.getState().scan.refined).toEqual({ departures: ADDED, around: [T0] }));
    expect(usePlanner.getState().scan.candidates).toHaveLength(COARSE.length + ADDED.length);
    expect(within(comparison()).getAllByTestId('refined-row').length).toBeGreaterThan(0);
    expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    nothingShown();
  },
);

it('re-ranks the comparison when the toggle changes while a refinement runs, and the refined result lands under the new choice', async () => {
  render(<Planner />);
  await compareNow();
  await startRefine();
  fireEvent.click(toggle('Cautious'));
  expect(refineJob.options.signal.aborted).toBe(false);
  expect(glyph(T1)).toBe('◎');
  await act(async () => refineJob.resolve(refinedOut()));
  await waitFor(() => expect(usePlanner.getState().scan.refined).not.toBeNull());
  expect(within(comparison()).getAllByTestId('refined-row').length).toBeGreaterThan(0);
  expect(toggle('Cautious')).toHaveAttribute('aria-pressed', 'true');
  expect(glyph(T1)).toBe('◎');
  expect(glyph(T0)).not.toContain('◎');
  expect(screen.queryByText(STALE)).not.toBeInTheDocument();
  nothingShown();
});
