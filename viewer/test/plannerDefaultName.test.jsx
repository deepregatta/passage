import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Planner from '../src/pages/Planner.jsx';
import { defaultPassageName } from '../src/pages/planner/passageName.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import limits from '../../config/profiles/default-limits.json';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null, Rectangle: () => null,
  useMap: () => ({ fitBounds: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));

const nameInput = () => screen.getByRole('textbox', { name: 'Name' });
const CHERBOURG = { lat: 49.65, lng: -1.62, name: 'Cherbourg' };
const PLYMOUTH = { lat: 50.36, lng: -4.14, name: 'Plymouth' };

beforeEach(() => {
  localStorage.clear();
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', departureLocal: '2099-09-12T08:00' });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits: null, language: 'en',
    loadConfig: vi.fn(), loadManifest: vi.fn(), openSnapshot: vi.fn() });
});
afterEach(() => vi.useRealTimers());

it.each([
  [{ mode: 'compute', endpoints: [CHERBOURG, PLYMOUTH] }, 'en', 'Cherbourg → Plymouth'],
  [{ mode: 'compute', endpoints: [CHERBOURG, PLYMOUTH] }, 'fr', 'Cherbourg → Plymouth'],
  [{ mode: 'draw', waypoints: [CHERBOURG, { lat: 50, lng: -3 }, PLYMOUTH] }, 'en', 'Cherbourg → Plymouth'],
  [{ mode: 'compute', endpoints: [CHERBOURG, { lat: 50, lng: -3 }] }, 'en', 'My passage'],
  [{ mode: 'compute', endpoints: [CHERBOURG] }, 'en', 'My passage'],
  [{ mode: 'compute', endpoints: [{ lat: 1, lng: 2, name: '  ' }, PLYMOUTH] }, 'fr', 'Ma traversée'],
  [{ mode: 'draw', waypoints: [CHERBOURG] }, 'en', 'My passage'],
  [{ mode: 'compute', endpoints: [{ ...CHERBOURG, name: ' Port   de  Cherbourg ' }, PLYMOUTH] }, 'en', 'Port de Cherbourg → Plymouth'],
])('names the passage from its two named ends: %j in %s', (draft, language, expected) => {
  expect(defaultPassageName(draft, language)).toBe(expected);
});

it('fills the Name field from named start and finish, and follows them when they change', async () => {
  render(<Planner />);
  expect(nameInput()).toHaveValue('My passage');
  act(() => usePlanner.getState().patch({ endpoints: [CHERBOURG, PLYMOUTH] }));
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
  act(() => usePlanner.getState().patch({ endpoints: [CHERBOURG, { lat: 49.9, lng: -2.1 }] }));
  await waitFor(() => expect(nameInput()).toHaveValue('My passage'));
});

it('keeps a name the sailor typed when the ends become named or change', async () => {
  render(<Planner />);
  fireEvent.change(nameInput(), { target: { value: 'Channel dash' } });
  expect(usePlanner.getState().nameAuto).toBe(false);
  act(() => usePlanner.getState().patch({ endpoints: [CHERBOURG, PLYMOUTH] }));
  act(() => usePlanner.getState().patch({ endpoints: [PLYMOUTH, CHERBOURG] }));
  expect(nameInput()).toHaveValue('Channel dash');
  expect(usePlanner.getState().name).toBe('Channel dash');
});

it('keeps a typed name even when it equals the default name, and when the language changes', async () => {
  render(<Planner />);
  fireEvent.change(nameInput(), { target: { value: 'Typed' } });
  fireEvent.change(nameInput(), { target: { value: 'My passage' } });
  act(() => useApp.setState({ language: 'fr' }));
  act(() => usePlanner.getState().patch({ endpoints: [CHERBOURG, PLYMOUTH] }));
  expect(nameInput()).toHaveValue('My passage');
});

it('still switches the generic name with the page language', async () => {
  render(<Planner />);
  act(() => useApp.setState({ language: 'fr' }));
  await waitFor(() => expect(nameInput()).toHaveValue('Ma traversée'));
  act(() => useApp.setState({ language: 'en' }));
  await waitFor(() => expect(nameInput()).toHaveValue('My passage'));
});

it('naming a passage from its ends does not change the passage identity', async () => {
  render(<Planner />);
  const before = usePlanner.getState().passageId;
  act(() => usePlanner.getState().patch({ endpoints: [CHERBOURG, PLYMOUTH] }));
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
  expect(usePlanner.getState().passageId).toBe(before);
});

it('names a drawn route from an imported GPX with named first and last points', async () => {
  usePlanner.setState({ mode: 'draw' });
  const { container } = render(<Planner />);
  const gpx = `<gpx><rte><rtept lat="49.65" lon="-1.62"><name>Cherbourg</name></rtept>`
    + `<rtept lat="50" lon="-3"/><rtept lat="50.36" lon="-4.14"><name>Plymouth</name></rtept></rte></gpx>`;
  const file = new File([gpx], 'crossing.gpx', { type: 'application/gpx+xml' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => expect(nameInput()).toHaveValue('Cherbourg → Plymouth'));
});

it('keeps the route name written in an imported GPX file', async () => {
  usePlanner.setState({ mode: 'draw' });
  const { container } = render(<Planner />);
  const gpx = `<gpx><metadata><name>Round the island</name></metadata><rte><rtept lat="49.65" lon="-1.62"><name>Cherbourg</name></rtept>`
    + `<rtept lat="50.36" lon="-4.14"><name>Plymouth</name></rtept></rte></gpx>`;
  const file = new File([gpx], 'crossing.gpx', { type: 'application/gpx+xml' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => expect(nameInput()).toHaveValue('Round the island'));
  expect(usePlanner.getState().nameAuto).toBe(false);
});

it('migrates a saved draft: the two default names stay automatic, any other name counts as typed', () => {
  const migrate = usePlanner.persist.getOptions().migrate;
  expect(migrate({ name: 'My passage' }, 2).nameAuto).toBe(true);
  expect(migrate({ name: 'Ma traversée' }, 2).nameAuto).toBe(true);
  expect(migrate({ name: 'Channel dash' }, 2).nameAuto).toBe(false);
  expect(migrate({ name: 'Channel dash', nameAuto: true }, 3).nameAuto).toBe(true);
});
