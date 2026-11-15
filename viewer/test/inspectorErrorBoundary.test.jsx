import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import findings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';

// Opening a briefing loads its lazy chunk (charts included).
vi.setConfig({ testTimeout: 30_000 });

// The Evidence inspector is mounted on every page, and its open state and selection
// survive navigation. An inspector that throws (an evidence record whose units are an
// object, which JSON allows) must not take the page with it, nor follow the sailor to
// every page: it closes, says so once, and the remembered open check stays (2026-11-15).
const PAGE_FALLBACK = 'This page could not be shown.';
const NOTE = { en: 'This evidence detail could not be shown.', fr: 'Le détail de cet élément probant n’a pas pu être affiché.' };
const OPEN_CHECK_KEY = 'deepweather.open-check';
const goodId = 'snapshot_v2_406ad333228b0a73';
const brokenId = 'snapshot_v2_b40ce000000000e1';
const brokenFindings = { ...findings, snapshot_id: brokenId, legs: findings.legs.map((leg, i) => (i === 0 ? { ...leg, hours: { 0: leg.hours[0] } } : leg)) };
const badEvidence = { evidence_id: 'E1', model: 'GFS', value: 20, limit: 18, units: { a: 1 } };

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, '', '/#plan');
  useApp.setState({ ...useApp.getInitialState(), page: 'planner', language: 'en' }, true);
  const serve = globalThis.fetch.getMockImplementation();
  const stored = new Set([goodId, brokenId]);
  vi.spyOn(localSnapshots, 'exists').mockImplementation(async (snapshotId) => stored.has(snapshotId));
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (snapshotId, name) => {
    if (!stored.has(snapshotId)) return null;
    if (snapshotId === brokenId && name === 'findings.json') return JSON.stringify(brokenFindings);
    return JSON.stringify(await (await serve(`/data/snapshots/${goodId}/${name}`)).json());
  });
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The browser-saved demo check, open, then the inspector on an evidence record it cannot show. */
async function inspectorThrows(language = 'en') {
  useApp.setState({ language });
  render(<App />);
  await act(async () => { await useApp.getState().openSnapshot(goodId); });
  expect(await screen.findByTestId('decision-band')).toBeVisible();
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBe(goodId);
  await act(async () => { useApp.setState({ selectedEvidenceId: 'E1', inspectorOpen: true, evidenceById: () => badEvidence }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

const headerNav = () => screen.getAllByRole('navigation', { name: 'Main navigation' })[0];

it('keeps the page, closes the inspector, says so once and keeps the remembered check', async () => {
  await inspectorThrows();
  expect(screen.queryByRole('heading', { name: PAGE_FALLBACK })).toBeNull();
  expect(screen.getByTestId('decision-band')).toBeVisible();
  expect(screen.getAllByText(NOTE.en, { exact: true })).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: 'Evidence inspector' })).toBeNull();
  expect(useApp.getState()).toMatchObject({ inspectorOpen: false, selectedEvidenceId: null });
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBe(goodId);
  // not again: the inspector stays closed and nothing more is logged
  const logged = vi.mocked(console.error).mock.calls.length;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(vi.mocked(console.error).mock.calls.length).toBe(logged);
  expect(screen.getAllByText(NOTE.en, { exact: true })).toHaveLength(1);
});

it('says so in French', async () => {
  await inspectorThrows('fr');
  expect(screen.getByText(NOTE.fr, { exact: true })).toBeVisible();
});

it('lets the header’s My passages navigate afterwards', async () => {
  await inspectorThrows();
  await userEvent.click(within(headerNav()).getByRole('button', { name: 'My passages' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: PAGE_FALLBACK })).toBeNull();
});

it('lets Plan navigate afterwards', async () => {
  await inspectorThrows();
  await userEvent.click(within(headerNav()).getByRole('button', { name: 'Plan' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(useApp.getState().page).toBe('planner');
  expect(screen.queryByRole('heading', { name: PAGE_FALLBACK })).toBeNull();
  expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
});

it('lets the page fallback’s own button navigate when the page and the inspector both fail', async () => {
  render(<App />);
  await act(async () => { await useApp.getState().openSnapshot(brokenId); });
  await act(async () => { useApp.setState({ selectedEvidenceId: 'E1', inspectorOpen: true, evidenceById: () => badEvidence }); });
  expect(await screen.findByRole('heading', { name: PAGE_FALLBACK })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Go to My passages' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: PAGE_FALLBACK })).toBeNull();
});

it('opens another evidence record normally after one could not be shown', async () => {
  await inspectorThrows();
  await act(async () => { useApp.setState({ evidenceById: useApp.getInitialState().evidenceById }); useApp.getState().openEvidence(findings.evidence[0].evidence_id); });
  expect(await screen.findByRole('dialog', { name: 'Evidence inspector' })).toBeVisible();
  expect(screen.queryByText(NOTE.en, { exact: true })).toBeNull();
});
