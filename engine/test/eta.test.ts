import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSchedules, deriveLegs, parseUtc, type Route } from '../src/index.js';

describe('parseUtc', () => {
  it.each([
    '2026-09-17T10:00:00Z',
    '2026-09-17T12:00:00+02:00',
    '2026-09-17T05:00:00-05:00',
    '2026-09-17T15:30:00+05:30',
    '2026-09-17T06:30:00-03:30',
    '2026-09-17T12:00:00+0200',
    '2026-09-17T05:00:00-0500',
    '2026-09-17T10:00:00-00:00',
    '2026-09-17T10:00:00',
    '2026-09-17T10:00',
  ])('resolves %s to the same UTC instant', (timestamp) => {
    expect(parseUtc(timestamp)).toBe(Date.UTC(2026, 8, 17, 10));
  });

  it.each([
    ['2026-09-16T23:30:00-05:00', '2026-09-17T04:30:00Z'],
    ['2026-09-17T00:30:00+02:00', '2026-09-16T22:30:00Z'],
    ['2026-09-17T05:00:00.123-05:00', '2026-09-17T10:00:00.123Z'],
    ['2026-09-17T10:00:00.123', '2026-09-17T10:00:00.123Z'],
    ['2026-09-17', '2026-09-17T00:00:00Z'],
  ])('preserves the instant in %s', (timestamp, expected) => {
    expect(parseUtc(timestamp)).toBe(Date.parse(expected));
  });

  it.each([
    'not-a-date', '2026-09-17T05:00:00-25:00', '2026-09-17T05:00:00+02:60',
  ])('rejects invalid timestamps: %s', (timestamp) => {
    expect(() => parseUtc(timestamp)).toThrow(`Invalid UTC timestamp: ${timestamp}`);
  });
});

describe('public scheduling with UTC offsets', () => {
  const route = JSON.parse(readFileSync(
    new URL('../../config/routes/cherbourg-plymouth.json', import.meta.url), 'utf8',
  )) as Route;
  const legs = deriveLegs(route);

  it.each([
    '2026-09-17T01:00:00-05:00',
    '2026-09-16T23:00:00-07:00',
    '2026-09-17T08:00:00+02:00',
    '2026-09-17T06:00:00',
  ])('keeps ETAs and occupancy hours at the same UTC times for %s', (departure) => {
    const expected = computeSchedules(legs, route.speeds_kt!, '2026-09-17T06:00:00Z');
    const actual = computeSchedules(legs, route.speeds_kt!, departure);
    expect(actual).toEqual(expected);
    expect(actual[0]!.enter.nominal).toBe('2026-09-17T06:00:00Z');
    expect(actual[0]!.occupancy_hours[0]).toBe('2026-09-17T06:00:00Z');
  });
});
