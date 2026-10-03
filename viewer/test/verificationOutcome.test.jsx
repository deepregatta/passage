import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OutcomeSection from '../src/pages/briefing/OutcomeSection.jsx';
import About from '../src/pages/About.jsx';
import Passages from '../src/pages/Passages.jsx';
import { useApp } from '../src/stores/appStore.js';
import pythonCase from './fixtures/verification-case-v2.json';
import snapshot from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/snapshot.json';

const originalLoadManifest = useApp.getState().loadManifest;

afterEach(() => { useApp.setState({ findings: null, snapshotSource: null, loadManifest: originalLoadManifest }); vi.unstubAllGlobals(); });

function open(doc = pythonCase, source = 'served') {
  useApp.setState({ findings: { snapshot_id: pythonCase.snapshot_id, causal_events: [] }, snapshotSource: source });
  const fetch = vi.fn(async (url) => ({ ok: true, json: async () => String(url).endsWith('index.json')
    ? { cases: [{ snapshot_id: pythonCase.snapshot_id }] } : doc }));
  vi.stubGlobal('fetch', fetch);
  render(<OutcomeSection />);
  return fetch;
}

it('renders the Python producer source and both lead semantics without claiming success', async () => {
  open();
  await screen.findByText('What the forecast said, and what happened');
  expect(screen.getByText('OBSERVATION SOURCE · test-station')).toBeVisible();
  expect(screen.getByText('Since check')).toBeVisible();
  expect(screen.getByText('Model lead')).toBeVisible();
  expect(screen.queryByText(/caught the event direction/)).not.toBeInTheDocument();
});

it('browser-local snapshot has no public verifier request or scheduled-job promise', async () => {
  const fetch = open(pythonCase, 'local');
  await screen.findByText('Automatic verification is unavailable for briefings saved only in this browser.');
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByText(/job will match/)).not.toBeInTheDocument();
});

it.each([
  { ...pythonCase, pairs: [] },
  { ...pythonCase, pairs: [{ ...pythonCase.pairs[0], observed: null, error: null }] },
  { ...pythonCase, snapshot_id: 'another-check' },
])('empty, malformed or unrelated results never get a success statement', async (doc) => {
  open(doc);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryAllByText(/caught the event direction|useful magnitude/)).toHaveLength(0);
});

it('labels legacy totals separately from the deduplicated calibration', async () => {
  const record = { variable: 'wind_kt', lead_band_h: [0, 12], area: 'channel', n_pairs: 41,
    bias: 3, spread: 2, coverage_classes: { verified_near_observation: 41 } };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    schema_version: 2, lead_basis: 'time_since_check', records: [{ ...record, n_pairs: 1 }],
    legacy_evidence: { schema_version: 1, records: [record] },
  }) })));
  render(<About />);
  await screen.findByText('Legacy calibration evidence');
  expect(screen.getByText(/Individual contributions are unavailable/)).toBeVisible();
  expect(screen.getByRole('region', { name: 'Calibration record' })).toHaveTextContent('1');
  expect(screen.getByRole('region', { name: 'Legacy calibration evidence' })).toHaveTextContent('41');
});

it.each([false, true])('an indexed case is not an unconditional Verified claim (local=%s)', async (local) => {
  useApp.setState({ manifest: { snapshots: [{ ...snapshot, demo: false, local }] }, loadManifest: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cases: [{
    snapshot_id: snapshot.snapshot_id, observation_source: 'emulated',
  }] }) })));
  render(<Passages />);
  await screen.findByText(local ? 'Local only' : 'Published case');
  expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  expect(screen.queryByText('Verify')).not.toBeInTheDocument();
});
