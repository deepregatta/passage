import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ChangesSection from '../src/pages/briefing/ChangesSection.jsx';
import { fmtTextTime } from '../src/lib/format.js';
import { useApp } from '../src/stores/appStore.js';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import briefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));

beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(findings), briefing: structuredClone(briefing), synoptic, snapshotSource: 'served', page: 'briefing' }, true);
});

it('states the event-onset shift in the header zone and keeps the two times on separate lines', async () => {
  render(<ChangesSection />);
  const heading = await screen.findByText('Event onset at the route');
  const section = heading.closest('section');
  expect(section).toHaveTextContent(`previous · ${fmtTextTime('2026-07-20T09:00:00Z')}`);
  expect(section).toHaveTextContent(`latest · ${fmtTextTime('2026-07-20T06:00:00Z')}`);
  expect(section).toHaveTextContent('3 h earlier');
  expect(section.textContent).not.toMatch(/UTC/);
  expect(section.querySelectorAll('.absolute')).toHaveLength(0);
  expect(section.querySelector('dl').className).toMatch(/text-xs/);
});
