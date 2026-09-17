import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import FooterActions from '../src/components/FooterActions.jsx';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import { initialPage } from '../src/lib/routes.js';

const id = '20260720T060000Z_44d2cd5f_64ea971e';
const sharedHash = `#brief/story?snapshot=${id}`;
beforeEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, '', '/#brief/briefings');
  useApp.setState({ ...useApp.getInitialState(), page: 'snapshots', language: 'en' }, true);
});

it('copies a served identity and reopens it on a fresh app mount', async () => {
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click((await screen.findAllByRole('button', { name: /cherbourg plymouth/i }))[0]);
  await user.click(screen.getByRole('button', { name: 'Share this analysis' }));
  expect(await navigator.clipboard.readText()).toBe(`${location.origin}/${sharedHash}`);
  view.unmount();
  history.replaceState(null, '', sharedHash);
  useApp.setState({ ...useApp.getInitialState(), page: initialPage(), language: 'en' }, true);
  render(<App />);
  await waitFor(() => expect(useApp.getState().findings?.snapshot_id).toBe(id));
  expect(screen.queryByText(/No analysis open/)).toBeNull();
  expect(location.hash).toBe(sharedHash);
});

it('disables sharing for a local briefing even if its ID also exists on the server', async () => {
  vi.spyOn(localSnapshots, 'exists').mockResolvedValue(true);
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (snapshotId, name) =>
    JSON.stringify(await (await fetch(`/data/snapshots/${snapshotId}/${name}`)).json()));
  await useApp.getState().openSnapshot(id);
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText');
  render(<FooterActions onNavigate={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Share this analysis' })).toBeDisabled();
  expect(screen.getByText('This briefing is stored only in this browser and cannot be shared by link.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Share this analysis' }));
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it('does not offer analysis sharing without an open analysis', () => {
  render(<FooterActions onNavigate={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Share this analysis' })).toBeDisabled();
});

it('reads shared artifacts from the server even when a different local copy exists', async () => {
  const read = vi.spyOn(localSnapshots, 'read').mockResolvedValue('invalid local artifact');
  history.replaceState(null, '', sharedHash);
  useApp.setState({ page: initialPage() });
  render(<App />);
  await waitFor(() => expect(useApp.getState().findings?.snapshot_id).toBe(id));
  expect(read).not.toHaveBeenCalled();
});

it.each(['missing-snapshot', '../private', '%'])('shows a load error for unavailable or invalid shared identity %s', async (snapshotId) => {
  history.replaceState(null, '', `#brief/story?snapshot=${encodeURIComponent(snapshotId)}`);
  useApp.setState({ page: initialPage() });
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('This shared analysis is unavailable.');
  expect(screen.getByRole('button', { name: 'Share this analysis' })).toBeDisabled();
});

it('preserves French links and recovers from a missing shared snapshot via hash navigation', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/fr/#brief/story?snapshot=missing');
  useApp.setState({ page: initialPage() });
  render(<App />);
  await screen.findByRole('alert');
  await act(async () => { location.hash = sharedHash; });
  await waitFor(() => expect(useApp.getState().findings?.snapshot_id).toBe(id));
  await user.click(screen.getByRole('button', { name: 'Share this analysis' }));
  expect(await navigator.clipboard.readText()).toBe(`${location.origin}/fr/${sharedHash}`);
});

it('does not reopen a shared analysis after the reader navigates away during loading', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).endsWith('/findings.json')) await pending;
    return fetchFixture(input);
  });
  history.replaceState(null, '', sharedHash);
  useApp.setState({ page: initialPage() });
  render(<App />);
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(`/data/snapshots/${id}/findings.json`));
  await act(async () => useApp.getState().setPage('snapshots'));
  await act(async () => finish());
  expect(useApp.getState()).toMatchObject({ page: 'snapshots', loading: false, findings: null });
  expect(location.hash).toBe('#brief/briefings');
});

it('reports clipboard failure without claiming the link was copied', async () => {
  await useApp.getState().openSnapshot(id);
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'));
  render(<FooterActions onNavigate={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Share this analysis' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the link. Please try again.');
  expect(screen.queryByRole('button', { name: 'Link copied' })).toBeNull();
});
