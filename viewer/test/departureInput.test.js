import { expect, it } from 'vitest';
import { nextQuarterHour } from '../src/lib/format.js';
import {
  LAST_DEPARTURE_LEAD_H, PAST_GRACE_MS, departureWindow, horizonText, isCompleteTimeEntry, parseTimeInput, validateDeparture,
} from '../src/pages/planner/departureInput.js';

// Local wall-clock instant, so the table does not depend on the machine's zone.
const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const value = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

it.each([
  ['0830', '08:30'], ['830', '08:30'], ['8', '08:00'], ['08', '08:00'], ['8:30', '08:30'], ['08:30', '08:30'],
  ['08.30', '08:30'], ['8.30', '08:30'], ['8h30', '08:30'], ['8h', '08:00'], ['23:59', '23:59'], ['2359', '23:59'],
  ['0', '00:00'], ['000', '00:00'], ['00:00', '00:00'], [' 9:05 ', '09:05'], ['1745', '17:45'], ['123', '01:23'],
])('reads %j as %s', (typed, expected) => {
  expect(parseTimeInput(typed)).toEqual({ ok: true, value: expected });
});

it.each(['', ' ', '24', '24:00', '2400', '25:00', '8:60', '860', '83', '8:5', '1.5', 'ab', '08:30pm', '12345', '-1', '8:3:0'])(
  'does not read %j', (typed) => {
    expect(parseTimeInput(typed)).toEqual({ ok: false });
  },
);

it('commits while typing only four digits or a full HH:mm', () => {
  expect(['0830', '08:30', '08.30'].every(isCompleteTimeEntry)).toBe(true);
  expect(['8', '83', '830', '08:3', '08:', '08301'].some(isCompleteTimeEntry)).toBe(false);
});

it('rounds a default departure up to the next quarter hour', () => {
  expect(nextQuarterHour(local(2026, 9, 10, 10, 7))).toBe('2026-09-10T10:15');
  expect(nextQuarterHour(local(2026, 9, 10, 10, 15))).toBe('2026-09-10T10:15');
  expect(nextQuarterHour(local(2026, 9, 10, 10, 46))).toBe('2026-09-10T11:00');
  expect(nextQuarterHour(local(2026, 9, 10, 23, 50))).toBe('2026-09-11T00:00');
});

const now = local(2026, 9, 10, 9, 0);

it('derives the date range from the forecast horizon and describes it', () => {
  const window = departureWindow(now);
  expect(LAST_DEPARTURE_LEAD_H).toBe(228);
  expect(window.minDate).toBe('2026-09-10');
  expect(window.maxDate).toBe(value(now + 228 * 3600_000).slice(0, 10));
  expect(window.days).toBe(9);
  expect(horizonText(window)).toMatch(/^Forecasts cover the next 9 days, up to \w{3} \d{1,2} \w{3}$/);
});

it('validates a departure: unreadable, past, inside the window, beyond the forecast', () => {
  expect(validateDeparture('', now)).toMatchObject({ code: 'invalid' });
  expect(validateDeparture('2026-09-10T25:00', now)).toMatchObject({ code: 'invalid', dateIssue: false });
  expect(validateDeparture(value(now - PAST_GRACE_MS - 60_000), now))
    .toEqual({ code: 'past', message: 'Choose a departure that is not in the past', dateIssue: true });
  expect(validateDeparture(value(now - PAST_GRACE_MS + 60_000), now)).toBeNull();
  expect(validateDeparture(value(now), now)).toBeNull();
  expect(validateDeparture(value(now + 228 * 3600_000), now)).toBeNull();
  const beyond = validateDeparture(value(now + 229 * 3600_000), now);
  expect(beyond).toMatchObject({ code: 'beyond', dateIssue: true });
  expect(beyond.message).toBe(`Choose a departure within the forecast, up to ${departureWindow(now).maxLabel}`);
});

it('agrees with the router: the last accepted departure still leaves the hours it needs', async () => {
  const { FORECAST_HOURS, ROUTING_MIN_HOURS } = await import('../src/lib/routingInputs.js');
  expect(LAST_DEPARTURE_LEAD_H).toBe(FORECAST_HOURS - ROUTING_MIN_HOURS);
});
