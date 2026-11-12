import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { QUOTE_TICK_MS } from '../src/pages/planner/useDownloadQuotes.js';
import { refineHeld } from '../src/lib/scanRunner.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));

// A store that has only manifests: the quote may read them and probe the cache, never a tile.
const fake = vi.hoisted(() => ({
  manifests: {},
  listed: null,
  // held tiles, as `${run id}/${layer}/${tile id}`
  cached: new Set(),
  checked: null,
  reads: vi.fn(),
  init: vi.fn(async () => {}),
  refresh: vi.fn(async () => []),
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(),
  prepareAnalysisInputs: vi.fn(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] })),
}));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({
  forecastStore: () => ({
    init: fake.init,
    manifestFor: (layer) => fake.manifests[layer] ?? null,
    listedLayers: () => fake.listed ?? Object.keys(fake.manifests),
    regionalLayerIds: () => [],
    hasTile: async (layer, tileId) => fake.cached.has(`${fake.manifests[layer]?.run_id}/${layer}/${tileId}`),
    refresh: fake.refresh,
    lastCheckedMs: () => fake.checked ?? Date.now(),
    getWindGrid: fake.reads, getCurrentGrid: fake.reads, getPointForecasts: fake.reads, fetchTile: fake.reads,
  }),
}));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(), computeRoute: vi.fn(), scanDepartures: vi.fn(),
}));
vi.mock('../src/lib/scanRunner.js', async (original) => ({ ...await original(), refineHeld: vi.fn() }));

const NOW = '2026-09-10T09:00:00Z';
const computeButton = () => screen.getByRole('button', { name: /^(Compute route|Computing route…)$/ });
const checkButton = () => screen.getByRole('button', { name: /^(Check this passage|Checking this passage…)$/ });
const scanButton = () => screen.getByRole('button', { name: /^(Compare departure times \(next 5 days\)|Comparing departure times…)$/ });
const MB = 1_000_000;

function manifest(layer, tiles, extra = {}) {
  return {
    schema_version: 1, run_id: `${layer}-20260910T00Z`, layer, model: layer, cycle: '2026-09-10T00:00Z', member_count: 1,
    resolution_deg: 0.25, horizon_h: 240, time_axes: {}, variables: [], tiling: { tile_deg: 10, path_template: `${layer}/{tile_id}.bin` },
    tiles: Object.fromEntries(Object.entries(tiles).map(([id, bytes]) => [id, { bytes, fnv64: '0' }])),
    totals: { tile_count: 0, bytes: 0 }, published_at: '2026-09-10T00:00:00Z', ...extra,
  };
}
const key = (layer, id) => `${layer}-20260910T00Z/${layer}/${id}`;
const result = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'boat-a' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const lineOf = (button) => button.parentElement.querySelector('p[id^="download-"]');
const compute = async () => {
  fireEvent.click(computeButton());
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.resetAllMocks();
  localStorage.clear();
  fake.manifests = {
    weather: manifest('weather', { N50W010: 9 * MB }),
    currents: manifest('currents', { N50W010: 3 * MB }),
    ensemble: manifest('ensemble', { N50W010: 1 * MB }),
  };
  fake.listed = null;
  fake.cached = new Set();
  fake.checked = null;
  fake.init.mockImplementation(async () => {});
  fake.refresh.mockImplementation(async () => []);
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

it('says under Compute how much it downloads, from the manifests alone', async () => {
  render(<Planner />);
  const line = await screen.findByText('Downloads up to 12 MB of forecast tiles');
  expect(line.parentElement).toBe(computeButton().parentElement);
  expect(computeButton()).toHaveAttribute('aria-describedby', line.id);
  // Check and Scan wait for a route to audit
  expect(lineOf(checkButton())).toBeNull();
  expect(lineOf(scanButton())).toBeNull();
  // quoting is not an action: no tile was read, no action ran
  expect(fake.reads).not.toHaveBeenCalled();
  expect(loadRoutingInputs).not.toHaveBeenCalled();
  expect(fake.init).toHaveBeenCalled();
});

it('adds lines under Scan and Check once there is a route to audit', async () => {
  render(<Planner />);
  await compute();
  await waitFor(() => expect(lineOf(checkButton())).not.toBeNull());
  // Check audits at the route's points: weather, ensemble and the current tiles it reads itself
  expect(lineOf(checkButton())).toHaveTextContent('Downloads up to 13 MB of forecast tiles');
  // a computed scan: Compute's grids and the audit layers over the route box
  expect(lineOf(scanButton())).toHaveTextContent('Downloads up to 13 MB of forecast tiles');
  expect(lineOf(computeButton())).toHaveTextContent('Downloads up to 12 MB of forecast tiles');
});

it('says "at least" when a layer the catalogue lists could not be quoted', async () => {
  fake.listed = ['weather', 'currents', 'ensemble', 'waves'];
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles'); // Compute reads only weather and currents
  await compute();
  await waitFor(() => expect(lineOf(checkButton())).toHaveTextContent('Downloads at least 13 MB of forecast tiles'));
  expect(lineOf(scanButton())).toHaveTextContent('Downloads at least 13 MB of forecast tiles');
});

it('says the tiles are already on the device when the cache holds all of them, and updates after an action', async () => {
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  // the action fetches (and so caches) its tiles
  loadRoutingInputs.mockImplementation(async () => {
    fake.cached.add(key('weather', 'N50W010'));
    fake.cached.add(key('currents', 'N50W010'));
    return { notes: [], maxHours: 120 };
  });
  await compute();
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Forecast tiles already on this device'));
  // Check still has the ensemble tile to fetch: 1 MB of the 13
  await waitFor(() => expect(lineOf(checkButton())).toHaveTextContent('Downloads up to 1.0 MB of forecast tiles'));
});

it('hides the lines while an action runs and brings them back, updated, when it ends', async () => {
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  let release;
  loadRoutingInputs.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  fireEvent.click(computeButton());
  await waitFor(() => expect(computeButton()).toBeDisabled());
  expect(screen.queryByText(/forecast tiles$/)).not.toBeInTheDocument();
  await act(async () => release({ notes: [], maxHours: 120 }));
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Downloads up to 12 MB'));
});

it('shows nothing without endpoints, while an action is blocked, or when no tile covers the route', async () => {
  usePlanner.setState({ endpoints: [] });
  const view = render(<Planner />);
  await act(async () => {});
  expect(screen.queryByText(/forecast tiles$/)).not.toBeInTheDocument();
  expect(fake.init).not.toHaveBeenCalled(); // nothing to quote: not even the manifests are loaded
  // blocked: no boat
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }], polarId: null }); });
  await act(async () => {});
  expect(screen.queryByText(/forecast tiles$/)).not.toBeInTheDocument();
  // blocked: a departure in the past
  await act(async () => { usePlanner.setState({ polarId: 'boat-a', departureLocal: '2026-09-01T08:00' }); });
  await act(async () => {});
  expect(screen.queryByText(/forecast tiles$/)).not.toBeInTheDocument();
  // no tile published for the area: unknown, not "already on this device"
  await act(async () => { usePlanner.setState({ departureLocal: '2026-09-12T08:00', endpoints: [{ lat: -30, lng: 100 }, { lat: -31, lng: 101 }] }); });
  await act(async () => {});
  expect(screen.queryByText(/forecast tiles/)).not.toBeInTheDocument();
  view.unmount();
});

it('recomputes when the endpoints or the mode change', async () => {
  fake.manifests.weather = manifest('weather', { N50W010: 9 * MB, N50E000: 2 * MB });
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  // the box now reaches the tile east of the 0° line
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: 0.5 }] }); });
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Downloads up to 14 MB'));
  // a drawn route has no Compute line, and its Check line is about the drawn points
  await act(async () => { usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] }); });
  await waitFor(() => expect(lineOf(checkButton())).toHaveTextContent('Downloads up to 13 MB'));
  expect(screen.queryByRole('button', { name: /Compute route/ })).not.toBeInTheDocument();
});

it('shows no line when the manifests cannot be loaded, and does not retry on every edit', async () => {
  fake.init.mockRejectedValue(new Error('offline'));
  render(<Planner />);
  await waitFor(() => expect(fake.init).toHaveBeenCalledTimes(1));
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.7, lng: -1.4 }] }); });
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.8, lng: -1.4 }] }); });
  expect(fake.init).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/forecast tiles$/)).not.toBeInTheDocument();
});

it('renders the lines in French', async () => {
  useApp.setState({ language: 'fr' });
  render(<div id="root"><Planner /><LocalizedDocument language="fr" /></div>);
  expect(await screen.findByText('Téléchargement : jusqu’à 12 Mo de tuiles de prévision')).toBeInTheDocument();
  fake.cached = new Set([key('weather', 'N50W010'), key('currents', 'N50W010')]);
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.61, lng: -1.4 }] }); });
  expect(await screen.findByText('Tuiles de prévision déjà présentes sur cet appareil')).toBeInTheDocument();
  // the line sits under the button it is about
  expect(within(screen.getByRole('button', { name: /^Calculer la route$|^Compute route$/ }).parentElement)
    .getByText('Tuiles de prévision déjà présentes sur cet appareil')).toBeInTheDocument();
});

// A page left open: the forecast moves on without any edit.
const MIN = 60_000;
function captureIntervals() {
  const timers = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...rest) => {
    if (ms !== QUOTE_TICK_MS) return real(fn, ms, ...rest);
    timers.push(fn);
    return 0;
  });
  return { fire: () => act(async () => { timers.at(-1)(); }) };
}
const newerRun = () => {
  fake.manifests = {
    weather: manifest('weather', { N50W010: 9 * MB }, { run_id: 'weather-20260910T12Z' }),
    currents: manifest('currents', { N50W010: 3 * MB }, { run_id: 'currents-20260910T12Z' }),
    ensemble: manifest('ensemble', { N50W010: 1 * MB }, { run_id: 'ensemble-20260910T12Z' }),
  };
  fake.checked = Date.now();
  return ['weather', 'currents', 'ensemble'];
};

const at = (minutes) => vi.setSystemTime(new Date(Date.parse(NOW) + minutes * MIN));

it('ticks every minute: a run published while the page sits open shows on the first tick after the store turns stale', async () => {
  const timers = captureIntervals();
  fake.checked = Date.now();
  fake.refresh.mockImplementation(async () => newerRun());
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  // the tiles of this run arrive on the device (say, another tab's check)
  fake.cached = new Set([key('weather', 'N50W010'), key('currents', 'N50W010')]);
  await timers.fire();
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Forecast tiles already on this device'));
  // ten minutes on is exactly the threshold, not over it: no read
  at(10);
  await timers.fire();
  expect(fake.refresh).not.toHaveBeenCalled();
  expect(lineOf(computeButton())).toHaveTextContent('Forecast tiles already on this device');
  // the next tick finds the catalogue stale, re-reads it, and the newer run replaces the held tiles
  at(11);
  await timers.fire();
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Downloads up to 12 MB of forecast tiles'));
  expect(fake.refresh).toHaveBeenCalledTimes(1);
});

it('makes no network request on ticks while the catalogue is fresh', async () => {
  const timers = captureIntervals();
  fake.checked = Date.now();
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  for (let minute = 1; minute <= 9; minute++) {
    at(minute);
    await timers.fire();
  }
  expect(fake.refresh).not.toHaveBeenCalled();
  expect(fake.init).toHaveBeenCalledTimes(1);
});

it('re-quotes when the page becomes visible or focused again', async () => {
  captureIntervals();
  fake.checked = Date.now();
  fake.refresh.mockImplementation(async () => newerRun());
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles');
  fake.cached = new Set([key('weather', 'N50W010'), key('currents', 'N50W010')]);
  vi.setSystemTime(new Date(Date.parse(NOW) + 11 * MIN));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  // the held tiles belong to the old run: the refresh replaced it, so everything is to fetch again
  await waitFor(() => expect(fake.refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Downloads up to 12 MB of forecast tiles'));
  fake.cached = new Set([...fake.cached, 'weather-20260910T12Z/weather/N50W010', 'currents-20260910T12Z/currents/N50W010']);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(lineOf(computeButton())).toHaveTextContent('Forecast tiles already on this device'));
});

it('offline after a successful init: ticks and ten edits over nine minutes make one failed request, a second only after the wait', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const timers = captureIntervals();
  fake.checked = Date.parse(NOW) - 11 * MIN; // the catalogue is stale, and the network is down
  fake.refresh.mockImplementation(async () => { throw new Error('offline'); });
  render(<Planner />);
  await screen.findByText('Downloads up to 12 MB of forecast tiles'); // the pinned manifests still quote
  expect(fake.refresh).toHaveBeenCalledTimes(1);
  for (let minute = 1; minute <= 9; minute++) {
    at(minute);
    await timers.fire();
    await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6 + minute / 100, lng: -1.4 }] }); });
  }
  await act(async () => { usePlanner.setState({ endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.75, lng: -1.4 }] }); });
  await screen.findByText(/forecast tiles$/);
  expect(fake.refresh).toHaveBeenCalledTimes(1);
  expect(fake.init).toHaveBeenCalledTimes(1);
  // ten minutes after the failed read the wait is over; a pressed action was never held back (withFreshForecast)
  at(10);
  await timers.fire();
  await waitFor(() => expect(fake.refresh).toHaveBeenCalledTimes(2));
});

it('adds a line under the refine action of a comparison on show, and says when its tiles are already here', async () => {
  refineHeld.mockReturnValue(true);
  render(<Planner />);
  await compute();
  const at = (h) => new Date(Date.parse('2026-09-12T06:00:00Z') + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const candidate = (h, verdict) => ({ departure_utc: at(h), verdict, worst_ratio: 1, max_fraction: null, ensemble_covered: false,
    max_members: null, driver_summary: null, passage_h: 2, arrival_hours_over_limit: verdict === 'within' ? 0 : 3,
    arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0 });
  act(() => usePlanner.setState({ scan: {
    candidates: [candidate(0, 'exceeds'), candidate(6, 'within'), candidate(12, 'exceeds')], best_index: 1, skipped: [],
    routes: {}, rerouted: true, requested: 3, notes: [], scanId: 1, runsDigest: null, profileRevision: null, dateWindow: null, refined: null,
  } }));
  const refineButton = await screen.findByRole('button', { name: 'Refine around the least-exposure times' });
  // a computed comparison's refinement routes on the grids it holds: only the audit layers over the box, no currents
  await waitFor(() => expect(lineOf(refineButton)).toHaveTextContent('Downloads up to 10 MB of forecast tiles'));
  expect(lineOf(scanButton())).toHaveTextContent('Downloads up to 13 MB of forecast tiles');
  expect(refineButton).toHaveAttribute('aria-describedby', 'download-refine');
  expect(fake.reads).not.toHaveBeenCalled();
  // once the comparison has read them, nothing is left to fetch
  fake.cached = new Set(['weather', 'currents', 'ensemble'].map((layer) => key(layer, 'N50W010')));
  act(() => usePlanner.getState().patch({ name: 'Held tiles' }));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(lineOf(refineButton)).toHaveTextContent('Forecast tiles already on this device'));
});
