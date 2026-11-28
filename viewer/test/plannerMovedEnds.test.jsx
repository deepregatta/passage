// A moved end, a capped end and a way round beyond the search area, as the planner shows them
// (owner-approved rule and wording, 2026-11-28): over 200 m a dashed line from the marker to
// where the route starts or ends, and one sentence under the route, in nautical miles to one
// decimal, in English and French; the two refusals as alerts whose way on is Draw my route.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeRoute, EndTooFarFromWaterError, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { movedEndSentences } from '../src/pages/planner/plannerFeedback.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null, Rectangle: () => null,
  Marker: ({ position }) => <button aria-label={`Waypoint ${position.lat},${position.lng}`} disabled />,
  // The route line, and a dashed line (a moved end's) with the points it joins.
  Polyline: ({ positions, pathOptions }) => (pathOptions?.dashArray
    ? <div data-testid="moved-end-line" data-positions={JSON.stringify(positions)} />
    : <div data-testid="route-line" />),
  useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
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

const START = { lat: 50.5, lng: -1.5 };
const FINISH = { lat: 50.6, lng: -1.4 };
// Where the route really starts and ends: away from both markers.
const ROUTE_START = { lat: 50.45, lon: -1.45 };
const ROUTE_FINISH = { lat: 50.62, lon: -1.38 };
const result = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', ...ROUTE_START }, { id: 'b', ...ROUTE_FINISH }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'sun-fast-3200' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const computeButton = () => screen.getByRole('button', { name: /^(Compute route|Computing route…)$/ });
const summary = () => screen.queryByText('12.3 nm');
async function compute() {
  fireEvent.click(computeButton());
  await waitFor(() => expect(summary()).toBeInTheDocument());
}
const Root = ({ shown }) => <div id="root"><Planner /><LocalizedDocument language={shown} /></div>;
const show = () => render(<Root shown="en" />);
const switchTo = (view, language) => {
  useApp.setState({ language });
  view.rerender(<Root shown={language} />);
};
// What is announced (the always-mounted live region) and what is shown under the route must say the same.
const movedText = () => {
  const announced = screen.getByTestId('route-moved-ends').textContent;
  const shown = screen.queryByTestId('route-moved-ends-shown');
  expect(shown?.textContent ?? '').toBe(announced);
  if (shown) expect(shown).toHaveAttribute('aria-hidden', 'true');
  return announced;
};
const dashedLines = () => screen.queryAllByTestId('moved-end-line').map((line) => JSON.parse(line.dataset.positions));

// Cowes to Cherbourg on the 0.05° outline: the start moves 25,071 m, the finish 11,764 m.
const COWES_MOVES = { start_m: 25071, finish_m: 11764 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200', departureLocal: '2026-09-15T08:00',
    endpoints: [START, FINISH] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120, moved: COWES_MOVES, wayBeyond: false });
  computeRoute.mockImplementation(({ departureUtc }) => result(departureUtc));
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked' });
  prepareAnalysisInputs.mockImplementation(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] }));
});
afterEach(() => vi.useRealTimers());

describe.each([
  ['en', 'Start moved 13.5 nm to the nearest water the route can leave from.', 'Finish moved 6.4 nm to the nearest water the route can reach.'],
  ['fr', 'Départ déplacé de 13,5 M vers l’eau la plus proche d’où la route peut partir.', 'Arrivée déplacée de 6,4 M vers l’eau la plus proche que la route peut atteindre.'],
])('a moved end in %s', (language, startText, finishText) => {
  it('is said under the route, in a polite live region, with a dashed line from each marker', async () => {
    const view = show();
    expect(screen.getByTestId('route-moved-ends')).toHaveAttribute('aria-live', 'polite');
    expect(movedText()).toBe('');
    await compute();
    switchTo(view, language);
    await waitFor(() => expect(movedText()).toBe(`${startText}${finishText}`));
    if (language === 'fr') expect(movedText()).not.toMatch(/moved|nm\b/);
    expect(dashedLines()).toEqual([
      [[START.lat, START.lng], [ROUTE_START.lat, ROUTE_START.lon]],
      [[FINISH.lat, FINISH.lng], [ROUTE_FINISH.lat, ROUTE_FINISH.lon]],
    ]);
  });
});

describe('what is shown for a move', () => {
  it('is nothing at 200 m or less, and the sentence from just over it', () => {
    expect(movedEndSentences({ start_m: 200, finish_m: 0 })).toEqual([]);
    expect(movedEndSentences({ start_m: 0, finish_m: 199.9 })).toEqual([]);
    expect(movedEndSentences({ start_m: 201, finish_m: null })).toEqual(['Start moved 0.1 nm to the nearest water the route can leave from.']);
    expect(movedEndSentences(null)).toEqual([]);
    expect(movedEndSentences(undefined)).toEqual([]);
  });

  it('draws one end alone when only that end moved over 200 m', async () => {
    loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120, moved: { start_m: 150, finish_m: 3000 }, wayBeyond: false });
    show();
    await compute();
    expect(movedText()).toBe('Finish moved 1.6 nm to the nearest water the route can reach.');
    expect(dashedLines()).toEqual([[[FINISH.lat, FINISH.lng], [ROUTE_FINISH.lat, ROUTE_FINISH.lon]]]);
  });

  it('is nothing, and nothing breaks, for a route computed before the change (no moved distance)', async () => {
    loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120 });
    const view = show();
    await compute();
    expect(movedText()).toBe('');
    expect(dashedLines()).toEqual([]);
    // A draft saved before the change: its computed route has no `moved` at all.
    const { moved: _moved, ...older } = usePlanner.getState().computed;
    usePlanner.setState({ computed: older });
    view.unmount();
    show();
    expect(summary()).toBeInTheDocument();
    expect(movedText()).toBe('');
    expect(dashedLines()).toEqual([]);
  });

  it('never enters the route itself', async () => {
    show();
    await compute();
    const { computed } = usePlanner.getState();
    expect(computed.moved).toEqual(COWES_MOVES);
    expect(computed.route).toBe(computeRoute.mock.results[0].value.route);
    expect(JSON.stringify(computed.route)).not.toMatch(/moved/);
  });
});

describe.each([
  ['en', 'No open water within 5 nm of the start on the detailed coastline. Mark a start at sea, or use Draw my route.',
    'No open water within 5 nm of the finish on the detailed coastline. Mark a finish at sea, or use Draw my route.'],
  ['fr', 'Aucune eau libre à moins de 5 M du départ sur le trait de côte détaillé. Placez le départ en mer, ou utilisez « Tracer ma route ».',
    'Aucune eau libre à moins de 5 M de l’arrivée sur le trait de côte détaillé. Placez l’arrivée en mer, ou utilisez « Tracer ma route ».'],
])('an end beyond the cap in %s', (language, startText, finishText) => {
  it.each([['start', startText], ['finish', finishText]])('refuses the %s with Draw my route in place of Retry', async (end, text) => {
    loadRoutingInputs.mockRejectedValue(new EndTooFarFromWaterError(end));
    const view = show();
    fireEvent.click(computeButton());
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Draw my route' })).toBeInTheDocument();
    switchTo(view, language);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
    expect(summary()).not.toBeInTheDocument();
  });
});

describe.each([
  ['en', 'No route found: the way by sea between the start and the finish leaves the area the router can search. Use Draw my route instead.'],
  ['fr', 'Aucune route trouvée : le chemin par mer entre le départ et l’arrivée sort de la zone où le calcul peut chercher. Utilisez plutôt « Tracer ma route ».'],
])('a way round beyond the search area in %s', (language, text) => {
  it('replaces the generic failure, with Draw my route in place of Retry', async () => {
    loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 48, moved: { start_m: 0, finish_m: 0 }, wayBeyond: true });
    computeRoute.mockImplementation(() => { throw new Error('No route found within 48 h (wind coverage, land, or no-go conditions)'); });
    const view = show();
    fireEvent.click(computeButton());
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Draw my route' })).toBeInTheDocument();
    switchTo(view, language);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
  });

  it('reads as the reason a compared departure was not assessed', async () => {
    const view = show();
    await compute();
    const departure = '2026-09-15T12:00:00Z';
    const skipped = '2026-09-15T18:00:00Z';
    scanDepartures.mockImplementation(async ({ routeFor }) => {
      routeFor(departure);
      return { candidates: [{ departure_utc: departure, verdict: 'within', passage_h: 2 }], best_index: 0,
        skipped: [{ departure_utc: skipped, reason: 'No route found: the way by sea between the start and the finish leaves the area the router can search. Use Draw my route instead.' }] };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare departure times (next 5 days)' }));
    const region = await screen.findByRole('region', { name: 'Departure comparison' });
    switchTo(view, language);
    await waitFor(() => expect(within(region).getByText(text)).toBeInTheDocument());
  });
});

describe('the departure comparison', () => {
  it('says once how far the ends moved, and a picked time’s route says it under the route', async () => {
    show();
    await compute();
    const departure = '2026-09-15T12:00:00Z';
    scanDepartures.mockImplementation(async ({ routeFor }) => {
      routeFor(departure);
      return { candidates: [{ departure_utc: departure, verdict: 'within', passage_h: 2 }], best_index: 0 };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare departure times (next 5 days)' }));
    const region = await screen.findByRole('region', { name: 'Departure comparison' });
    expect(within(region).getByTestId('comparison-moved-ends').textContent).toBe(
      'Start moved 13.5 nm to the nearest water the route can leave from.Finish moved 6.4 nm to the nearest water the route can reach.');
    fireEvent.click(within(region).getAllByTitle(/ local time \(/)[0]);
    await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
    expect(usePlanner.getState().computed.moved).toEqual(COWES_MOVES);
    expect(movedText()).toBe(
      'Start moved 13.5 nm to the nearest water the route can leave from.Finish moved 6.4 nm to the nearest water the route can reach.');
  });
});
