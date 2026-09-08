import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApp } from '../src/stores/appStore.js';
import Briefing from '../src/pages/Briefing.jsx';
import Changes from '../src/pages/Changes.jsx';
import { fetchSnapshotJson } from '../src/lib/localSnapshots.js';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';

vi.mock('../src/lib/localSnapshots.js', () => ({ fetchSnapshotJson: vi.fn(), localSnapshots: {}, snapshotTombstones: {} }));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => null }));
beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), findings, loading: false,
    manifest: { snapshots: [{ ...findings, snapshot_id: 'previous' }] } }, true);
  fetchSnapshotJson.mockImplementation(async (_id, name) => name === 'findings.json' ? findings : null);
});

it.each(['next_run', 'next_runs'])('shows the same frozen time on both pages using %s', async (field) => {
  const next = { model: 'gfs_0p25', expected_at: '2026-09-09T04:20:00Z' };
  // Prose deliberately contains no parseable time: UI must use the structured field.
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined, next_runs: [],
    [field]: field === 'next_run' ? next : [next],
    sections: savedBriefing.sections.map(s => s.id === 'what_could_change' ? { ...s, register_plain: 'Archived prose.' } : s),
  } });
  render(<Briefing />);
  expect(screen.getByText(/next forecast ~Wed 9 Sep 04:20 UTC/)).toBeVisible();
  cleanup();
  render(<Changes />);
  expect(await screen.findByText('Next forecast update estimated around Wed 9 Sep 04:20 UTC. Check again before departure.')).toBeVisible();
});
it('shows unavailable on both pages without a scheduled update', async () => {
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined, next_runs: [] } });
  render(<Briefing />);
  expect(screen.getByText('Next forecast update time unavailable. Check the published forecast before departure.')).toBeVisible();
  expect(screen.queryByText(/next forecast ~/)).toBeNull();
  cleanup();
  render(<Changes />);
  expect(await screen.findByText('Next forecast update time unavailable. Check the published forecast before departure.')).toBeVisible();
});
