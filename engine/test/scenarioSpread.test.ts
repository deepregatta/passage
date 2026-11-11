import { describe, expect, it } from 'vitest';
import { quantile, scenarioSpread, SCENARIO_SPREAD_MIN_MEMBERS } from '../src/index.js';
import type { Plume } from '../src/index.js';
import type { Findings } from '../src/types.js';

const H = (n: number) => `2026-07-20T${String(n).padStart(2, '0')}:00:00Z`;

/** Minimal findings: each leg audits the listed hours. */
function findingsFor(legs: Array<{ id: string; hours: number[] }>): Findings {
  return {
    legs: legs.map((leg) => ({ leg_id: leg.id, hours: leg.hours.map((h) => ({ valid_time: H(h) })) })),
  } as unknown as Findings;
}

type Series = Array<number | null>;
function plumeFor(legs: Array<{ id: string; times: number[]; wind?: Series[]; gust?: Series[] }>): Plume {
  return {
    schema_version: 1,
    snapshot_id: 's',
    model: 'test',
    legs: legs.map((leg) => ({
      leg_id: leg.id,
      times: leg.times.map(H),
      gust_limit_kt: 30,
      wind_members: leg.wind ?? [],
      gust_members: leg.gust ?? [],
    })),
  };
}

/** n members whose series is [base + m] at every time (member m has maximum base + m). */
function ramp(n: number, times: number, base = 10): Series[] {
  return Array.from({ length: n }, (_, m) => Array.from({ length: times }, () => base + m));
}

describe('quantile', () => {
  it('interpolates linearly between ranks, as the plume chart always has', () => {
    // [1, 2, 4, 8]: P50 position 1.5 -> 2 + 0.5 * (4 - 2) = 3; P10 position 0.3 -> 1.3; P90 position 2.7 -> 4 + 0.7 * 4 = 6.8
    expect(quantile([1, 2, 4, 8], 0.5)).toBeCloseTo(3, 10);
    expect(quantile([1, 2, 4, 8], 0.1)).toBeCloseTo(1.3, 10);
    expect(quantile([1, 2, 4, 8], 0.9)).toBeCloseTo(6.8, 10);
  });
  it('hits an exact member when the position is whole, and handles one value and none', () => {
    expect(quantile([5, 6, 7], 0.5)).toBe(6);
    expect(quantile([5, 6, 7], 0)).toBe(5);
    expect(quantile([5, 6, 7], 1)).toBe(7);
    expect(quantile([9], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('scenarioSpread', () => {
  it('names the minimum member count', () => {
    expect(SCENARIO_SPREAD_MIN_MEMBERS).toBe(10);
  });

  it('takes each member\'s maximum over the audited hours, then the median and 90th percentile', () => {
    // 11 members: member m peaks at 10 + m -> maxima 10..20; P50 = 15, P90 = position 9 -> 19
    const findings = findingsFor([{ id: 'L1', hours: [3, 4] }]);
    const plume = plumeFor([{ id: 'L1', times: [3, 4], wind: ramp(11, 2), gust: ramp(11, 2, 20) }]);
    expect(scenarioSpread(findings, plume)).toEqual({
      wind: { median: 15, p90: 19, members: 11 },
      gust: { median: 25, p90: 29, members: 11 },
    });
  });

  it('uses the quantile definition by hand: interpolation between ranks', () => {
    // 12 members with maxima 1..12: P50 position 5.5 -> 6.5; P90 position 9.9 -> 10 + 0.9 = 10.9
    const findings = findingsFor([{ id: 'L1', hours: [0] }]);
    const plume = plumeFor([{ id: 'L1', times: [0], wind: ramp(12, 1, 1) }]);
    const result = scenarioSpread(findings, plume)!;
    expect(result.wind!.median).toBeCloseTo(6.5, 10);
    expect(result.wind!.p90).toBeCloseTo(10.9, 10);
  });

  it('ignores plume hours outside the audited hours, however large', () => {
    const findings = findingsFor([{ id: 'L1', hours: [6, 7] }]);
    const wind = ramp(12, 6); // times 4..9: audited are 6 and 7 (indices 2, 3)
    // a huge value at 04Z, 05Z (before) and 08Z, 09Z (after) for every member
    for (const series of wind) { series[0] = 90; series[1] = 90; series[4] = 99; series[5] = 99; }
    const plume = plumeFor([{ id: 'L1', times: [4, 5, 6, 7, 8, 9], wind }]);
    const withOutside = scenarioSpread(findings, plume);
    const inside = plumeFor([{ id: 'L1', times: [6, 7], wind: ramp(12, 2) }]);
    expect(withOutside).toEqual(scenarioSpread(findingsFor([{ id: 'L1', hours: [6, 7] }]), inside));
    expect(withOutside!.wind!.p90).toBeLessThan(30);
  });

  it('uses only each leg\'s own audited hours, and the same member across legs', () => {
    const findings = findingsFor([{ id: 'L1', hours: [1] }, { id: 'L2', hours: [5] }]);
    // member m: 10 + m on leg 1 at 01Z, and 30 - m on leg 2 at 05Z; the other hour of each leg is huge but unaudited
    const l1 = ramp(12, 2); l1.forEach((s) => { s[1] = 99; });
    const l2: Series[] = Array.from({ length: 12 }, (_, m) => [88, 30 - m]);
    const plume = plumeFor([{ id: 'L1', times: [1, 2], wind: l1 }, { id: 'L2', times: [4, 5], wind: l2 }]);
    // maxima: member m -> max(10 + m, 30 - m): m=0..11 -> 30,29,...,20 (m<=10: 30-m>=10+m), m=10: 20 vs 20, m=11: 21
    const maxima = Array.from({ length: 12 }, (_, m) => Math.max(10 + m, 30 - m)).sort((a, b) => a - b);
    const result = scenarioSpread(findings, plume)!;
    expect(result.wind!.median).toBeCloseTo(quantile(maxima, 0.5)!, 10);
    expect(result.wind!.p90).toBeCloseTo(quantile(maxima, 0.9)!, 10);
  });

  it('matches plume legs to findings legs by id, not position', () => {
    const findings = findingsFor([{ id: 'L1', hours: [1] }, { id: 'L2', hours: [1] }]);
    // the plume has only L2 (leg 1 had no ensemble): positional matching would read it as leg 1
    const plume = plumeFor([{ id: 'L2', times: [1], wind: ramp(10, 1, 5) }]);
    expect(scenarioSpread(findings, plume)!.wind).toEqual({ median: 9.5, p90: 13.1, members: 10 });
  });

  it('matches times by instant, not by text', () => {
    const findings = { legs: [{ leg_id: 'L1', hours: [{ valid_time: '2026-07-20T03:00:00+00:00' }] }] } as unknown as Findings;
    const plume = plumeFor([{ id: 'L1', times: [3], wind: ramp(10, 1) }]);
    expect(scenarioSpread(findings, plume)).not.toBeNull();
  });

  it('skips missing values, includes the control member, and counts only members with a value', () => {
    const findings = findingsFor([{ id: 'L1', hours: [0, 1] }]);
    const wind = ramp(14, 2); // member 0 is the control
    wind[3] = [null, null]; // no values at all: not a member here
    wind[4] = [null, 40]; // a null hour is skipped, the other counts
    const result = scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0, 1], wind }]))!;
    expect(result.wind!.members).toBe(13);
    const maxima = wind.map((s) => Math.max(...s.filter((v): v is number => v !== null))).filter(Number.isFinite).sort((a, b) => a - b);
    expect(maxima).toHaveLength(13);
    expect(maxima).toContain(10); // the control member
    expect(result.wind!.p90).toBeCloseTo(quantile(maxima, 0.9)!, 10);
  });

  it('is null with fewer than the minimum number of members, and not with exactly the minimum', () => {
    const findings = findingsFor([{ id: 'L1', hours: [0] }]);
    expect(scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], wind: ramp(9, 1) }]))).toBeNull();
    expect(scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], wind: ramp(10, 1) }]))).not.toBeNull();
    // ten series but only nine with a value
    const sparse = ramp(10, 1);
    sparse[2] = [null];
    expect(scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], wind: sparse }]))).toBeNull();
  });

  it('is null when the plume is missing', () => {
    const findings = findingsFor([{ id: 'L1', hours: [0] }]);
    expect(scenarioSpread(findings, null)).toBeNull();
    expect(scenarioSpread(findings, undefined)).toBeNull();
    expect(scenarioSpread(findings, plumeFor([]))).toBeNull();
  });

  it('returns wind alone when the gust series are absent or too few', () => {
    const findings = findingsFor([{ id: 'L1', hours: [0] }]);
    const noGust = scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], wind: ramp(12, 1) }]))!;
    expect(noGust.gust).toBeNull();
    expect(noGust.wind).not.toBeNull();
    const fewGust = scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], wind: ramp(12, 1), gust: ramp(4, 1) }]))!;
    expect(fewGust.gust).toBeNull();
    const gustOnly = scenarioSpread(findings, plumeFor([{ id: 'L1', times: [0], gust: ramp(12, 1) }]))!;
    expect(gustOnly.wind).toBeNull();
    expect(gustOnly.gust!.members).toBe(12);
  });

  it('is null when no leg has an ensemble time among its audited hours', () => {
    const wind = ramp(12, 2);
    // plume hours exist, but none is an audited hour
    expect(scenarioSpread(findingsFor([{ id: 'L1', hours: [8, 9] }]), plumeFor([{ id: 'L1', times: [1, 2], wind }]))).toBeNull();
    // the leg is absent from the plume
    expect(scenarioSpread(findingsFor([{ id: 'L1', hours: [1] }]), plumeFor([{ id: 'L9', times: [1], wind }]))).toBeNull();
    // the leg audited nothing
    expect(scenarioSpread(findingsFor([{ id: 'L1', hours: [] }]), plumeFor([{ id: 'L1', times: [1], wind }]))).toBeNull();
  });

  it('skips a leg with no ensemble times and still uses the others', () => {
    const findings = findingsFor([{ id: 'L1', hours: [8] }, { id: 'L2', hours: [2] }]);
    const plume = plumeFor([{ id: 'L1', times: [1], wind: ramp(12, 1, 90) }, { id: 'L2', times: [2], wind: ramp(12, 1) }]);
    expect(scenarioSpread(findings, plume)!.wind).toEqual({ median: 15.5, p90: 19.9, members: 12 });
  });

  it('does not mutate its inputs', () => {
    const findings = findingsFor([{ id: 'L1', hours: [0] }]);
    const plume = plumeFor([{ id: 'L1', times: [0], wind: ramp(12, 1) }]);
    const before = JSON.stringify([findings, plume]);
    scenarioSpread(findings, plume);
    expect(JSON.stringify([findings, plume])).toBe(before);
  });
});
