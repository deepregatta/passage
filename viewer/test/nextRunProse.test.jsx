import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { nextForecastRuns } from '@deepweather/engine';
import { useApp } from '../src/stores/appStore.js';
import Briefing from '../src/pages/Briefing.jsx';
import { fmtTextClock, fmtTextTime } from '../src/lib/format.js';
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
afterEach(() => vi.useRealTimers());

/** Display time: only Date is faked, so React and the page timers run normally. */
const at = (iso) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};
const nextRunLine = () => screen.getByTestId('next-run');

it.each(['next_run', 'next_runs'])('states the frozen next run once, in the decision band, using %s', async (field) => {
  at('2026-09-09T01:00:00Z');
  const next = { model: 'gfs_0p25', cycle: '2026-09-09T00:00:00Z', expected_at: '2026-09-09T04:20:00Z' };
  // Prose deliberately contains no parseable time: UI must use the structured field.
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined, next_runs: [],
    [field]: field === 'next_run' ? next : [next],
    sections: savedBriefing.sections.map(s => s.id === 'what_could_change' ? { ...s, register_plain: 'Archived prose.' } : s),
  } });
  render(<Briefing />);
  const time = new Date('2026-09-09T04:20:00Z').toDateString() === new Date('2026-09-09T01:00:00Z').toDateString()
    ? fmtTextClock('2026-09-09T04:20:00Z') : fmtTextTime('2026-09-09T04:20:00Z');
  expect(nextRunLine()).toHaveTextContent(`Next GFS run (00Z) expected about ${time}.`);
  expect(nextRunLine()).not.toHaveTextContent(/UTC/);
  expect(screen.getAllByText(/Next GFS run/)).toHaveLength(1);
});

it('shows the estimate from the producer cadence_hours, six hours on for a 6-hourly layer', async () => {
  const layers = { weather: {
    layer: 'weather', model: 'gfs_0p25', run_id: 'weather-20260908T00Z', cycle: '2026-09-08T00:00:00Z',
    published_at: '2026-09-08T04:20:00Z', member_count: 1, resolution_deg: 0.25, cadence_hours: 6,
  } };
  const nextRuns = nextForecastRuns(layers, '2026-09-08T05:00:00Z');
  expect(nextRuns).toEqual([{ model: 'gfs_0p25', cycle: '2026-09-08T06:00:00Z', expected_at: '2026-09-08T10:20:00Z' }]);
  at('2026-09-08T05:00:00Z');
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined, next_runs: nextRuns } });
  render(<Briefing />);
  expect(nextRunLine()).toHaveTextContent(/^Next GFS run \(06Z\) expected about /);
  expect(nextRunLine()).toHaveTextContent(fmtTextClock('2026-09-08T10:20:00Z'));
});

it('says "due now" two minutes before the estimate, never a past or precise-looking clock time', () => {
  at('2026-11-10T19:35:00Z');
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined,
    next_runs: [{ model: 'ecmwf_ifs_0p25', cycle: '2026-11-10T12:00:00Z', expected_at: '2026-11-10T19:37:00Z' }] } });
  render(<Briefing />);
  expect(nextRunLine()).toHaveTextContent('Next ECMWF run (12Z) is due now.');
  expect(nextRunLine()).not.toHaveTextContent(fmtTextClock('2026-11-10T19:37:00Z'));
  expect(nextRunLine()).not.toHaveTextContent(/~|UTC/);
});

it('says a long-passed estimate is late, with no estimate', () => {
  at('2026-11-11T19:35:00Z');
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined,
    next_runs: [{ model: 'ecmwf_ifs_0p25', cycle: '2026-11-10T12:00:00Z', expected_at: '2026-11-10T19:37:00Z' }] } });
  render(<Briefing />);
  expect(nextRunLine()).toHaveTextContent('Next ECMWF run (12Z) is late; no estimate.');
});

it('shows unavailable once without a scheduled update', async () => {
  useApp.setState({ briefing: { ...savedBriefing, next_run: undefined, next_runs: [] } });
  render(<Briefing />);
  expect(screen.getByText('No estimate for the next run. Check the published forecast before departure.')).toBeVisible();
  expect(screen.getAllByText(/No estimate for the next run/)).toHaveLength(1);
});

it('puts the next run in the action line when the models disagree', () => {
  at('2026-09-09T01:00:00Z');
  const disagree = structuredClone(findings);
  disagree.verdict = { ...disagree.verdict, state: 'insufficient', warning_override: { active: false } };
  useApp.setState({ findings: disagree, briefing: { ...savedBriefing,
    next_runs: [{ model: 'gfs_0p25', cycle: '2026-09-09T00:00:00Z', expected_at: '2026-09-09T04:20:00Z' }] } });
  render(<Briefing />);
  const line = nextRunLine();
  expect(line.parentElement).toHaveTextContent(/^Wait for the next run before deciding\. Next GFS run \(00Z\) expected about /);
  expect(screen.getAllByTestId('next-run')).toHaveLength(1);
});
