import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { initialPage } from '../src/lib/routes.js';
import { snapshotTombstones } from '../src/lib/localSnapshots.js';

beforeEach(() => {
  history.replaceState(null, '', '/?utm_source=bluesky&dr_traffic=qa#example');
  useApp.setState({ page: 'example', manifest: null, loading: false, loadError: null });
});
describe('durable public example', () => {
  it('resolves the example after reload without planner setup, local briefings or live forecast requests', async () => {
    expect(initialPage()).toBe('example');
    const waypoints = [{ lat: 49, lon: -2 }, { lat: 50, lon: -3 }];
    usePlanner.setState({ waypoints });
    await useApp.getState().loadExample();
    const state = useApp.getState();
    expect(state.loadError).toBeNull();
    expect(state.page).toBe('example');
    expect(state.findings.verdict.state).toBe('warning_active');
    expect(state.measurementAttempt).toBeNull();
    expect(state.manifest.snapshots[0].demo).toBe(true);
    expect(usePlanner.getState().waypoints).toEqual(waypoints);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('/data/snapshots/'))).toBe(true);
    snapshotTombstones.add(state.snapshotId);
    await useApp.getState().loadExample();
    expect(useApp.getState().findings.verdict.state).toBe('warning_active');
    useApp.getState().setPage('planner');
    expect(location.hash).toBe('#plan/planner');
    expect(location.search).toContain('utm_source=bluesky');
  });
  it('fails visibly when the served example is unavailable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"snapshots":[]}', { status: 200 }));
    await useApp.getState().loadExample();
    expect(useApp.getState().loadError).toBeTruthy();
    expect(useApp.getState().loading).toBe(false);
    expect(useApp.getState().findings).toBeNull();
  });
});
