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

it('words the ledger in the header zone, names the low without the leg-like id, and labels evidence chips', async () => {
  const { container } = render(<ChangesSection />);
  await screen.findByText('Event onset at the route');
  const ledger = container.querySelector('details ul');
  expect(ledger.textContent).not.toMatch(/UTC/);
  expect(ledger).toHaveTextContent(`New signal: sustained wind vs your limit near Mid-Channel around ${fmtTextTime('2026-07-20T23:00:00Z')}.`);
  expect(ledger).toHaveTextContent(`gusts vs your limit near Off Omonville-la-Rogue: ${fmtTextTime('2026-07-20T06:00:00Z')} → ${fmtTextTime('2026-07-20T08:00:00Z')} (2 h later).`);
  expect(ledger).toHaveTextContent('The low (L1 on the chart) is the same system as in the previous check. It now reaches the route 3 h earlier.');
  expect(ledger.textContent).not.toMatch(/Low L1|previous briefing/);
  const chips = [...container.querySelectorAll('article .evidence-link')];
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    expect(chip.textContent).toBe('evidence');
    expect(chip.getAttribute('title')).toMatch(/^E\d+$/);
    expect(chip.className).toMatch(/min-h-11/);
    expect(chip.className).toMatch(/text-\[12px\]/);
  }
});
