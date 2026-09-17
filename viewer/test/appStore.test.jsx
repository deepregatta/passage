import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../src/stores/appStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { fetchSnapshotJson, localSnapshots, snapshotTombstones } from '../src/lib/localSnapshots.js';
import { preparedRun } from '../src/lib/preparedRun.js';
import Briefing from '../src/pages/Briefing.jsx';
import Snapshots from '../src/pages/Snapshots.jsx';

vi.mock('../src/lib/localSnapshots.js', () => ({
  fetchSnapshotJson: vi.fn(),
  localSnapshots: { exists: vi.fn(async () => false), list: vi.fn(async () => []), remove: vi.fn(async () => true) },
  snapshotTombstones: { all: vi.fn(() => new Set()) },
}));
vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: vi.fn(async () => {}) }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function artifact(id, name) {
  if (name === 'findings.json') return {
    snapshot_id: id, evidence: [{ evidence_id: `${id}-evidence`, leg_id: `${id}-leg` }],
    verdict: { driver_evidence_id: `${id}-evidence` }, legs: [{ leg_id: `${id}-leg` }],
  };
  return { snapshot_id: id };
}
const initial = useApp.getInitialState();
beforeEach(() => {
  useApp.setState({ ...initial, page: 'snapshots' }, true);
  usePlayback.setState(usePlayback.getInitialState(), true);
  localSnapshots.list.mockReset().mockResolvedValue([]);
  localSnapshots.remove.mockReset().mockResolvedValue(true);
  snapshotTombstones.all.mockReset().mockReturnValue(new Set());
  preparedRun.mockReset().mockResolvedValue(undefined);
  fetchSnapshotJson.mockReset().mockImplementation(async (id, name) => artifact(id, name));
});
afterEach(() => usePlayback.getState().pause());

function delaySnapshot(id) {
  const gate = deferred();
  fetchSnapshotJson.mockImplementation(async (requested, name) => {
    if (requested === id) await gate.promise;
    return artifact(requested, name);
  });
  return gate;
}

describe('snapshot open ownership', () => {
  it('keeps every artifact and selection from the last request when the first finishes last', async () => {
    const first = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    await useApp.getState().openSnapshot('B', 'attempt-B');
    first.resolve();
    await a;
    const state = useApp.getState();
    expect(state.snapshotId).toBe('B');
    for (const key of ['findings', 'briefing', 'snapshot', 'plume', 'warnings', 'synoptic', 'route']) {
      expect(state[key].snapshot_id).toBe('B');
    }
    expect(state).toMatchObject({ selectedLegId: 'B-leg', selectedEvidenceId: 'B-evidence', measurementAttempt: 'attempt-B', page: 'briefing', loading: false, loadError: null });
  });

  it('ignores a stale rejection after the latest request succeeds', async () => {
    const first = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    await useApp.getState().openSnapshot('B');
    first.reject(new Error('old failure'));
    await a;
    expect(useApp.getState()).toMatchObject({ snapshotId: 'B', loadError: null, loading: false });
  });

  it('does not stop the loading indicator when an older request completes', async () => {
    const aGate = deferred(), bGate = deferred();
    fetchSnapshotJson.mockImplementation(async (id, name) => {
      await (id === 'A' ? aGate : bGate).promise;
      return artifact(id, name);
    });
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    const b = useApp.getState().openSnapshot('B');
    aGate.resolve();
    await a;
    expect(useApp.getState().loading).toBe(true);
    bGate.resolve();
    await b;
  });

  it('does not replace the latest error with an older success', async () => {
    const first = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    preparedRun.mockRejectedValueOnce(new Error('latest failure'));
    await useApp.getState().openSnapshot('B');
    first.resolve();
    await a;
    expect(useApp.getState()).toMatchObject({ snapshotId: 'B', findings: null, loadError: 'latest failure', loading: false, page: 'snapshots' });
  });

  it('clears old artifacts, inspection and playback immediately on open', async () => {
    await useApp.getState().openSnapshot('A');
    useApp.setState({ inspectorOpen: true });
    usePlayback.setState({ cursorHours: 12, playing: true, focusedEventId: 'A-event', focusedEvidenceId: 'A-evidence', departureVariant: 'later' });
    const gate = delaySnapshot('B');
    const b = useApp.getState().openSnapshot('B');
    expect(useApp.getState()).toMatchObject({ findings: null, briefing: null, snapshot: null, plume: null, warnings: null, synoptic: null, route: null, selectedLegId: null, selectedEvidenceId: null, inspectorOpen: false, loading: true });
    expect(usePlayback.getState()).toMatchObject({ cursorHours: 0, playing: false, focusedEventId: null, focusedEvidenceId: null, departureVariant: 'nominal' });
    gate.resolve();
    await b;
  });

  it.each(['resolve', 'reject'])('navigation cancels an open before its %s', async (settle) => {
    const gate = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    useApp.getState().setPage('planner');
    gate[settle](new Error('late failure'));
    await a;
    expect(useApp.getState()).toMatchObject({ page: 'planner', loading: false, findings: null, loadError: null });
  });

  it('same-page synchronization does not cancel an open', async () => {
    const gate = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    useApp.getState().setPage('snapshots');
    gate.resolve();
    await a;
    expect(useApp.getState()).toMatchObject({ page: 'briefing', snapshotId: 'A' });
  });

  it('skips artifact reads if superseded during prepared-run initialization', async () => {
    const gate = deferred();
    preparedRun.mockReturnValueOnce(gate.promise);
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(preparedRun).toHaveBeenCalled());
    await useApp.getState().openSnapshot('B');
    gate.resolve();
    await a;
    expect(fetchSnapshotJson.mock.calls.every(([id]) => id === 'B')).toBe(true);
  });

  it('allows missing optional artifacts and retries after a required artifact fails', async () => {
    fetchSnapshotJson.mockRejectedValue(new Error('missing'));
    await useApp.getState().openSnapshot('A');
    expect(useApp.getState().loadError).toBe('missing');
    fetchSnapshotJson.mockImplementation(async (id, name) => {
      if (!['findings.json', 'briefing.json'].includes(name)) throw new Error('optional missing');
      return artifact(id, name);
    });
    await useApp.getState().openSnapshot('A');
    expect(useApp.getState()).toMatchObject({ loadError: null, loading: false, page: 'briefing', route: null, warnings: null, plume: null, snapshot: null, synoptic: null });
  });

  it.each(['resolve', 'reject'])('ignores a late example manifest %s after another open', async (settle) => {
    const gate = deferred();
    globalThis.fetch = vi.fn(() => gate.promise);
    useApp.setState({ page: 'example' });
    const example = useApp.getState().loadExample();
    await useApp.getState().openSnapshot('B');
    gate[settle](settle === 'resolve' ? new Response(JSON.stringify({ snapshots: [{ snapshot_id: 'A', demo: true }] })) : new Error('late example error'));
    await example;
    expect(useApp.getState()).toMatchObject({ snapshotId: 'B', page: 'briefing', loadError: null });
    expect(useApp.getState().findings.snapshot_id).toBe('B');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('deleting a pending snapshot prevents its later completion from reopening it', async () => {
    const gate = delaySnapshot('A');
    const a = useApp.getState().openSnapshot('A');
    await vi.waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('A', 'findings.json'));
    await useApp.getState().deleteSnapshot('A');
    gate.resolve();
    await a;
    expect(localSnapshots.remove).toHaveBeenCalledWith('A');
    expect(useApp.getState()).toMatchObject({ snapshotId: null, findings: null, loading: false, page: 'snapshots' });
  });
});

describe('snapshot load feedback', () => {
  it.each([Briefing, Snapshots])('renders loadError as an alert on %s', (Page) => {
    useApp.setState({ loadError: 'fixture load failure' });
    render(<Page />);
    expect(screen.getByRole('alert')).toHaveTextContent('fixture load failure');
  });

  it('shows loading instead of the old briefing during another open', async () => {
    render(<Briefing />);
    const gate = delaySnapshot('A');
    let pending;
    act(() => { pending = useApp.getState().openSnapshot('A'); });
    expect(screen.getByRole('status')).toHaveTextContent('Loading passage instruments…');
    await act(async () => { gate.reject(new Error('load failed')); await pending; });
    expect(screen.getByRole('alert')).toHaveTextContent('load failed');
  });
});

describe('manifest merging and deletion', () => {
  const served = [{ snapshot_id: 'duplicate', name: 'served' }, { snapshot_id: 'hidden' }, { snapshot_id: 'public' }];
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ schema_version: 1, snapshots: served })));
  });

  it('prefers local duplicates, preserves order, filters tombstones and clears old errors', async () => {
    const local = [{ snapshot_id: 'newest' }, { snapshot_id: 'duplicate', name: 'local' }];
    localSnapshots.list.mockResolvedValue(local);
    snapshotTombstones.all.mockReturnValue(new Set(['hidden']));
    useApp.setState({ manifestError: 'old failure' });
    await useApp.getState().loadManifest();
    expect(useApp.getState()).toMatchObject({ manifestError: null, manifest: { schema_version: 1, snapshots: [...local, served[2]] } });
    expect(globalThis.fetch).toHaveBeenCalledWith('/data/snapshots/manifest.json');
  });

  it('uses local snapshots after an HTTP failure and reports failure when neither source is available', async () => {
    globalThis.fetch.mockResolvedValue(new Response('offline', { status: 503 }));
    localSnapshots.list.mockResolvedValue([{ snapshot_id: 'local' }]);
    await useApp.getState().loadManifest();
    expect(useApp.getState()).toMatchObject({ manifestError: null, manifest: { snapshots: [{ snapshot_id: 'local' }] } });
    localSnapshots.list.mockResolvedValue([]);
    await useApp.getState().loadManifest();
    expect(useApp.getState().manifestError).toContain('503');
  });

  it('deletes another local snapshot without clearing the open briefing and refreshes the list', async () => {
    await useApp.getState().openSnapshot('keep');
    await useApp.getState().deleteSnapshot('remove');
    expect(localSnapshots.remove).toHaveBeenCalledWith('remove');
    expect(localSnapshots.list).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(useApp.getState()).toMatchObject({ snapshotId: 'keep', findings: { snapshot_id: 'keep' }, manifest: { snapshots: served } });
  });

  it('preserves the open briefing and rejects a failed dev deletion', async () => {
    await useApp.getState().openSnapshot('keep');
    localSnapshots.remove.mockResolvedValue(false);
    globalThis.fetch.mockResolvedValue(new Response('read-only fixture', { status: 403 }));
    await expect(useApp.getState().deleteSnapshot('keep')).rejects.toThrow('Could not delete: read-only fixture');
    expect(globalThis.fetch).toHaveBeenCalledWith('/data/snapshots/keep', { method: 'DELETE' });
    expect(localSnapshots.list).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ snapshotId: 'keep', findings: { snapshot_id: 'keep' } });
  });
});
