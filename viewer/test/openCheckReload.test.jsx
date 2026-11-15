import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import { initialPage } from '../src/lib/routes.js';

// Opening a briefing loads its lazy chunk (charts included).
vi.setConfig({ testTimeout: 30_000 });

// The served demo check stands in for a check saved in this browser: its files
// are read through the local store, never from /data/snapshots/.
const id = 'snapshot_v2_406ad333228b0a73';
let stored;

function saveLocally() {
  stored = new Set([id]);
  // read through the fixture server's implementation, so the app's own fetches stay countable
  const serve = globalThis.fetch.getMockImplementation();
  vi.spyOn(localSnapshots, 'exists').mockImplementation(async (snapshotId) => stored.has(snapshotId));
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (snapshotId, name) => (stored.has(snapshotId)
    ? JSON.stringify(await (await serve(`/data/snapshots/${snapshotId}/${name}`)).json()) : null));
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
}

/** A reload (or a tab the browser restores): a fresh store and app on the same URL and tab. */
function reload() {
  useApp.setState({ ...useApp.getInitialState(), page: initialPage(), language: 'en' }, true);
  return render(<App />);
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, '', '/#plan');
  useApp.setState({ ...useApp.getInitialState(), page: 'planner', language: 'en' }, true);
  saveLocally();
});

it('reopens the same browser-saved check after a reload without putting its id in the URL', async () => {
  await useApp.getState().openSnapshot(id, 'attempt-1');
  expect(useApp.getState()).toMatchObject({ page: 'briefing', snapshotSource: 'local' });
  expect(location.hash).toBe('#passage');
  const before = useApp.getState().findings;
  globalThis.fetch.mockClear();
  reload();
  await waitFor(() => expect(useApp.getState().findings?.snapshot_id).toBe(id));
  expect(useApp.getState()).toMatchObject({ page: 'briefing', snapshotId: id, snapshotSource: 'local', measurementAttempt: null });
  expect(useApp.getState().findings).toEqual(before);
  expect(location.hash).toBe('#passage');
  expect(screen.queryByText(/No briefing open/)).toBeNull();
  // saved evidence only: nothing read from the served tree for this check
  expect(globalThis.fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes(id))).toEqual([]);
});

it('reopens a check opened from My passages at its section deep link', async () => {
  history.replaceState(null, '', '/#passages');
  await useApp.getState().openSnapshot(id);
  history.replaceState(null, '', '/#passage/evidence');
  reload();
  await waitFor(() => expect(useApp.getState().findings?.snapshot_id).toBe(id));
  expect(useApp.getState().snapshotSource).toBe('local');
});

it('shows the empty state, without an error, when the check is gone from this browser', async () => {
  await useApp.getState().openSnapshot(id);
  stored.delete(id); // storage cleared, or deleted in another tab
  reload();
  expect(await screen.findByText(/No briefing open/)).toBeTruthy();
  await waitFor(() => expect(useApp.getState().loading).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(useApp.getState()).toMatchObject({ snapshotId: null, findings: null, loadError: null });
});

it('forgets a check deleted in this tab', async () => {
  await useApp.getState().openSnapshot(id);
  vi.spyOn(localSnapshots, 'remove').mockImplementation(async (snapshotId) => stored.delete(snapshotId));
  await useApp.getState().deleteSnapshot(id);
  stored.add(id); // even if the same id were saved again, the deleted open is not restored
  history.replaceState(null, '', '/#passage');
  reload();
  expect(await screen.findByText(/No briefing open/)).toBeTruthy();
  expect(useApp.getState().snapshotId).toBeNull();
});

it('does not reopen an earlier local check after a served check was opened in this tab', async () => {
  await useApp.getState().openSnapshot(id);
  await useApp.getState().openSnapshot(id, null, 'briefing', 'served');
  expect(location.hash).toBe(`#passage?snapshot=${id}`);
  history.replaceState(null, '', '/#passage');
  reload();
  expect(await screen.findByText(/No briefing open/)).toBeTruthy();
});

it('does not reopen a check on other pages', async () => {
  await useApp.getState().openSnapshot(id);
  history.replaceState(null, '', '/#passages');
  reload();
  await waitFor(() => expect(useApp.getState().page).toBe('passages'));
  expect(useApp.getState().snapshotId).toBeNull();
});
