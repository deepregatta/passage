import { describe, expect, it } from 'vitest';
import { fmtLocalTime, localDateTimeToIso, toLocalDateTimeValue } from '../src/lib/format.js';

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
