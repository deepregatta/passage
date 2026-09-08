import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../src/stores/appStore.js';
import Settings from '../src/pages/Settings.jsx';
import Changes from '../src/pages/Changes.jsx';
import Verification from '../src/pages/Verification.jsx';
import SynopticCompare from '../src/components/SynopticCompare.jsx';
import SynopticHero from '../src/components/SynopticHero.jsx';
import EnsemblePlume from '../src/components/EnsemblePlume.jsx';
import RouteMap from '../src/components/RouteMap.jsx';
import { fetchSnapshotJson } from '../src/lib/localSnapshots.js';
import { preparedRun } from '../src/lib/preparedRun.js';
import defaults from '../../config/profiles/default-limits.json';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';

vi.mock('../src/lib/localSnapshots.js', () => ({ fetchSnapshotJson: vi.fn(), localSnapshots: {}, snapshotTombstones: {} }));
vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: vi.fn(), artifactUrl: async (path) => `/data/${path}`, runsBase: () => '/data/' }));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: ({ option }) => <pre data-testid="chart">{JSON.stringify(option)}</pre> }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, bounds }) => <div data-testid="map" data-bounds={JSON.stringify(bounds)}>{children}</div>,
  TileLayer: () => null, Polyline: () => null, Marker: ({ children }) => <div>{children}</div>, Tooltip: ({ children }) => <span>{children}</span>,
}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();
  useApp.setState({ ...useApp.getInitialState(), profileDefaults: defaults, loadConfig: vi.fn(), loadManifest: vi.fn() }, true);
  fetchSnapshotJson.mockReset().mockResolvedValue(route);
  preparedRun.mockReset().mockResolvedValue({ doc: null });
});

it.each(['{broken', 'null', '[]', '42', '{"max_sustained_kt":null}'])('opens Settings with corrupt draft %s', (stored) => {
  localStorage.setItem('deepweather.profile-draft', stored);
  render(<Settings />);
  expect(screen.getByLabelText(/Max sustained · upwind/)).toHaveValue(18);
});
it('merges partial nested drafts with defaults', () => {
  localStorage.setItem('deepweather.profile-draft', JSON.stringify({ max_sustained_kt: { upwind: 15 }, max_gust_kt: 24 }));
  render(<Settings />);
  expect(screen.getByLabelText(/Max sustained · upwind/)).toHaveValue(15);
  expect(screen.getByLabelText(/Max sustained · reach/)).toHaveValue(25);
  expect(screen.getByLabelText(/Max gusts/)).toHaveValue(24);
});
it('opens Settings when reading storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  render(<Settings />);
  expect(screen.getByLabelText(/Max gusts/)).toHaveValue(28);
});
it('keeps editing usable when saving storage fails', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  render(<Settings />);
  fireEvent.change(screen.getByLabelText(/Max gusts/), { target: { value: '23' } });
  expect(screen.getByLabelText(/Max gusts/)).toHaveValue(23);
});

it('renders the unavailable comparison for an empty low track', () => {
  const empty = { systems: [{ kind: 'low', track: [] }] };
  render(<SynopticCompare previous={empty} latest={empty} />);
  expect(screen.getByText(/comparison unavailable/)).toBeVisible();
});
it.each([{ legs: [] }, { legs: findings.legs }])('renders a synoptic fallback for empty legs or waypoints', ({ legs }) => {
  useApp.setState({ findings: { ...findings, legs }, synoptic: { systems: [] }, route: { ...route, waypoints: [] } });
  render(<SynopticHero />);
  expect(screen.getByText('Synoptic chart unavailable')).toBeVisible();
});

function plumeState(overrides = {}) {
  useApp.setState({ findings, selectedLegId: findings.legs[0].leg_id, plume: { legs: [{
    leg_id: findings.legs[0].leg_id, times: [findings.departure_utc], gust_limit_kt: 28,
    gust_members: [[30]], wind_members: [[24]], ...overrides,
  }] } });
}
it('does not label wind against the archived gust limit', () => {
  plumeState(); render(<EnsemblePlume variable="wind" />);
  const option = JSON.parse(screen.getByTestId('chart').textContent);
  expect(option.series.at(-1).markLine).toBeUndefined();
  expect(option.series.at(-1).markArea).toBeUndefined();
  expect(Number.isFinite(option.yAxis.max)).toBe(true);
});
it('retains supplied wind limits and the gust fallback', () => {
  plumeState(); const view = render(<EnsemblePlume variable="wind" evidence={{ limit: 20 }} />);
  expect(JSON.parse(screen.getByTestId('chart').textContent).series.at(-1).markLine.data).toEqual([{ yAxis: 20 }]);
  view.rerender(<EnsemblePlume />);
  expect(JSON.parse(screen.getByTestId('chart').textContent).series.at(-1).markLine.data).toEqual([{ yAxis: 28 }]);
});
it.each([{ times: [] }, { wind_members: [] }, { wind_members: [[null]] }])('shows unavailable for empty ensemble data %j', (overrides) => {
  plumeState(overrides); render(<EnsemblePlume variable="wind" />);
  expect(screen.getByText('No ensemble data for this leg.')).toBeVisible();
});

it('does not let an old change-ledger failure replace a newly selected first run', async () => {
  const pending = deferred(); fetchSnapshotJson.mockReturnValue(pending.promise);
  useApp.setState({ findings, manifest: { snapshots: [{ ...findings, snapshot_id: 'previous' }] } });
  render(<Changes />);
  act(() => useApp.setState({ findings: { ...findings, route_id: 'other' } }));
  expect(screen.getByText('First analysis of this passage')).toBeVisible();
  await act(async () => pending.reject(new Error('old offline failure')));
  expect(screen.getByText('First analysis of this passage')).toBeVisible();
});
it('clears the previous comparison while loading a different run', async () => {
  useApp.setState({ findings, manifest: { snapshots: [] } }); render(<Changes />);
  expect(screen.getByText('First analysis of this passage')).toBeVisible();
  fetchSnapshotJson.mockReturnValue(new Promise(() => {}));
  act(() => useApp.setState({ manifest: { snapshots: [{ ...findings, snapshot_id: 'previous' }] } }));
  expect(screen.getByText('Comparing frozen runs…')).toBeVisible();
});

it('handles offline verification resources independently', async () => {
  fetch.mockImplementation(async (url) => {
    if (url.endsWith('corpus.json')) return json({ cases: 3, pass: 2, fail: 1, pending: 0 });
    throw new TypeError('offline');
  });
  render(<Verification />);
  expect(await screen.findByText('Skill claims use 3 real ERA5 cases.')).toBeVisible();
});
it('aborts verification reads on unmount', async () => {
  fetch.mockImplementation(() => new Promise(() => {}));
  const view = render(<Verification />);
  const signals = fetch.mock.calls.map(([, options]) => options?.signal);
  view.unmount();
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});
it('ignores a verification case that completes after switching snapshots', async () => {
  const old = deferred();
  fetch.mockImplementation(async (url) => {
    if (url.endsWith('index.json')) return json({ cases: ['A', 'B'] });
    if (url.endsWith('/A.json')) return old.promise;
    if (url.endsWith('/B.json')) return json({ coverage_summary: { partially_observed: 22 }, comparisons: [] });
    return json(null);
  });
  useApp.setState({ findings: { ...findings, snapshot_id: 'A' } }); render(<Verification />);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/A.json'))).toBe(true));
  act(() => useApp.setState({ findings: { ...findings, snapshot_id: 'B' } }));
  expect(await screen.findByText('22')).toBeVisible();
  await act(async () => old.resolve(json({ coverage_summary: { emulated: 11 }, comparisons: [] })));
  expect(screen.queryByText('11')).not.toBeInTheDocument();
  expect(screen.getByText('22')).toBeVisible();
});
it('uses the opened route and aborts optional map reads', async () => {
  useApp.setState({ findings, route });
  fetch.mockImplementation(() => new Promise(() => {}));
  const view = render(<RouteMap />);
  expect(screen.getByTestId('map')).toBeVisible();
  expect(fetchSnapshotJson).not.toHaveBeenCalled();
  const signal = fetch.mock.calls.find(([url]) => url.endsWith('gates.json'))?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
it('keeps the route visible when optional gate data is offline', async () => {
  useApp.setState({ findings, route }); fetch.mockRejectedValue(new TypeError('offline'));
  render(<RouteMap />);
  await act(async () => {});
  expect(screen.getByTestId('map')).toBeVisible();
});
it('does not create infinite map bounds from empty waypoints', async () => {
  useApp.setState({ findings: { ...findings, legs: [] }, route: { ...route, waypoints: [] } });
  fetchSnapshotJson.mockResolvedValue({ ...route, waypoints: [] });
  render(<RouteMap />); await act(async () => {});
  expect(screen.queryByTestId('map')).not.toBeInTheDocument();
});

it('ignores a stale successful comparison after switching passages', async () => {
  const old = deferred(); fetchSnapshotJson.mockReturnValue(old.promise);
  useApp.setState({ findings, manifest: { snapshots: [{ ...findings, snapshot_id: 'previous' }] } });
  render(<Changes />);
  act(() => useApp.setState({ findings: { ...findings, route_id: 'other' } }));
  await act(async () => old.resolve(findings));
  expect(screen.getByText('First analysis of this passage')).toBeVisible();
});
it('discards stale gate positions after the route changes', async () => {
  const old = deferred();
  const gate = { gate_id: 'test-gate', name: 'Test gate', status: 'clear' };
  fetch.mockImplementationOnce(() => old.promise).mockResolvedValue(json({ gates: [] }));
  useApp.setState({ findings: { ...findings, gates: [gate] }, route });
  render(<RouteMap />);
  act(() => useApp.setState({ findings: { ...findings, snapshot_id: 'new', gates: [gate] } }));
  await act(async () => old.resolve(json({ gates: [{ gate_id: gate.gate_id, lat: 50, lon: -1 }] })));
  expect(screen.queryByText('Test gate')).not.toBeInTheDocument();
});
it('aborts the map wind request on unmount', async () => {
  preparedRun.mockResolvedValue({ doc: { artifacts: { wind_grid: 'wind.json' } } });
  fetch.mockImplementation(async (url) => url.endsWith('wind.json') ? new Promise(() => {}) : json({ gates: [] }));
  useApp.setState({ findings, route }); const view = render(<RouteMap />);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('wind.json'))).toBe(true));
  const signal = fetch.mock.calls.find(([url]) => url.endsWith('wind.json'))[1]?.signal;
  view.unmount(); expect(signal?.aborted).toBe(true);
});
it('does not start a wind request if prepared-run discovery finishes after unmount', async () => {
  const old = deferred(); preparedRun.mockReturnValue(old.promise);
  useApp.setState({ findings, route }); const view = render(<RouteMap />); view.unmount();
  await act(async () => old.resolve({ doc: { artifacts: { wind_grid: 'wind.json' } } }));
  expect(fetch.mock.calls.some(([url]) => url.endsWith('wind.json'))).toBe(false);
});
