import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { groupPassages } from '../src/lib/passages.js';
import ChangesSection from '../src/pages/briefing/ChangesSection.jsx';
import { useApp } from '../src/stores/appStore.js';
import { fetchSnapshotJson } from '../src/lib/localSnapshots.js';
import saved from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

vi.mock('../src/lib/localSnapshots.js', () => ({ fetchSnapshotJson: vi.fn() }));
vi.mock('../src/components/SynopticCompare.jsx', () => ({ default: () => null }));
const entry = (snapshot_id, created_at, extra = {}) => ({ snapshot_id, created_at,
  route_id: 'same-name-2wp', departure_utc: saved.departure_utc, ...extra });
const modern = { identity_version: 2, passage_id: 'intent', local: true };
beforeEach(() => { fetchSnapshotJson.mockReset(); useApp.setState(useApp.getInitialState(), true); });

it('keeps ambiguous legacy snapshots and equal-label separate intents individually deletable', () => {
  const groups = groupPassages([entry('legacy-a', saved.generated_at), entry('legacy-b', saved.generated_at),
    entry('A1', saved.generated_at, modern), entry('A2', saved.generated_at, { ...modern, route_id: 'rerouted-3wp' }),
    entry('B', saved.generated_at, { ...modern, passage_id: 'separate' })]);
  expect(groups.map(g => g.checks.map(c => c.snapshot_id)).sort()).toEqual([['A1', 'A2'], ['B'], ['legacy-a'], ['legacy-b']].sort());
});

it('opening old/middle/new checks never compares to a future entry, including fixed-clock ties', async () => {
  const checks = ['a', 'b', 'c'].map((id, index) => entry(id, saved.generated_at, { ...modern, check_sequence: index + 1 }));
  const docs = Object.fromEntries(checks.map(e => [e.snapshot_id, { ...structuredClone(saved), ...e }]));
  fetchSnapshotJson.mockImplementation(async (id, file) => file === 'findings.json' ? docs[id] : null);
  useApp.setState({ manifest: { snapshots: [...checks].reverse() }, findings: docs.a });
  render(<ChangesSection />);
  expect(await screen.findByText('First analysis of this passage')).toBeVisible();
  expect(fetchSnapshotJson).not.toHaveBeenCalled();
  act(() => useApp.setState({ findings: docs.b }));
  await waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('a', 'findings.json'));
  fetchSnapshotJson.mockClear();
  act(() => useApp.setState({ findings: docs.c }));
  await waitFor(() => expect(fetchSnapshotJson).toHaveBeenCalledWith('b', 'findings.json'));
  expect(fetchSnapshotJson).not.toHaveBeenCalledWith('c', 'findings.json');
});

it('separates local and served copies even with equal explicit IDs and handles chronological timestamps', async () => {
  const { previousCheck } = await import('../src/lib/passages.js');
  const checks = [entry('z-old', '2026-07-19T00:00Z', modern), entry('a-middle', '2026-07-20T00:00Z', modern),
    entry('c-new', '2026-07-21T00:00Z', modern)];
  expect(previousCheck(checks, checks[0])).toBeNull();
  expect(previousCheck(checks, checks[1])).toBe(checks[0]);
  expect(previousCheck(checks, checks[2])).toBe(checks[1]);
  expect(groupPassages([...checks, { ...checks[0], local: false }])).toHaveLength(2);
  expect(previousCheck([...checks, entry('invalid', 'bad', modern)], entry('invalid', 'bad', modern))).toBeNull();
});

it('uses saved creation sequence for timestamp ties, so a later-created hash cannot become an older check predecessor', async () => {
  const { previousCheck } = await import('../src/lib/passages.js');
  const checks = ['z-first', 'a-second', 'm-third'].map((id, index) => entry(id, saved.generated_at,
    { ...modern, check_sequence: index + 1 }));
  expect(previousCheck(checks, checks[0])).toBeNull();
  expect(previousCheck(checks, checks[1])).toBe(checks[0]);
  expect(previousCheck(checks, checks[2])).toBe(checks[1]);
});

it('keeps incomplete or duplicated tie sequence ambiguous without comparing to another saved check', async () => {
  const { previousCheck } = await import('../src/lib/passages.js');
  for (const sequence of [undefined, 1]) {
    const checks = ['a', 'b'].map(id => entry(id, saved.generated_at, { ...modern, check_sequence: sequence }));
    expect(previousCheck(checks, checks[0])).toBeNull();
    expect(previousCheck(checks, checks[1])).toBeNull();
  }
  const checks = ['a', 'b'].map(id => entry(id, saved.generated_at, modern));
  useApp.setState({ manifest: { snapshots: checks }, findings: { ...structuredClone(saved), ...checks[1] } });
  render(<ChangesSection />);
  expect(await screen.findByText('Previous check order is unavailable. These saved checks have been kept.')).toBeVisible();
  expect(fetchSnapshotJson).not.toHaveBeenCalled();
});
