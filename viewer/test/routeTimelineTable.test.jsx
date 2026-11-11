import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import RouteTimeline from '../src/components/RouteTimeline.jsx';
import { useApp } from '../src/stores/appStore.js';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));

beforeEach(() => useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(findings) }, true));
afterEach(cleanup);

it('lists the timeline table by place and leg number with the local time first, and grows instead of scrolling', () => {
  render(<RouteTimeline />);
  const details = screen.getByText('Table alternative for route timeline').closest('details');
  const table = within(details).getByRole('table', { hidden: true });
  const headers = within(table).getAllByRole('columnheader', { hidden: true }).map((header) => header.textContent);
  expect(headers.slice(0, 3)).toEqual(['local time', 'UTC', 'leg']);
  const rows = within(table).getAllByRole('row', { hidden: true }).slice(1);
  // the demo is Paris time: 06:00 UTC is 08:00 local, on the first leg
  expect(within(rows[0]).getAllByRole('cell', { hidden: true }).slice(0, 3).map((cell) => cell.textContent))
    .toEqual(['Mon 20 Jul 08:00', '06:00', 'Off Omonville-la-Rogue (leg 1)']);
  // never the engine's raw leg ids
  const legCells = rows.map((row) => within(row).getAllByRole('cell', { hidden: true })[2].textContent);
  expect(legCells.every((text) => !/\bL\d\b/.test(text) && /\(leg \d\)$/.test(text))).toBe(true);
  expect(legCells).toContain('Mid-Channel (leg 4)');
  // the disclosure is part of the page scroll: no height-capped box of its own
  expect(details.innerHTML).not.toMatch(/max-h-|overflow-y/);
  expect(details.querySelector('summary').className).toMatch(/min-h-11/);
});
