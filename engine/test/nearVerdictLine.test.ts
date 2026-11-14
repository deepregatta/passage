/**
 * The comparison's near-line mark: `worst_reading_ratio` (the worst reading over
 * every audited leg-hour row) and `near_verdict_line` (that reading decides the
 * verdict and sits within NEAR_VERDICT_LINE_MARGIN of a verdict line). Both are
 * additive candidate fields that nothing ranks on.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import { evidenceLimitRatio } from '../src/findings.js';
import { RULES } from '../src/findings/rules.js';
import {
  NEAR_VERDICT_LINE_MARGIN, nearVerdictLine, rankCandidates, scanDepartures, worstReadingRatio,
  type ScanOptions, type WindowCandidate,
} from '../src/window.js';
import type { Findings, LegHour, LimitsProfile, VerdictState } from '../src/types.js';

vi.mock('../src/analyze.js', () => ({ runAnalysis: vi.fn() }));
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const profile: LimitsProfile = read('../../config/profiles/default-limits.json');
const base: ScanOptions = {
  route: read('../../config/routes/cherbourg-plymouth.json'),
  profile,
  store: {} as ScanOptions['store'],
  currentInput: {},
};

describe('nearVerdictLine', () => {
  it('uses one named margin of 0.10 of the limit', () => {
    expect(NEAR_VERDICT_LINE_MARGIN).toBe(0.10);
  });

  it.each([
    // [verdict, ratio, marked]
    ['within', 0.649, false], ['within', 0.65, false], ['within', 0.651, true], ['within', 0.749, true],
    ['approaching', 0.75, true], ['approaching', 0.849, true], ['approaching', 0.85, false], ['approaching', 0.851, false],
    ['approaching', 0.875, false], ['approaching', 0.899, false], ['approaching', 0.90, false], ['approaching', 0.901, true],
    ['approaching', 1, true], ['exceeds', 1.001, true], ['exceeds', 1.099, true], ['exceeds', 1.10, false], ['exceeds', 1.101, false],
    ['within', 0.3, false], ['exceeds', 2, false],
  ] as Array<[VerdictState, number, boolean]>)('%s at %s of the limit: %s', (verdict, ratio, marked) => {
    expect(nearVerdictLine(verdict, ratio, 0.75)).toBe(marked);
  });

  it('reads the approaching line from the profile, never a fixed 0.75', () => {
    expect(nearVerdictLine('within', 0.62, 0.6)).toBe(false); // over 0.6: the reading says approaching
    expect(nearVerdictLine('approaching', 0.62, 0.6)).toBe(true);
    expect(nearVerdictLine('within', 0.51, 0.6)).toBe(true);
    expect(nearVerdictLine('within', 0.49, 0.6)).toBe(false);
    expect(nearVerdictLine('within', 0.7, 0.8)).toBe(false); // 0.10 under 0.8: outside
    expect(nearVerdictLine('within', 0.71, 0.8)).toBe(true);
    expect(nearVerdictLine('within', 0.7, 0.75)).toBe(true);
  });

  it('is false without a reading', () => {
    for (const ratio of [null, undefined, Number.NaN, Infinity]) expect(nearVerdictLine('approaching', ratio, 0.75)).toBe(false);
  });

  it('is false when the verdict is not the one the reading gives, or is not a limit verdict', () => {
    // scenarios (or squall potential, a gate, wind against current) raised a "within" reading to approaching
    expect(nearVerdictLine('approaching', 0.7, 0.75)).toBe(false);
    // visibility made a time exceed while the reading is approaching
    expect(nearVerdictLine('exceeds', 0.95, 0.75)).toBe(false);
    expect(nearVerdictLine('within', 1.05, 0.75)).toBe(false);
    expect(nearVerdictLine('insufficient', 0.95, 0.75)).toBe(false);
    expect(nearVerdictLine('warning_active', 1.05, 0.75)).toBe(false);
  });
});

const hour = (values: Partial<LegHour>): LegHour => ({
  valid_time: '2026-07-12T06:00:00Z', wind_kt: null, gust_kt: null, wind_dir_deg: null, twa_deg: null, point_of_sail: null,
  limit_status: { sustained: 'unknown', gust: 'unknown' }, ...values,
});
const findingsWith = (hours: LegHour[][]): Findings => ({ legs: hours.map((h) => ({ hours: h })) } as unknown as Findings);

describe('worstReadingRatio', () => {
  it('takes the largest ratio over every row, ok hours included, each wind against its point of sail', () => {
    const findings = findingsWith([
      [hour({ wind_kt: 9, point_of_sail: 'upwind' }), hour({ gust_kt: 14 })], // 0.5, 0.5
      [hour({ wind_kt: 11, point_of_sail: 'reach' })], // 0.44
      [hour({ wind_kt: 11 })], // no point of sail: the default limit, 0.5
    ]);
    expect(worstReadingRatio(findings, profile)).toBe(0.5);
    expect(worstReadingRatio(findingsWith([[hour({ wind_kt: 12.6, point_of_sail: 'upwind' })]]), profile)).toBeCloseTo(0.7);
  });

  it('counts wave height and steepness only when the profile declares them', () => {
    const findings = findingsWith([[hour({ wind_kt: 2, waves: { hs_m: 2, period_s: 5, steepness: 0.04 } as LegHour['waves'] })]]);
    expect(worstReadingRatio(findings, profile)).toBeCloseTo(0.04 / 0.045);
    const noSteepness = { ...profile, max_steepness: undefined };
    expect(worstReadingRatio(findings, noSteepness)).toBeCloseTo(2 / 2.5);
    expect(worstReadingRatio(findings, { ...noSteepness, max_wave_height_m: undefined })).toBeCloseTo(2 / 22);
  });

  it('leaves visibility out and is null when no row has a value', () => {
    expect(worstReadingRatio(findingsWith([[hour({ visibility_nm: 0.1 })]]), profile)).toBeNull();
    expect(worstReadingRatio(findingsWith([[hour({})], []]), profile)).toBeNull();
    expect(worstReadingRatio(findingsWith([]), profile)).toBeNull();
  });

  it('agrees with the evidence ratio of the wind, gust, wave and steepness evidence on the committed findings', () => {
    const findings = read('./golden/findings-cherbourg-plymouth.json') as Findings;
    const reading = new Set<string>([RULES.SUSTAINED, RULES.GUST, RULES.WAVE_HEIGHT, RULES.STEEPNESS]);
    const evidenceRatios = findings.evidence.filter((e) => reading.has(e.rule_id)).map((e) => evidenceLimitRatio(e)!);
    expect(evidenceRatios.length).toBeGreaterThan(0);
    expect(worstReadingRatio(findings, profile)).toBeCloseTo(Math.max(...evidenceRatios), 12);
  });
});

/** Golden findings with every reading and all evidence cleared but one gust, and the given verdict. */
function audit(verdict: VerdictState, gustRatio: number | null): AnalyzeResult {
  const findings = read('./golden/findings-cherbourg-plymouth.json') as Findings;
  findings.evidence = [];
  for (const leg of findings.legs) {
    for (const h of leg.hours) {
      h.wind_kt = null; h.gust_kt = null; h.waves = null;
    }
  }
  if (gustRatio !== null) findings.legs[1]!.hours[0]!.gust_kt = gustRatio * profile.max_gust_kt;
  findings.verdict.state = verdict;
  return { findings } as AnalyzeResult;
}
const at = (i: number) => new Date(Date.parse('2026-07-12T00:00:00Z') + i * 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('scan candidates', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('carry the worst reading for every verdict, "within" included, and the mark only where the reading decides', async () => {
    const cases: Array<[VerdictState, number | null, boolean]> = [
      ['within', 0.5, false], ['within', 0.7, true], ['approaching', 0.8, true], ['approaching', 0.88, false],
      ['exceeds', 1.05, true], ['exceeds', 1.3, false],
      ['approaching', 0.7, false], // decided by scenarios (or another non-reading cause)
      ['exceeds', 0.95, false], // decided by visibility
      ['insufficient', 0.95, false], ['warning_active', 1.05, false], ['within', null, false],
    ];
    for (const [verdict, ratio] of cases) vi.mocked(runAnalysis).mockResolvedValueOnce(audit(verdict, ratio));
    const progress: WindowCandidate[] = [];
    const scan = await scanDepartures(base, cases.map((_, i) => at(i)), (c) => progress.push(c));
    expect(scan.candidates.map((c) => c.worst_reading_ratio)).toEqual(cases.map(([, ratio]) => ratio));
    expect(scan.candidates.map((c) => c.near_verdict_line)).toEqual(cases.map(([, , marked]) => marked));
    // without evidence worst_ratio stays null (as for every "within" time): the new field is separate
    expect(scan.candidates.map((c) => c.worst_ratio).every((r) => r === null)).toBe(true);
    expect(progress.map((c) => c.near_verdict_line)).toEqual(cases.map(([, , marked]) => marked));
  });

  it('applies the margin to the unrounded reading', async () => {
    // 0.6504 rounds to 0.65, which alone would be outside the margin
    vi.mocked(runAnalysis).mockResolvedValueOnce(audit('within', 0.6504)).mockResolvedValueOnce(audit('within', 0.6496));
    const scan = await scanDepartures(base, [at(0), at(1)]);
    expect(scan.candidates.map((c) => [c.worst_reading_ratio, c.near_verdict_line])).toEqual([[0.65, true], [0.65, false]]);
  });

  it('reads the approaching ratio from the profile', async () => {
    vi.mocked(runAnalysis).mockResolvedValueOnce(audit('within', 0.55));
    const scan = await scanDepartures({ ...base, profile: { ...profile, approaching_ratio: 0.6 } }, [at(0)]);
    expect(scan.candidates[0]!.near_verdict_line).toBe(true);
  });
});

describe('ranking ignores the new fields', () => {
  it('gives the same mark and ties in both modes with and without them', () => {
    const golden = read('./golden/scan-cherbourg-plymouth.json').scan.candidates as WindowCandidate[];
    expect(golden.every((c) => 'worst_reading_ratio' in c && 'near_verdict_line' in c)).toBe(true);
    const stripped = golden.map(({ worst_reading_ratio: _r, near_verdict_line: _n, ...rest }) => rest);
    // the same candidates with opposite marks and readings must not move anything either
    const flipped = golden.map((c) => ({ ...c, worst_reading_ratio: 0, near_verdict_line: !c.near_verdict_line }));
    for (const mode of ['typical', 'cautious'] as const) {
      const expected = rankCandidates(stripped, { mode });
      expect(rankCandidates(golden, { mode })).toEqual(expected);
      expect(rankCandidates(flipped, { mode })).toEqual(expected);
    }
  });
});
