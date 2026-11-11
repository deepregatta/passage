import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Planner from '../src/pages/Planner.jsx';
import { routingInputKey } from '../src/pages/planner/plannerInputs.js';
import { placedPoint } from '../src/pages/planner/passageName.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import limits from '../../config/profiles/default-limits.json';

// The list of ports is controlled by the test: `ports.list` is what has loaded, `ports.finish`
// settles the pending load, so a tap can be made before or after the list arrives.
const ports = vi.hoisted(() => ({ list: null, promise: null, finish: null }));
vi.mock('../src/lib/ports.js', async () => {
  const { nearestPort } = await import('../src/lib/portLookup.js');
  return {
    loadPorts: () => ports.promise,
    loadedPorts: () => ports.list,
    portNameAt: (lat, lng) => (ports.list ? nearestPort(ports.list, lat, lng)?.name ?? null : null),
  };
});

const handlers = vi.hoisted(() => ({ click: null, markers: {} }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: (props) => { handlers.markers[props.pointIndex] = props; return null; },
  Polyline: () => null, Rectangle: () => null,
  useMap: () => ({ fitBounds: vi.fn(), eachLayer: vi.fn(), on: vi.fn(), off: vi.fn() }),
  useMapEvents: (events) => { handlers.click = events.click; },
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));

const LIST = [['Cherbourg', 49.65, -1.62], ['Plymouth', 50.364, -4.143], ['Brest', 48.38, -4.49]];
const nameInput = () => screen.getByRole('textbox', { name: 'Name' });
const tap = (lat, lng) => act(() => handlers.click({ latlng: { lat, lng } }));
const drag = (index, lat, lng) => act(() => handlers.markers[index].eventHandlers.dragend({ target: { getLatLng: () => ({ lat, lng }) } }));
const arrive = async () => {
  await act(async () => { ports.list = LIST; ports.finish(LIST); });
};

beforeEach(() => {
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', departureLocal: '2099-09-12T08:00' });
  ports.list = LIST;
  ports.promise = Promise.resolve(LIST);
  handlers.markers = {};
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), loadManifest: vi.fn(), openSnapshot: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

it('names the passage from the ports its start and finish were tapped at', async () => {
  render(<Planner />);
  const passageId = usePlanner.getState().passageId;
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
  expect(usePlanner.getState().endpoints).toEqual([
    { lat: 49.67, lng: -1.6, name: 'Cherbourg', nameSource: 'port' },
    { lat: 50.35, lng: -4.12, name: 'Plymouth', nameSource: 'port' },
  ]);
  // naming is a display label: identity and routing inputs are untouched
  expect(usePlanner.getState().passageId).toBe(passageId);
});

it('keeps the generic name when a tap is out of range, in both languages', async () => {
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50, -3);
  expect(nameInput()).toHaveValue('My passage');
  expect(usePlanner.getState().endpoints[1]).toEqual({ lat: 50, lng: -3 });
  act(() => useApp.setState({ language: 'fr' }));
  await waitFor(() => expect(nameInput()).toHaveValue('Ma traversée'));
});

it('shows the port name as the source has it, in French too', async () => {
  render(<Planner />);
  act(() => useApp.setState({ language: 'fr' }));
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
});

it('a second pair of taps starts again and renames', async () => {
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  tap(48.39, -4.5);
  expect(usePlanner.getState().endpoints).toHaveLength(1);
  tap(49.65, -1.62);
  await waitFor(() => expect(nameInput()).toHaveValue('Brest → Cherbourg'));
});

it('renames a dragged waypoint, and clears the name when it leaves the port', async () => {
  usePlanner.setState({ mode: 'draw' });
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50, -3);
  tap(50.35, -4.12);
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
  drag(2, 48.4, -4.5);
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Brest'));
  drag(2, 49, -5.5);
  await waitFor(() => expect(nameInput()).toHaveValue('My passage'));
  expect(usePlanner.getState().waypoints[2]).toEqual({ lat: 49, lng: -5.5 });
});

it('never overwrites the name a GPX file gave a point, nor a name the sailor typed', async () => {
  usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 49.5, lng: -1.5, name: 'Home berth' }, { lat: 50.1, lng: -3.2, name: 'Dart' }] });
  render(<Planner />);
  await waitFor(() => expect(nameInput()).toHaveValue('Home berth → Dart'));
  drag(0, 49.65, -1.62); // into Cherbourg's range
  expect(usePlanner.getState().waypoints[0]).toEqual({ lat: 49.65, lng: -1.62, name: 'Home berth' });
  drag(1, 0, 0);
  expect(nameInput()).toHaveValue('Home berth → Dart');

  fireEvent.change(nameInput(), { target: { value: 'Channel dash' } });
  tap(50.35, -4.12);
  tap(48.39, -4.5);
  expect(nameInput()).toHaveValue('Channel dash');
  expect(usePlanner.getState().nameAuto).toBe(false);
});

it('does not name points of a draft that loads, only points placed afterwards', async () => {
  usePlanner.setState({ endpoints: [{ lat: 49.65, lng: -1.62 }, { lat: 50.364, lng: -4.143 }] });
  render(<Planner />);
  await act(async () => { await ports.promise; });
  expect(nameInput()).toHaveValue('My passage');
  expect(usePlanner.getState().endpoints[0]).toEqual({ lat: 49.65, lng: -1.62 });
});

it('names points tapped before the list arrived once it does', async () => {
  ports.list = null;
  ports.promise = new Promise((resolve) => { ports.finish = resolve; });
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  expect(nameInput()).toHaveValue('My passage');
  expect(usePlanner.getState().endpoints).toHaveLength(2); // the markers are not held back
  await arrive();
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
});

it('a list that arrives late leaves a route with results as it was', async () => {
  ports.list = null;
  ports.promise = new Promise((resolve) => { ports.finish = resolve; });
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  const endpoints = usePlanner.getState().endpoints;
  const key = routingInputKey({ endpoints, polarId: null, departureLocal: usePlanner.getState().departureLocal });
  // a result computed for these points exists when the file arrives
  act(() => usePlanner.setState({ computed: { inputKey: key, route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 49.67, lon: -1.6 }, { id: 'b', lat: 50.35, lon: -4.12 }],
    speeds_kt: { slow: 4, nominal: 5, fast: 6 }, polar_ref: 'x' }, arrival_utc: '2099-09-13T08:00:00Z' } }));
  await arrive();
  expect(usePlanner.getState().computed).not.toBeNull(); // the result is still the current one
  expect(usePlanner.getState().endpoints).toBe(endpoints);
  expect(nameInput()).toHaveValue('My passage');
});

it('a list that arrives late does not name a point that has since moved or gone', async () => {
  usePlanner.setState({ mode: 'draw' });
  ports.list = null;
  ports.promise = new Promise((resolve) => { ports.finish = resolve; });
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50, -3);
  drag(0, 49.0, -2.0); // moved away from Cherbourg before the file arrived
  await arrive();
  await waitFor(() => expect(usePlanner.getState().waypoints[0]).toEqual({ lat: 49, lng: -2 }));
  expect(nameInput()).toHaveValue('My passage');
});

it('everything works as before when the list never loads', async () => {
  ports.list = null;
  ports.promise = Promise.resolve(null);
  render(<Planner />);
  tap(49.67, -1.6);
  tap(50.35, -4.12);
  await act(async () => { await ports.promise; });
  expect(usePlanner.getState().endpoints).toEqual([{ lat: 49.67, lng: -1.6 }, { lat: 50.35, lng: -4.12 }]);
  expect(nameInput()).toHaveValue('My passage');
});

it('placedPoint: a port gives its name, none in range gives no name, a moved port-named point is re-evaluated', () => {
  const at = (lat) => (lat === 1 ? 'Alpha' : null);
  expect(placedPoint(null, { lat: 1, lng: 2 }, at)).toEqual({ lat: 1, lng: 2, name: 'Alpha', nameSource: 'port' });
  expect(placedPoint(null, { lat: 3, lng: 2 }, at)).toEqual({ lat: 3, lng: 2 });
  const named = { lat: 1, lng: 2, name: 'Alpha', nameSource: 'port' };
  expect(placedPoint(named, { lat: 3, lng: 2 }, at)).toEqual({ lat: 3, lng: 2 });
  expect(placedPoint({ lat: 0, lng: 0, name: 'Imported' }, { lat: 1, lng: 2 }, at)).toEqual({ lat: 1, lng: 2, name: 'Imported' });
});
