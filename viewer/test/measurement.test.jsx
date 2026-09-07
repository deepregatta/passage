import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { useApp } from '../src/stores/appStore.js';
import { trackOnce } from '../src/lib/analytics.js';

vi.mock('../src/lib/analytics.js', () => ({ trackOnce: vi.fn() }));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => <div /> }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div /> }));
const fixture = resolve(import.meta.dirname, './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e');
const findings = JSON.parse(readFileSync(join(fixture, 'findings.json'), 'utf8'));
const briefing = JSON.parse(readFileSync(join(fixture, 'briefing.json'), 'utf8'));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('rendered Passage measurement contract', () => {
  function setup(attempt = null, demo = false, output = briefing) {
    useApp.setState({ findings, briefing: output, snapshotId: 'test-snapshot',
      measurementAttempt: attempt, manifest: { snapshots: [{ snapshot_id: 'test-snapshot', demo }] },
      synoptic: null, route: null, warnings: null });
    return render(<Briefing />);
  }
  it('example is separate from a planner run', () => {
    setup(null, true);
    expect(screen.queryByRole('button', { name: 'Find a departure that fits' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inspect example bulletin' })).toBeTruthy();
    expect(trackOnce).toHaveBeenCalledWith('passage_example_view:test-snapshot', 'passage_example_view', expect.objectContaining({ result_rendered: true }));
  });
  it('only a new attempt with rendered non-empty output activates', () => {
    setup('test-attempt');
    expect(trackOnce).toHaveBeenCalledWith('passage_run:test-attempt', 'passage_run', expect.objectContaining({ result_rendered: true, verdict: findings.verdict.state }));
  });
  it('reopening a saved briefing is only a view', () => {
    setup();
    expect(trackOnce).toHaveBeenCalledWith('passage_briefing_view:test-snapshot', 'passage_briefing_view', expect.any(Object));
  });
  it('empty output cannot activate', () => {
    setup('test-attempt', false, { ...briefing, sections: [] });
    expect(trackOnce).not.toHaveBeenCalled();
  });
});
