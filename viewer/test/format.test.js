import { describe, expect, it } from 'vitest';
import { fmtAge, fmtAgeOld, fmtLocalTime, fmtTextClock, fmtTextTime, fmtUtcClock, localDateTimeToIso, runAge, toLocalDateTimeValue } from '../src/lib/format.js';

describe('fmtLocalTime', () => {
  it('uses the browser local timezone for briefing creation timestamps', () => {
    const iso = '2026-07-13T12:39:00Z';
    const date = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const expected = `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    expect(fmtLocalTime(iso)).toBe(expected);
  });
});

describe('planner local time conversion', () => {
  it('round-trips an instant through the browser-local 24-hour value', () => {
    const iso = '2026-07-13T12:39:00.000Z';
    expect(localDateTimeToIso(toLocalDateTimeValue(iso))).toBe(iso);
  });

  it('rejects ambiguous or invalid clock values', () => {
    expect(localDateTimeToIso('2026-07-13T7:30')).toBeNull();
    expect(localDateTimeToIso('2026-07-13T24:00')).toBeNull();
    expect(localDateTimeToIso('2026-02-30T07:30')).toBeNull();
  });
});

describe('text times and ages', () => {
  it('fmtTextTime follows the header zone; fmtUtcClock is a marked UTC secondary', () => {
    const iso = '2026-07-13T12:39:00Z';
    expect(fmtTextTime(iso)).toBe(fmtLocalTime(iso));
    expect(fmtTextClock(iso)).toBe(fmtLocalTime(iso).slice(-5));
    expect(fmtUtcClock(iso)).toBe('12:39 UTC');
    expect(fmtTextTime(null)).toBe('n/a');
  });

  it.each([
    [10 * 60_000, '10 min', 'under 1 h'],
    [5 * 3600_000 + 12 * 60_000, '5 h 12 min', '5 h'],
    [47.4 * 3600_000, '47 h 24 min', '47 h'],
    [48 * 3600_000, '2 days', '2 days'],
    [2726 * 3600_000, '114 days', '114 days'],
    [-5000, '0 min', 'under 1 h'],
  ])('fmtAge(%d ms)', (ms, exact, rounded) => {
    expect(fmtAge(ms, { exact: true })).toBe(exact);
    expect(fmtAge(ms)).toBe(rounded);
  });

  it('runAge and fmtAgeOld share the helper', () => {
    expect(runAge('2026-10-01T09:00:00Z', Date.parse('2026-10-01T14:05:00Z'))).toBe('5 h 05 min');
    expect(runAge('2026-07-19T18:00:00Z', Date.parse('2026-11-10T00:00:00Z'))).toBe('113 days');
    expect(fmtAgeOld(2726 * 3600_000)).toBe('114 days old');
    expect(fmtAgeOld(3 * 3600_000)).toBe('3 h old');
  });
});
