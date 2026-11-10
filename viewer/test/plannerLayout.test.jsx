import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import L from 'leaflet';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, scanDepartures } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { CLEAR_UNDO_MS } from '../src/pages/planner/usePlannerController.jsx';
import { markerIcon, markerSpecs, labelMarker } from '../src/pages/planner/plannerMarkers.js';
import { mapHint, barStatus } from '../src/pages/planner/plannerFeedback.js';
import { translateText } from '../src/i18n.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { analyzeInBrowser, prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn() }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null, Rectangle: () => null,
  useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
}));
vi.mock('../src/components/MapTouchScroll.jsx', () => ({ default: () => null }));
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
  route: { schema_version: 1, route_id: 'computed', name: 'x', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'boat-a' },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15,
  arrival_utc: new Date(Date.parse(departureUtc) + 7200000).toISOString(),
});
const EPS = [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }];
const bar = () => screen.getByTestId('planner-action-bar');
const barButton = () => within(bar()).getByRole('button', { hidden: true });
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'boat-a', polarLabel: 'Boat A', departureLocal: '2026-09-12T08:00', endpoints: EPS });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn(), setPage: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 120 });
  computeRoute.mockImplementation(({ departureUtc }) => result(departureUtc));
  analyzeInBrowser.mockResolvedValue({ snapshotId: 'checked' });
  prepareAnalysisInputs.mockImplementation(async draft => ({ ...draft, store: {}, tileRuns: {}, inputRecords: [] }));
  scanDepartures.mockResolvedValue({ candidates: [], best_index: null });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete Element.prototype.scrollIntoView; });

// ---- 5: first screen
it('says what the product does under the title and links to the example briefing', () => {
  render(<Planner />);
  const heading = screen.getByRole('heading', { level: 1, name: 'Plan a passage' });
  expect(heading.parentElement).toHaveTextContent('Check a planned passage against the forecast and your boat’s limits: an explainable verdict, with the uncertainty shown.');
  click('See an example briefing');
  expect(useApp.getState().setPage).toHaveBeenCalledWith('example');
});

// ---- 10: skip link and wording
it('offers a skip link that moves focus to the route form', () => {
  render(<Planner />);
  const skip = screen.getByRole('link', { name: 'Skip to the route form' });
  expect(skip).toHaveClass('sr-only', 'focus:not-sr-only');
  const url = location.href;
  fireEvent.click(skip);
  const form = screen.getByRole('heading', { level: 1 }).closest('section');
  expect(form).toHaveAttribute('tabindex', '-1');
  // clear of the 57 px sticky header when scrolled to
  expect(form).toHaveClass('scroll-mt-16');
  expect(form).toHaveFocus();
  expect(location.href).toBe(url);
});

it('words the drawing hint neutrally for pointer and touch', () => {
  usePlanner.setState({ mode: 'draw' });
  render(<Planner />);
  expect(screen.getByText('Add waypoints on the chart (drag to adjust).')).toBeInTheDocument();
  expect(screen.queryByText(/Click the chart/)).not.toBeInTheDocument();
  expect(translateText('Add waypoints on the chart (drag to adjust).', 'fr')).toContain('Ajoutez des points de route');
});

// ---- 4: phone layout
it('keeps a primary action bar for phones and follows Compute then Check', async () => {
  render(<Planner />);
  expect(bar()).toHaveClass('lg:hidden', 'sticky');
  expect(bar()).toHaveAttribute('aria-hidden', 'true');
  expect(barButton()).toHaveTextContent('Compute route');
  fireEvent.click(barButton());
  expect(barButton()).toHaveTextContent('Computing route…');
  expect(barButton()).toBeDisabled();
  await waitFor(() => expect(barButton()).toHaveTextContent('Check this passage'));
  expect(bar()).toHaveTextContent('Route ready: 12.3 nm · 2 h');
  fireEvent.click(barButton());
  await waitFor(() => expect(analyzeInBrowser).toHaveBeenCalled());
});

it('states why the bar action is not available, and does not repeat an alert', async () => {
  usePlanner.setState({ polarId: null, polarLabel: null });
  render(<Planner />);
  expect(barButton()).toBeDisabled();
  expect(bar()).toHaveTextContent('Choose your boat first');
  act(() => usePlanner.setState({ polarId: 'boat-a' }));
  loadRoutingInputs.mockRejectedValueOnce(new Error('No sea route found'));
  fireEvent.click(barButton());
  await screen.findByRole('alert');
  expect(screen.getAllByText('No sea route found')).toHaveLength(1);
  expect(bar()).toHaveTextContent('That did not finish');
  expect(bar().querySelector('[role="alert"], [aria-live]')).toBeNull();
});

it('shows a short status chip over the map as the route takes shape', async () => {
  usePlanner.setState({ endpoints: [] });
  render(<Planner />);
  const chip = () => document.querySelector('p.absolute[aria-live="polite"]');
  expect(chip()).toHaveAttribute('aria-live', 'polite');
  expect(chip()).toHaveTextContent('Mark your start on the chart');
  act(() => mapEvents.click({ latlng: EPS[0] }));
  expect(chip()).toHaveTextContent('Start set — now mark the finish');
  act(() => mapEvents.click({ latlng: EPS[1] }));
  expect(chip()).toHaveTextContent('Start and finish set — compute the route');
  click('Compute route');
  await waitFor(() => expect(chip()).toHaveTextContent('Route computed · 12.3 nm · 2 h'));
});

it('describes a drawn route in the chip and the bar, in French too', () => {
  const draft = { mode: 'draw', endpoints: [], waypoints: [{}, {}, {}], computed: null, distance: 42 };
  expect(mapHint(draft)).toBe('3 waypoints · 42 nm');
  expect(translateText('3 waypoints · 42 nm', 'fr')).toBe('3 points de route · 42 M');
  expect(mapHint({ ...draft, waypoints: [] })).toBe('Add your start on the chart');
  expect(barStatus({ ...draft, failure: null, busy: null, blocked: null })).toBe('3 waypoints · 42 nm');
  expect(translateText('Route ready: 12.3 nm · 2 h', 'fr')).toBe('Route prête : 12,3 M · 2 h');
  expect(translateText('Route computed · 12.3 nm · 2 h', 'fr')).toBe('Route calculée : 12,3 M · 2 h');
  expect(translateText('Waypoint 2 of 5', 'fr')).toBe('Point de route 2 sur 5');
});

// ---- 7: draw mode
it('says when Draw mode started from the Compute endpoints and lets Clear begin again', () => {
  render(<Planner />);
  fireEvent.click(screen.getByRole('tab', { name: 'Draw my route' }));
  expect(usePlanner.getState().waypoints).toEqual(EPS);
  const notice = screen.getByText(/^Started from your Compute start and finish; new points are added after the finish\./);
  expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
  click('clear');
  expect(screen.queryByText(/^Started from your Compute/)).not.toBeInTheDocument();
});

it('shows no seeding notice when Draw mode starts empty or with its own points', () => {
  usePlanner.setState({ mode: 'draw', endpoints: [], waypoints: EPS });
  render(<Planner />);
  expect(screen.queryByText(/^Started from your Compute/)).not.toBeInTheDocument();
});

it('labels the three drawn speeds and says what they replace', () => {
  usePlanner.setState({ mode: 'draw', waypoints: EPS });
  render(<Planner />);
  for (const label of ['Slow', 'Usual', 'Fast']) expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText(/^Draw mode uses these speeds instead of a boat polar;/)).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'slow speed' })).toBeInTheDocument();
  expect(translateText('Usual', 'fr')).toBe('Habituelle');
});

it('keeps undo and clear apart with 44 px targets', () => {
  usePlanner.setState({ mode: 'draw', waypoints: EPS });
  render(<Planner />);
  for (const name of ['undo', 'clear']) expect(screen.getByRole('button', { name, exact: true })).toHaveClass('min-h-11', 'min-w-11');
  expect(screen.getByRole('button', { name: 'clear', exact: true }).parentElement).toHaveClass('gap-3');
});

it('lets Clear be undone for a few seconds, until the route is edited', async () => {
  usePlanner.setState({ mode: 'draw', waypoints: [...EPS, { lat: 50.7, lng: -1.3 }] });
  render(<Planner />);
  click('clear');
  expect(usePlanner.getState().waypoints).toEqual([]);
  const region = screen.getByText('Route cleared').closest('[aria-live="polite"]');
  expect(region).not.toBeNull();
  fireEvent.click(within(region).getByRole('button', { name: 'Undo clear' }));
  expect(usePlanner.getState().waypoints).toHaveLength(3);
  expect(screen.queryByText('Route cleared')).not.toBeInTheDocument();
  // not offered once the route has been edited
  click('clear');
  act(() => mapEvents.click({ latlng: EPS[0] }));
  expect(screen.queryByText('Route cleared')).not.toBeInTheDocument();
  // and it expires
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  click('clear');
  expect(screen.getByText('Route cleared')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(CLEAR_UNDO_MS + 100); });
  expect(screen.queryByText('Route cleared')).not.toBeInTheDocument();
});

it('restores a cleared computed route with its endpoints', async () => {
  render(<Planner />);
  click('Compute route');
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  click('clear');
  expect(screen.queryByText('12.3 nm')).not.toBeInTheDocument();
  click('Undo clear');
  expect(usePlanner.getState().endpoints).toEqual(EPS);
  expect(screen.getByText('12.3 nm')).toBeInTheDocument();
});

// ---- 9: comparison
it('states why Compare departure times is not available, next to the button', () => {
  usePlanner.setState({ endpoints: [] });
  render(<Planner />);
  const scan = screen.getByRole('button', { name: 'Compare departure times (next 5 days)' });
  expect(scan).toBeDisabled();
  const reason = within(scan.parentElement).getByText('Mark a start and finish on the chart.');
  expect(reason.closest('[aria-live="polite"]')).not.toBeNull();
});

it('brings the finished comparison into view, focuses its heading, and can be reached from the sidebar', async () => {
  render(<Planner />);
  click('Compute route');
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  scanDepartures.mockResolvedValue({ candidates: [{ departure_utc: '2026-09-12T12:00:00Z', verdict: 'within', passage_h: 2 }], best_index: 0 });
  click('Compare departure times (next 5 days)');
  const heading = await screen.findByRole('heading', { name: /Departure comparison/ });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(heading).toHaveAttribute('tabindex', '-1');
  expect(heading).toHaveClass('scroll-mt-16');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  // the sidebar line jumps back to it
  (document.activeElement).blur();
  Element.prototype.scrollIntoView.mockClear();
  click('Show the comparison');
  expect(heading).toHaveFocus();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

it('does not animate the scroll when the sailor prefers reduced motion', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  render(<Planner />);
  click('Compute route');
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  scanDepartures.mockResolvedValue({ candidates: [{ departure_utc: '2026-09-12T12:00:00Z', verdict: 'within', passage_h: 2 }], best_index: 0 });
  click('Compare departure times (next 5 days)');
  await screen.findByRole('heading', { name: /Departure comparison/ });
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }));
});

it('does not move focus when a comparison fails or is already on screen at mount', async () => {
  render(<Planner />);
  click('Compute route');
  await waitFor(() => expect(screen.getByText('12.3 nm')).toBeInTheDocument());
  scanDepartures.mockRejectedValue(new Error('Scan broke'));
  click('Compare departure times (next 5 days)');
  await screen.findByRole('alert');
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it('keeps the map short on phones so the form starts on the first screen, and full height on desktop', () => {
  const { container } = render(<Planner />);
  const frame = container.querySelector('.isolate.relative');
  expect(frame).toHaveClass('h-[40vh]', 'min-h-[240px]', 'lg:h-auto', 'lg:min-h-[calc(100vh-8rem)]');
});

// ---- markers
it('numbers every point and marks the first Start and the last Finish', () => {
  expect(markerSpecs(1)).toEqual([{ kind: 'start', number: 1, label: 'Start', ariaLabel: 'Start' }]);
  expect(markerSpecs(4).map(({ kind, number, label, ariaLabel }) => [kind, number, label, ariaLabel])).toEqual([
    ['start', 1, 'Start', 'Start'],
    ['waypoint', 2, '', 'Waypoint 2 of 4'],
    ['waypoint', 3, '', 'Waypoint 3 of 4'],
    ['finish', 4, 'Finish', 'Finish'],
  ]);
  expect(markerSpecs(0)).toEqual([]);
});

it('gives Leaflet markers a 44 px target, a visible label, a role, a name and distinct shapes', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const map = L.map(container).setView([50, -1], 8);
  const make = (spec) => {
    const marker = L.marker([50, -1], { icon: markerIcon(spec), title: spec.ariaLabel, draggable: true });
    marker.on(labelMarker(spec));
    marker.addTo(map);
    return marker.getElement();
  };
  const [start, mid, finish] = markerSpecs(3).map(make);
  for (const element of [start, mid, finish]) {
    expect(element.getAttribute('role')).toBe('button');
    expect(element.tabIndex).toBe(0);
    expect(element.style.width).toBe('44px');
    expect(element.style.height).toBe('44px');
  }
  expect([start, mid, finish].map((e) => e.getAttribute('aria-label'))).toEqual(['Start', 'Waypoint 2 of 3', 'Finish']);
  expect(start.textContent).toContain('Start');
  expect(finish.textContent).toContain('Finish');
  expect(mid.textContent).toBe('2');
  expect(start.innerHTML).toContain('border-radius:50%');
  expect(finish.innerHTML).toContain('border-radius:3px');
  expect(start.innerHTML).not.toBe(finish.innerHTML);
  map.remove();
  container.remove();
});
