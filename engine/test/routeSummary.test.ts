import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeSummary, WIND_BANDS } from '../src/index.js';
import type { Findings, LegHour } from '../src/types.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Findings;
const DEMO = read('../../viewer/test/fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json');
const GOLDEN = read('./golden/findings-cherbourg-plymouth.json');

const H = (n: number) => `2026-07-20T${String(n).padStart(2, '0')}:00:00Z`;
const T = (hour: number, minute = 0) => `2026-07-20T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
const hour = (h: number, wind: number | null, pos: LegHour['point_of_sail'] = 'reach'): LegHour => ({
  valid_time: H(h), wind_kt: wind, gust_kt: null, wind_dir_deg: null, twa_deg: null, point_of_sail: pos,
  limit_status: { sustained: 'ok', gust: 'ok' },
});

interface LegSpec { id: string; enter: string; eta: string; hours: LegHour[] }
/** Legs with a nominal window and the hours they audited; the fast/slow range is made wider than the window, as the engine does. */
function findingsFor(legs: LegSpec[]): Findings {
  return {
    legs: legs.map((leg) => ({
      leg_id: leg.id,
      enter_range: { slow: leg.enter, nominal: leg.enter, fast: leg.enter },
      eta_range: { slow: leg.eta, nominal: leg.eta, fast: leg.eta },
      hours: leg.hours,
    })),
  } as unknown as Findings;
}

const sum = (record: Record<string, number>) => Object.values(record).reduce((a, b) => a + b, 0);

/** An independent reading of a saved findings object: every whole UTC hour inside the passage's nominal span, read from the leg whose nominal window holds it. */
function independentReading(findings: Findings) {
  const legs = findings.legs;
  const start = Date.parse(legs[0]!.enter_range.nominal);
  const end = Date.parse(legs.at(-1)!.eta_range.nominal);
  const HOUR = 3_600_000;
  const sail: Record<string, number> = { upwind: 0, reach: 0, downwind: 0, unknown: 0 };
  const wind = { under: 0, a: 0, b: 0, c: 0, over: 0, unknown: 0 };
  let total = 0;
  for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) {
    const owner = legs.find((leg) => t >= Date.parse(leg.enter_range.nominal) && t < Date.parse(leg.eta_range.nominal))!;
    const hr = owner.hours.find((h) => Date.parse(h.valid_time) === t);
    total += 1;
    sail[hr?.point_of_sail ?? 'unknown'] = (sail[hr?.point_of_sail ?? 'unknown'] ?? 0) + 1;
    const w = hr?.wind_kt;
    if (w === null || w === undefined) wind.unknown += 1;
    else if (w < 10) wind.under += 1;
    else if (w < 15) wind.a += 1;
    else if (w < 20) wind.b += 1;
    else if (w < 25) wind.c += 1;
    else wind.over += 1;
  }
  return { total, sail, wind, nominalHours: (end - start) / HOUR };
}

describe('routeSummary', () => {
  it('names the wind bands as half-open ranges in kt', () => {
    expect(WIND_BANDS.map((b) => [b.from, b.to])).toEqual([[0, 10], [10, 15], [15, 20], [20, 25], [25, Infinity]]);
  });

  it('puts the edge values in the upper band: 10, 15, 20 and 25 kt start a band', () => {
    const winds = [0, 9.99, 10, 14.99, 15, 19.99, 20, 24.99, 25, 60];
    const findings = findingsFor([{ id: 'L1', enter: H(0), eta: H(10), hours: winds.map((w, i) => hour(i, w)) }]);
    expect(routeSummary(findings)!.by_wind_band).toEqual({
      under_10: 2, from_10_to_15: 2, from_15_to_20: 2, from_20_to_25: 2, from_25_up: 2, unknown: 0,
    });
  });

  it('uses the sustained wind (wind_kt), never the gust', () => {
    const calm: LegHour = { ...hour(0, 8), gust_kt: 40 };
    const findings = findingsFor([{ id: 'L1', enter: H(0), eta: H(1), hours: [calm] }]);
    expect(routeSummary(findings)!.by_wind_band.under_10).toBe(1);
  });

  it('counts hours by point of sail', () => {
    const findings = findingsFor([{
      id: 'L1', enter: H(0), eta: H(6),
      hours: [hour(0, 12, 'upwind'), hour(1, 12, 'upwind'), hour(2, 12, 'reach'), hour(3, 12, 'downwind'), hour(4, 12, 'downwind'), hour(5, 12, 'downwind')],
    }]);
    expect(routeSummary(findings)!.by_point_of_sail).toEqual({ upwind: 2, reach: 1, downwind: 3, unknown: 0 });
  });

  it('counts hours with no wind value or no point of sail as unknown, so the buckets always sum to the total', () => {
    const findings = findingsFor([{
      id: 'L1', enter: H(0), eta: H(5),
      hours: [hour(0, null, 'upwind'), hour(1, 12, null), hour(2, Number.NaN, 'reach'), hour(3, -1, 'reach'), hour(4, 12, 'reach')],
    }]);
    const summary = routeSummary(findings)!;
    expect(summary.total_hours).toBe(5);
    expect(summary.by_wind_band.unknown).toBe(3);
    expect(summary.by_wind_band.from_10_to_15).toBe(2);
    expect(summary.by_point_of_sail).toEqual({ upwind: 1, reach: 3, downwind: 0, unknown: 1 });
    expect(sum(summary.by_wind_band)).toBe(summary.total_hours);
    expect(sum(summary.by_point_of_sail)).toBe(summary.total_hours);
  });

  it('assigns an hour to the leg whose nominal window holds its start, with the end of a window excluded', () => {
    // L1 holds 00:00 to 02:30 (starts 00, 01, 02); L2 holds 02:30 to 05:00 (starts 03, 04). Both audited hours 00 to 06 (overlap).
    const all = (wind: number) => [0, 1, 2, 3, 4, 5, 6].map((h) => hour(h, wind));
    const findings = findingsFor([
      { id: 'L1', enter: T(0), eta: T(2, 30), hours: all(8) },
      { id: 'L2', enter: T(2, 30), eta: T(5), hours: all(22) },
    ]);
    const summary = routeSummary(findings)!;
    expect(summary.total_hours).toBe(5);
    expect(summary.by_wind_band.under_10).toBe(3);
    expect(summary.by_wind_band.from_20_to_25).toBe(2);
  });

  it('includes the hour that starts exactly at a window start and excludes one that starts at its end', () => {
    const findings = findingsFor([
      { id: 'L1', enter: H(0), eta: H(2), hours: [0, 1, 2, 3].map((h) => hour(h, 8)) },
      { id: 'L2', enter: H(2), eta: H(4), hours: [0, 1, 2, 3, 4].map((h) => hour(h, 18)) },
    ]);
    const summary = routeSummary(findings)!;
    expect(summary.total_hours).toBe(4);
    expect(summary.by_wind_band.under_10).toBe(2); // 00 and 01 from L1
    expect(summary.by_wind_band.from_15_to_20).toBe(2); // 02 and 03 from L2
  });

  it('never counts one hour twice, even when two windows overlap', () => {
    const findings = findingsFor([
      { id: 'L1', enter: H(0), eta: H(4), hours: [0, 1, 2, 3].map((h) => hour(h, 8)) },
      { id: 'L2', enter: H(2), eta: H(6), hours: [2, 3, 4, 5].map((h) => hour(h, 18)) },
    ]);
    const summary = routeSummary(findings)!;
    expect(summary.total_hours).toBe(6);
    expect(summary.by_wind_band.under_10).toBe(4);
    expect(summary.by_wind_band.from_15_to_20).toBe(2);
  });

  it('assigns hours given with an offset ISO time by the instant, not the text', () => {
    // 02:00+02:00 is 00:00Z; the leg's window is written in UTC
    const offset = (h: number, wind: number): LegHour => ({ ...hour(h, wind), valid_time: `2026-07-20T${String(h + 2).padStart(2, '0')}:00:00+02:00` });
    const findings = findingsFor([{ id: 'L1', enter: H(0), eta: H(3), hours: [0, 1, 2, 3].map((h) => offset(h, 12)) }]);
    const summary = routeSummary(findings)!;
    expect(summary.total_hours).toBe(3); // 00, 01, 02 Z; 03 Z is the window's end
    expect(summary.by_wind_band.from_10_to_15).toBe(3);
  });

  it('keeps the total within one hour of the nominal passage time over many short legs, with no hour counted twice', () => {
    // 30 legs of 20 minutes from 00:10, each auditing the whole-hour starts around its (wider) arrival range
    const start = Date.parse(T(0, 10));
    const legs: LegSpec[] = Array.from({ length: 30 }, (_, i) => {
      const enter = new Date(start + i * 20 * 60_000);
      const eta = new Date(start + (i + 1) * 20 * 60_000);
      const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
      return { id: `L${i + 1}`, enter: iso(enter), eta: iso(eta), hours: Array.from({ length: 14 }, (_, h) => hour(h, 8 + (h % 3) * 6)) };
    });
    const summary = routeSummary(findingsFor(legs))!;
    const nominalHours = 30 * 20 / 60; // 10 h
    expect(Math.abs(summary.total_hours - nominalHours)).toBeLessThanOrEqual(1);
    // each whole hour start 01:00 to 10:00 inside [00:10, 10:10) is held by exactly one leg
    expect(summary.total_hours).toBe(10);
    expect(sum(summary.by_wind_band)).toBe(10);
    expect(sum(summary.by_point_of_sail)).toBe(10);
  });

  it('returns null without usable hours', () => {
    expect(routeSummary(null)).toBeNull();
    expect(routeSummary(undefined)).toBeNull();
    expect(routeSummary({ legs: [] } as unknown as Findings)).toBeNull();
    expect(routeSummary(findingsFor([{ id: 'L1', enter: H(0), eta: H(3), hours: [] }]))).toBeNull();
    // hours that all fall outside the leg's nominal window
    expect(routeSummary(findingsFor([{ id: 'L1', enter: T(0, 10), eta: T(0, 50), hours: [hour(0, 10), hour(1, 10)] }]))).toBeNull();
    // an unreadable window
    expect(routeSummary(findingsFor([{ id: 'L1', enter: 'not a time', eta: H(3), hours: [hour(0, 10)] }]))).toBeNull();
  });

  describe.each([['the demo snapshot', DEMO], ['the Cherbourg to Plymouth golden', GOLDEN]] as Array<[string, Findings]>)('on %s', (_name, findings) => {
    it('adds up to the nominal passage time within one hour, with every bucket set summing to the total', () => {
      const summary = routeSummary(findings)!;
      const reading = independentReading(findings);
      expect(Math.abs(summary.total_hours - reading.nominalHours)).toBeLessThanOrEqual(1);
      expect(summary.total_hours).toBe(reading.total);
      expect(sum(summary.by_point_of_sail)).toBe(summary.total_hours);
      expect(sum(summary.by_wind_band)).toBe(summary.total_hours);
    });

    it('matches an independent reading of the fixture', () => {
      const summary = routeSummary(findings)!;
      const reading = independentReading(findings);
      expect(summary.by_point_of_sail).toEqual(reading.sail);
      expect(summary.by_wind_band).toEqual({
        under_10: reading.wind.under, from_10_to_15: reading.wind.a, from_15_to_20: reading.wind.b,
        from_20_to_25: reading.wind.c, from_25_up: reading.wind.over, unknown: reading.wind.unknown,
      });
    });

    it('counts fewer hours than the legs audited, because the arrival ranges overlap', () => {
      const audited = findings.legs.reduce((n, leg) => n + leg.hours.length, 0);
      expect(routeSummary(findings)!.total_hours).toBeLessThan(audited);
    });
  });
});
