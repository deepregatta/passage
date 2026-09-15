import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, cleanup, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { useApp } from '../src/stores/appStore.js';
import { deriveCoverage } from '../src/lib/evidenceSelectors.js';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => <div data-testid="chart" /> }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="map" /> }));

const repo = resolve(import.meta.dirname, '..', '..');
// the committed fixtures are the guaranteed corpus; the live warehouse is
// extra best-effort coverage (the user may freely delete their briefings)
const roots = [
  join(repo, 'viewer', 'test', 'fixtures', 'demo', 'snapshots'),
  join(repo, 'data', 'processed', 'snapshots'),
];

describe('saved snapshot compatibility', () => {
  it('renders every local snapshot and derives contradiction-free warning coverage', () => {
    const dirs = roots.flatMap((root) => existsSync(root) ? readdirSync(root).map((name) => join(root, name)) : []);
    dirs.push(join(repo, 'viewer', 'test', 'fixtures', 'compatibility', '20260720T060000Z_44d2cd5f_4196266b'));
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const findings = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
      const briefing = JSON.parse(readFileSync(join(dir, 'briefing.json'), 'utf8'));
      const coverage = deriveCoverage(findings).items;
      const warning = findings.evidence.some((item) => item.rule_id === 'A-WARN-01');
      if (warning) expect(coverage.find((item) => item.capability === 'official_warnings')?.status).not.toBe('not_assessed');
      useApp.setState({ ...useApp.getInitialState(), language: 'en', findings, briefing, snapshotId: findings.snapshot_id, synoptic: null, route: null, warnings: null }, true);
      render(<Briefing />);
      const labels = { within: 'Within your declared limits', approaching: 'Approaching your limits', exceeds: 'Exceeds your limits', insufficient: 'Models disagree · reassess after the next run', warning_active: 'Official warning active' };
      const state = findings.verdict.warning_override?.active ? 'warning_active' : findings.verdict.state;
      expect(within(screen.getByTestId('decision-band')).getByRole('heading', { level: 1 })).toHaveTextContent(new RegExp(labels[state], 'i'));
      expect(screen.queryByText('Open a snapshot first.')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('map')).toBeInTheDocument();
      if (warning && findings.evidence.find(item => item.rule_id === 'A-WARN-01')?.source_kind === 'emulated') {
        expect(screen.getByText('EMULATED WARNING SCENARIO')).toBeInTheDocument();
      }
      cleanup();
    }
  });
});
