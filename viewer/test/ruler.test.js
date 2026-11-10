import { expect, it } from 'vitest';
import { fmtLocalClock, fmtLocalDay, rulerTicks, spreadMarkers } from '../src/lib/ruler.js';

const HOUR = 3600_000;

it('labels the ruler in browser-local time and marks every local midnight with its day', () => {
  const t0 = new Date(2026, 6, 20, 17, 30).getTime();
  const ticks = rulerTicks(t0, t0 + 36 * HOUR);
  expect(ticks.map((tick) => tick.label)).toEqual(['18:00', '00:00', '06:00', '12:00', '18:00', '00:00']);
  for (const tick of ticks) {
    expect(tick.label).toBe(fmtLocalClock(tick.t));
    expect(tick.day).toBe(tick.label === '00:00' ? fmtLocalDay(tick.t) : null);
  }
  expect(ticks[1].day).toBe(fmtLocalDay(new Date(2026, 6, 21).getTime()));
});

it('thins ticks to 12 h then 24 h steps instead of letting labels collide, keeping midnights', () => {
  const t0 = new Date(2026, 6, 20, 6, 0).getTime();
  const twelve = rulerTicks(t0, t0 + 72 * HOUR, 8);
  expect(twelve.length).toBeLessThanOrEqual(8);
  expect(twelve.every((tick) => ['00:00', '12:00'].includes(tick.label))).toBe(true);
  const daily = rulerTicks(t0, t0 + 200 * HOUR, 8);
  expect(daily.every((tick) => tick.label === '00:00' && tick.day)).toBe(true);
});

it('never lets numbered leg markers touch or leave the bar', () => {
  const spread = spreadMarkers([9, 20, 41, 78, 93, 100], 8);
  for (let i = 1; i < spread.length; i += 1) expect(spread[i] - spread[i - 1]).toBeGreaterThanOrEqual(8 - 1e-9);
  expect(spread[0]).toBeGreaterThanOrEqual(8);
  expect(spread.at(-1)).toBeLessThanOrEqual(100);
  expect(spread[2]).toBe(41);
  expect(spreadMarkers([], 8)).toEqual([]);
});
