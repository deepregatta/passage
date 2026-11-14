import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import RouteTimeline from '../src/components/RouteTimeline.jsx';
import { useApp } from '../src/stores/appStore.js';
import findings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';

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

it('reads an hour missing a recorded limit value as not assessed, not fine', () => {
  const f = structuredClone(findings);
  // the table reads the hour at the boat's expected position where the check recorded one, so a record's
  // limit statuses live in `expected.limit_status` on multi-point legs and in `limit_status` on the others
  const statuses = (hour) => [hour.limit_status, hour.expected?.limit_status].filter(Boolean);
  for (const leg of f.legs) for (const hour of leg.hours) for (const record of statuses(hour)) for (const key of Object.keys(record)) record[key] = 'ok';
  // the table lists the chart's rows (the expected timing, every third): find the hours of its first four rows
  useApp.setState({ ...useApp.getInitialState(), findings: f }, true);
  const first = render(<RouteTimeline />);
  const listed = within(first.getByText('Table alternative for route timeline').closest('details')).getAllByRole('row', { hidden: true }).slice(1, 5)
    .map((row) => within(row).getAllByRole('cell', { hidden: true }).map((cell) => cell.textContent));
  first.unmount();
  const hourOf = ([, utc, legText]) => {
    const leg = f.legs.find((l) => legText.endsWith(`(leg ${l.leg_id.slice(1)})`));
    return leg.hours.find((h) => h.valid_time.slice(11, 16) === utc && Date.parse(h.valid_time) >= Date.parse(leg.enter_range.nominal) - 1800_000);
  };
  for (const record of statuses(hourOf(listed[0]))) record.wave = 'unknown'; // ok wind, unknown wave
  for (const record of statuses(hourOf(listed[1]))) delete record.steepness; // absent where other hours record it
  for (const record of statuses(hourOf(listed[2]))) record.wave = 'exceeded';
  useApp.setState({ ...useApp.getInitialState(), findings: f }, true);
  render(<RouteTimeline />);
  const rows = within(screen.getByText('Table alternative for route timeline').closest('details')).getAllByRole('row', { hidden: true }).slice(1);
  const status = (i) => within(rows[i]).getAllByRole('cell', { hidden: true }).at(-1).textContent;
  expect(status(0)).toBe('not assessed');
  expect(status(1)).toBe('not assessed');
  expect(status(2)).toBe('exceeded');
  expect(status(3)).toBe('ok');
});
