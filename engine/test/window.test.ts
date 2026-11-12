import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import { RANK_HOUR_TIE_TOLERANCE, RANK_TIE_TOLERANCE, candidateDepartures, passageLimitHours, presentLimits, rankCandidates, scanDepartures, type RankMode, type ScanOptions, type WindowCandidate } from '../src/window.js';
import type { Evidence, Findings, Route } from '../src/types.js';

vi.mock('../src/analyze.js', () => ({ runAnalysis: vi.fn() }));
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const base: ScanOptions = {
  route: read('../../config/routes/cherbourg-plymouth.json'),
  profile: read('../../config/profiles/default-limits.json'),
  store: {} as ScanOptions['store'],
  currentInput: {}, // Analysis is mocked here; source selection is exercised by currentAdmission.
};
const departures = ['2026-07-12T06:00:00Z', '2026-07-12T12:00:00Z', '2026-07-12T18:00:00Z'];
function result(value = 1): AnalyzeResult {
  const findings = read('./golden/findings-cherbourg-plymouth.json') as Findings;
  const evidence: Evidence = { ...findings.evidence[0]!, rule_id: 'V-VIS-01', value, limit: 2, units: 'nm' };
  delete evidence.member_fraction;
  findings.evidence = [evidence];
  findings.verdict.state = 'exceeds';
  return { findings } as AnalyzeResult;
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runAnalysis).mockResolvedValue(result()); });

it('returns per-departure analysis and routing failures while continuing with the candidate-specific route', async () => {
  vi.mocked(runAnalysis).mockRejectedValueOnce(new Error('Tile service unavailable')).mockResolvedValueOnce(result());
  const route: Route = { ...base.route, route_id: 'rerouted' };
  const routeFor = vi.fn((departure: string) => {
    if (departure === departures[1]) throw new Error('No sea route found');
    return route;
  });
  const onCandidate = vi.fn();
  const scan = await scanDepartures({ ...base, routeFor }, departures, onCandidate);
  expect(scan).toMatchObject({
    skipped: [
      { departure_utc: departures[0], reason: 'Tile service unavailable' },
      { departure_utc: departures[1], reason: 'No sea route found' },
    ], best_index: 0,
  });
  expect(scan.candidates.map(c => c.departure_utc)).toEqual([departures[2]]);
  expect(onCandidate).toHaveBeenCalledTimes(1);
  expect(runAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ route, store: base.store, departureUtc: departures[2] }));
});

it('keeps reasons when all candidates fail, including non-Error throws', async () => {
  vi.mocked(runAnalysis).mockRejectedValueOnce('Forecast horizon exceeded').mockRejectedValueOnce(null);
  expect(await scanDepartures(base, departures.slice(0, 2))).toEqual({
    candidates: [], best_index: null, skipped: [
      { departure_utc: departures[0], reason: 'Forecast horizon exceeded' },
      { departure_utc: departures[1], reason: 'Unknown error' },
    ],
  });
});

it('ranks lower visibility as worse, including zero visibility', async () => {
  vi.mocked(runAnalysis).mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0.5)).mockResolvedValueOnce(result(1));
  const scan = await scanDepartures(base, departures);
  expect(scan.candidates.map(c => c.worst_ratio)).toEqual([Infinity, 4, 2]);
  expect(scan.best_index).toBe(2);
  expect(scan).toHaveProperty('skipped', []);
});

it('retains maximum-limit and ensemble ranking semantics', async () => {
  const analyzed = result();
  analyzed.findings.evidence[0] = { ...analyzed.findings.evidence[0]!, rule_id: 'W-GUST-01', value: 30, limit: 20 };
  analyzed.findings.evidence.push({ ...analyzed.findings.evidence[0]!, value: 100, member_fraction: { exceed: 3, total: 10 } });
  vi.mocked(runAnalysis).mockResolvedValue(analyzed);
  const scan = await scanDepartures(base, departures.slice(0, 1));
  expect(scan.candidates[0]).toMatchObject({ worst_ratio: 1.5, max_fraction: 0.3 });
});

it('returns an empty scan without invoking analysis for no departures', async () => {
  expect(await scanDepartures(base, [])).toEqual({ candidates: [], best_index: null, skipped: [] });
  expect(runAnalysis).not.toHaveBeenCalled();
});

it('rounds candidate departures upward on the UTC grid and includes the horizon boundary', () => {
  expect(candidateDepartures(Date.parse('2026-07-20T05:00:00Z'), 13, 6)).toEqual([
    '2026-07-20T06:00:00Z', '2026-07-20T12:00:00Z', '2026-07-20T18:00:00Z',
  ]);
  expect(candidateDepartures(Date.parse('2026-07-20T06:00:00Z'), 0, 6)).toEqual(['2026-07-20T06:00:00Z']);
});

it('ranks verdict severity before ratios and retains the first candidate on ties', async () => {
  const worse = result(10), better = result(1);
  better.findings.verdict.state = 'within';
  vi.mocked(runAnalysis).mockResolvedValueOnce(worse).mockResolvedValueOnce(better).mockResolvedValueOnce(better);
  const scan = await scanDepartures(base, departures);
  expect(scan.candidates.map(candidate => candidate.worst_ratio)).toEqual([0.2, 2, 2]);
  expect(scan.best_index).toBe(1);
});

it('audits every candidate with its own departure and the route returned for that departure', async () => {
  // Only the last call used to be asserted: a scan that reused one departure or one route would pass.
  const routes = new Map(departures.map((departure, i) => [departure, { ...base.route, route_id: `route-${i}` } as Route]));
  const routeFor = vi.fn((departure: string) => routes.get(departure)!);
  await scanDepartures({ ...base, routeFor }, departures);
  expect(runAnalysis).toHaveBeenCalledTimes(departures.length);
  departures.forEach((departure, i) => {
    const call = vi.mocked(runAnalysis).mock.calls[i]![0];
    expect(call.departureUtc).toBe(departure);
    expect(call.route).toBe(routes.get(departure));
  });
  expect(new Set(vi.mocked(runAnalysis).mock.calls.map(([options]) => options.departureUtc)).size).toBe(departures.length);
});

type Counts = { exceed: number; total: number } | null;
/** An analysis whose audited hours carry exactly these ensemble counts (and matching evidence). */
function withEnsemble(counts: { gust?: Counts; sustained?: Counts } | null): AnalyzeResult {
  const analyzed = result();
  for (const leg of analyzed.findings.legs) {
    for (const hour of leg.hours) {
      if (counts === null) delete hour.exceedance;
      else hour.exceedance = { gust: counts.gust ?? null, sustained: counts.sustained ?? null };
    }
  }
  for (const kind of ['gust', 'sustained'] as const) {
    const count = counts?.[kind];
    if (count && count.exceed > 0) {
      analyzed.findings.evidence.push({ ...analyzed.findings.evidence[0]!, rule_id: kind === 'gust' ? 'W-GUST-ENS-01' : 'W-WIND-ENS-01', value: count.exceed, member_fraction: count });
    }
  }
  return analyzed;
}

it.each([
  ['no ensemble at all', null, false, null],
  ['exceedance set but both counts null', { gust: null, sustained: null }, false, null],
  ['covered, no scenario exceeds', { gust: { exceed: 0, total: 31 }, sustained: { exceed: 0, total: 31 } }, true, { exceed: 0, total: 31 }],
  ['covered by the sustained count only', { sustained: { exceed: 0, total: 30 } }, true, { exceed: 0, total: 30 }],
  ['covered, some scenarios exceed', { gust: { exceed: 6, total: 31 }, sustained: { exceed: 2, total: 31 } }, true, { exceed: 6, total: 31 }],
])('reports ensemble coverage and the counts behind the worst fraction: %s', async (_name, counts, covered, members) => {
  vi.mocked(runAnalysis).mockResolvedValue(withEnsemble(counts));
  const { candidates } = await scanDepartures(base, departures.slice(0, 1));
  expect(candidates[0]).toMatchObject({ ensemble_covered: covered, max_members: members });
  // the ranker counts a covered candidate with nothing exceeding as 0; the candidate itself keeps null
  if (covered && members?.exceed === 0) expect(candidates[0]!.max_fraction).toBeNull();
  if (members?.exceed) expect(candidates[0]!.max_fraction).toBe(Math.round((members.exceed / members.total) * 100) / 100);
});

/** A candidate for the ranker; without the hour figures unless given (as an older scan's would be). */
type Rankable = Parameters<typeof rankCandidates>[0][number];
function candidate(over: Partial<WindowCandidate> = {}): Rankable {
  return {
    departure_utc: '2026-07-12T06:00:00Z', verdict: 'within', worst_ratio: 0.5, max_fraction: null,
    ensemble_covered: true, max_members: null, driver_summary: null, passage_h: 10, ...over,
  };
}
const ratios = (...values: Array<number | null>) => values.map(worst_ratio => candidate({ worst_ratio }));

it('exports the tie tolerance as 5 % of the limit', () => {
  expect(RANK_TIE_TOLERANCE).toBe(0.05);
});

it('ranks nothing for no candidates', () => {
  expect(rankCandidates([])).toEqual({ best_index: null, tied_indices: [] });
  expect(rankCandidates([], { mode: 'cautious' })).toEqual({ best_index: null, tied_indices: [] });
});

it('defaults to typical: severity, then ratio, first candidate on equal values', () => {
  const list = [candidate({ verdict: 'exceeds', worst_ratio: 0.1 }), candidate({ worst_ratio: 0.9 }), candidate({ worst_ratio: 0.4 }), candidate({ worst_ratio: 0.4 })];
  expect(rankCandidates(list)).toEqual({ best_index: 2, tied_indices: [3] });
  expect(rankCandidates(list, { mode: 'typical' })).toEqual(rankCandidates(list));
});

it('typical ignores the ensemble entirely', () => {
  const list = [candidate({ worst_ratio: 1, max_fraction: 0.9 }), candidate({ worst_ratio: 2, max_fraction: 0 })];
  expect(rankCandidates(list, { mode: 'typical' }).best_index).toBe(0);
});

it('treats a missing ratio as 0, like the scan always did', () => {
  expect(rankCandidates(ratios(null, 0.5)).best_index).toBe(0);
  expect(rankCandidates(ratios(0.5, null)).best_index).toBe(1);
});

it('ties times within the tolerance of the best, inclusive, and not beyond it', () => {
  // 1.05 - 1 is 0.05000000000000004 in floating point: the edge must still count as inside
  expect(rankCandidates(ratios(1, 1.05))).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates(ratios(1.05, 1))).toEqual({ best_index: 1, tied_indices: [0] });
  expect(rankCandidates(ratios(1, 1.06))).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates(ratios(1, 1.02, 1.06, 0.97))).toEqual({ best_index: 3, tied_indices: [0, 1] });
});

it('honours a caller-supplied tolerance', () => {
  expect(rankCandidates(ratios(1, 1.3), { tolerance: 0.3 }).tied_indices).toEqual([1]);
  expect(rankCandidates(ratios(1, 1.01), { tolerance: 0 }).tied_indices).toEqual([]);
  expect(rankCandidates(ratios(1, 1), { tolerance: 0 }).tied_indices).toEqual([1]);
});

it('never moves the mark with the tolerance: the best stays the exact minimum', () => {
  expect(rankCandidates(ratios(1.04, 1.0)).best_index).toBe(1);
  expect(rankCandidates(ratios(1.04, 1.0), { tolerance: 10 }).best_index).toBe(1);
});

it('never ties candidates of different verdict severity', () => {
  const list = [candidate({ worst_ratio: 1 }), candidate({ verdict: 'approaching', worst_ratio: 1 }), candidate({ verdict: 'exceeds', worst_ratio: 1 })];
  expect(rankCandidates(list)).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates(list, { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [] });
});

it('ties two infinite ratios but never an infinite and a finite one, without NaN', () => {
  expect(rankCandidates(ratios(Infinity, Infinity))).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates(ratios(Infinity, 1e9))).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates(ratios(1e9, Infinity))).toEqual({ best_index: 0, tied_indices: [] });
  const mixed = rankCandidates(ratios(Infinity, 3, Infinity, 3.04));
  expect(mixed).toEqual({ best_index: 1, tied_indices: [3] });
  expect(Number.isNaN(mixed.best_index)).toBe(false);
  const cautious = rankCandidates(ratios(Infinity, Infinity, 2), { mode: 'cautious' });
  expect(cautious).toEqual({ best_index: 2, tied_indices: [] });
});

const fractions = (...values: Array<number | null>) => values.map(max_fraction => candidate({ max_fraction, worst_ratio: 0.5 }));

it('cautious ranks severity, then ensemble fraction, then ratio', () => {
  const list = [
    candidate({ worst_ratio: 0.1, max_fraction: 0.3 }),
    candidate({ worst_ratio: 0.9, max_fraction: 0.1 }),
    candidate({ worst_ratio: 0.2, max_fraction: 0.1 }),
    candidate({ verdict: 'exceeds', worst_ratio: 0.1, max_fraction: 0 }),
  ];
  expect(rankCandidates(list, { mode: 'cautious' }).best_index).toBe(2);
  expect(rankCandidates(list, { mode: 'typical' }).best_index).toBe(0);
});

it('cautious ties on one scenario of 31 but not on two', () => {
  expect(rankCandidates(fractions(0, 0.03), { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates(fractions(0, 0.05), { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates(fractions(0, 0.06), { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates(fractions(0.09, 0.03), { mode: 'cautious' })).toEqual({ best_index: 1, tied_indices: [] });
});

it('cautious counts a covered candidate with no exceeding scenario as 0', () => {
  expect(rankCandidates(fractions(null, 0.03, 0.1), { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates(fractions(0.03, null), { mode: 'cautious' })).toEqual({ best_index: 1, tied_indices: [0] });
});

it('cautious needs the ratio to be close as well, so a calm window does not tie everything', () => {
  // every fraction is 0 (a calm, covered window): the readings must stay as discriminating as typical
  const calm = [0.2, 0.9, 0.22, 1.5].map(worst_ratio => candidate({ worst_ratio, max_fraction: null }));
  expect(rankCandidates(calm, { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [2] });
  expect(rankCandidates(calm, { mode: 'cautious' })).toEqual(rankCandidates(calm, { mode: 'typical' }));
});

it('cautious ranks a candidate with no ensemble after covered ones and never ties it with them', () => {
  const none = candidate({ ensemble_covered: false, max_fraction: null, max_members: null, worst_ratio: 0.1 });
  const covered = candidate({ max_fraction: 0.2, worst_ratio: 0.9 });
  expect(rankCandidates([none, covered], { mode: 'cautious' })).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([none, covered], { mode: 'typical' }).best_index).toBe(0);
  // two uncovered times compare on the ratio
  expect(rankCandidates([none, { ...none, worst_ratio: 0.12 }], { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [1] });
});

it('cautious takes a candidate with a fraction as covered even without the flag', () => {
  const { ensemble_covered: _drop, ...legacy } = candidate({ max_fraction: 0.1 });
  expect(rankCandidates([candidate({ ensemble_covered: false, max_fraction: null }), legacy as Rankable], { mode: 'cautious' }).best_index).toBe(1);
});

it('cautious keeps the first candidate on equal values', () => {
  expect(rankCandidates(fractions(0.1, 0.1, 0.1), { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [1, 2] });
});

it('scanDepartures does not expose tied indices and still ranks as typical', async () => {
  vi.mocked(runAnalysis).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(1.02));
  const scan = await scanDepartures(base, departures);
  expect(Object.keys(scan)).not.toContain('tied_indices');
  expect(scan.best_index).toBe(2);
});

// ---- C4: hours over a limit and approaching one, over the arrival range ---------------------
type Status = 'ok' | 'approaching' | 'exceeded' | 'unknown';
type Limit = 'sustained' | 'gust' | 'wave' | 'steepness' | 'visibility';
type HourSpec = [time: string, status: Partial<Record<Limit, Status | undefined>>, hs?: number | null];
const ALL: Limit[] = ['sustained', 'gust', 'wave', 'steepness', 'visibility'];
/** A leg whose nominal window is [from, to) and whose arrival-range hours carry these statuses (wind ok unless given). */
function leg(id: string, from: string, to: string, hours: HourSpec[]): Findings['legs'][number] {
  return {
    leg_id: id, enter_range: { fast: from, nominal: from, slow: from }, eta_range: { fast: to, nominal: to, slow: to },
    hours: hours.map(([time, status, hs]) => {
      const limit_status = Object.fromEntries(Object.entries({ sustained: 'ok', gust: 'ok', ...status }).filter(([, v]) => v !== undefined));
      return {
        valid_time: `2026-07-12T${time}:00Z`, wind_kt: 10, gust_kt: 14, wind_dir_deg: 0, twa_deg: 90, point_of_sail: 'reach',
        limit_status, ...(hs !== undefined ? { waves: { hs_m: hs, period_s: hs === null ? null : 6 } } : {}),
      };
    }),
  } as unknown as Findings['legs'][number];
}
const t = (hhmm: string) => `2026-07-12T${hhmm}:00Z`;
const findingsOf = (...legs: Array<Findings['legs'][number]>) => ({ legs } as unknown as Findings);
const zero = { arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0 };

it('exports the hour tie tolerance as one hour', () => {
  expect(RANK_HOUR_TIE_TOLERANCE).toBe(1);
});

it('counts each valid time of the arrival range once, even where legs overlap, and the expected timing apart', () => {
  // L1 runs 06:00-08:00 nominally, L2 08:00-10:00; each leg's arrival range reaches into the other
  const findings = findingsOf(
    leg('L1', t('06:00'), t('08:00'), [['06:00', { gust: 'exceeded' }], ['07:00', { gust: 'exceeded' }], ['08:00', { gust: 'exceeded' }]]),
    leg('L2', t('08:00'), t('10:00'), [['07:00', { gust: 'exceeded' }], ['08:00', { gust: 'exceeded' }], ['09:00', {}], ['10:00', { gust: 'exceeded' }]]),
  );
  expect(passageLimitHours(findings)).toEqual({ ...zero, arrival_hours_over_limit: 4, expected_hours_over_limit: 3 });
});

it('puts each valid time in one bucket: over, then no data, then approaching', () => {
  const findings = findingsOf(
    leg('L1', t('06:00'), t('09:00'), [
      ['06:00', { sustained: 'exceeded', gust: 'exceeded', wave: 'exceeded', visibility: 'exceeded' }],
      ['07:00', { gust: 'exceeded', steepness: 'approaching', sustained: 'approaching' }],
      ['08:00', { wave: 'approaching', visibility: 'approaching' }],
      ['09:00', { sustained: 'approaching' }],
    ]),
    // the same valid time on another leg: over there makes it over, no data there makes it no data
    leg('L2', t('09:00'), t('11:00'), [['08:00', { gust: 'exceeded' }], ['09:00', { gust: 'unknown' }], ['10:00', { gust: 'approaching' }]]),
  );
  // only the wind limits are present layers here, so hours without a wave or visibility status are not missing data
  expect(passageLimitHours(findings, { limits: new Set<Limit>(['sustained', 'gust']) })).toEqual({ arrival_hours_over_limit: 3, arrival_hours_approaching: 1, arrival_hours_no_data: 1, expected_hours_over_limit: 2 });
});

it('counts every limit the audit evaluates, not only the gust', () => {
  for (const kind of ALL) {
    const findings = findingsOf(leg('L1', t('06:00'), t('08:00'), [['06:00', { [kind]: 'exceeded' }], ['07:00', { [kind]: 'approaching' }]]));
    expect(passageLimitHours(findings)).toMatchObject({ arrival_hours_over_limit: 1, arrival_hours_approaching: 1 });
  }
});

it('never counts an hour without a value for a present limit as fine, and over a limit still wins', () => {
  const limits = new Set<Limit>(ALL);
  const findings = findingsOf(leg('L1', t('06:00'), t('13:00'), [
    ['06:00', { sustained: 'unknown', gust: 'unknown' }, 1],
    ['07:00', { gust: 'unknown', sustained: 'approaching' }, 1], // approaching on one, unknown on the other: no data
    ['08:00', { sustained: 'unknown', wave: 'exceeded' }, 3], // a known exceedance: over
    ['09:00', { wave: 'unknown' }, null], // no wave value: no data
    ['10:00', { wave: undefined, steepness: undefined }, undefined], // no wave status at all: no data
    ['11:00', { visibility: 'unknown', wave: 'ok', steepness: 'ok' }, 1], // no visibility value: no data
    ['12:00', { visibility: undefined, wave: 'ok', steepness: 'ok' }, 1], // no visibility status: no data
  ]));
  expect(passageLimitHours(findings, { limits })).toEqual({ arrival_hours_over_limit: 1, arrival_hours_approaching: 0, arrival_hours_no_data: 6, expected_hours_over_limit: 1 });
});

it('(h) counts an hour whose steepness has no status as missing data, even with a known wave height', () => {
  const limits = new Set<Limit>(ALL);
  // the period went missing at 07:00: no steepness status there, though the wave height is known.
  // Without this, an hour whose steepness was over the limit would look clean.
  const findings = findingsOf(leg('L1', t('06:00'), t('08:00'), [
    ['06:00', { wave: 'ok', visibility: 'ok', steepness: 'exceeded' }, 1],
    ['07:00', { wave: 'ok', visibility: 'ok', steepness: undefined }, 1],
  ]));
  expect(passageLimitHours(findings, { limits })).toEqual({ ...zero, arrival_hours_over_limit: 1, arrival_hours_no_data: 1, expected_hours_over_limit: 1 });
});

it('does not penalise a scan where no time has a wave period: steepness is then a wholly missing layer', async () => {
  // wave heights known everywhere, steepness nowhere: the layer is left out for every time
  const noPeriod = (over: number) => analysedWith(leg('L1', t('00:00'), t('06:00'),
    hourly(6, i => ({ wave: 'ok', visibility: 'ok', steepness: undefined, ...(i < over ? { gust: 'exceeded' } : {}) }))));
  vi.mocked(runAnalysis).mockResolvedValueOnce(noPeriod(2)).mockResolvedValueOnce(noPeriod(0));
  const scan = await scanDepartures(base, departures.slice(0, 2));
  expect(scan.candidates.map(c => c.arrival_hours_no_data)).toEqual([0, 0]);
  expect(scan.best_index).toBe(1);
  // once one time has a steepness value, its absence elsewhere counts
  vi.mocked(runAnalysis).mockResolvedValueOnce(noPeriod(0)).mockResolvedValueOnce(analysedWith(leg('L1', t('00:00'), t('06:00'), hourly(6, () => ({ ...known })))));
  const mixed = await scanDepartures(base, departures.slice(0, 2));
  expect(mixed.candidates.map(c => c.arrival_hours_no_data)).toEqual([6, 0]);
  expect(mixed.best_index).toBe(1);
});

it('ignores a limit with no known value anywhere when no limit set is given', () => {
  // waves never known in these findings: by default they are not a present layer
  const findings = findingsOf(leg('L1', t('06:00'), t('08:00'), [['06:00', { wave: 'unknown' }], ['07:00', { gust: 'exceeded' }]]));
  expect(passageLimitHours(findings)).toEqual({ ...zero, arrival_hours_over_limit: 1, expected_hours_over_limit: 1 });
});

it('gives zeros for findings without readable hours', () => {
  expect(passageLimitHours(findingsOf())).toEqual(zero);
  expect(passageLimitHours(null)).toEqual(zero);
});

it('puts the hour figures on every scan candidate', async () => {
  const { candidates } = await scanDepartures(base, departures.slice(0, 1));
  // the golden check: 25 valid times in its arrival range, 19 over a limit, 6 approaching; 13 over on the expected timing
  expect(candidates[0]).toMatchObject({ arrival_hours_over_limit: 19, arrival_hours_approaching: 6, arrival_hours_no_data: 0, expected_hours_over_limit: 13 });
});

/** A scan candidate whose findings carry these legs. */
function analysedWith(...legs: Array<Findings['legs'][number]>): AnalyzeResult {
  const analyzed = result();
  analyzed.findings.legs = legs;
  return analyzed;
}
const hourly = (count: number, spec: (i: number) => HourSpec[1], hs: (i: number) => number | null | undefined = () => 1) =>
  Array.from({ length: count }, (_, i): HourSpec => [String(i).padStart(2, '0') + ':00', spec(i), hs(i)]);
const known = { wave: 'ok', steepness: 'ok', visibility: 'ok' } as const;

it('never ranks a candidate with a present layer missing ahead of known data on the hour key', async () => {
  // the default profile declares a wave limit; one time has no wave value at any hour
  const unknownWaves = analysedWith(leg('L1', t('00:00'), t('10:00'), hourly(10, i => ({ ...known, wave: 'unknown', steepness: undefined, ...(i === 0 ? { gust: 'exceeded' } : {}) }), () => null)));
  const knownOver = analysedWith(leg('L1', t('00:00'), t('10:00'), hourly(10, i => ({ ...known, ...(i < 4 ? { wave: 'exceeded' } : {}) }))));
  const knownCalm = analysedWith(leg('L1', t('00:00'), t('10:00'), hourly(10, i => ({ ...known, ...(i === 0 ? { gust: 'exceeded' } : {}) }))));
  vi.mocked(runAnalysis).mockResolvedValueOnce(unknownWaves).mockResolvedValueOnce(knownOver).mockResolvedValueOnce(knownCalm);
  const scan = await scanDepartures(base, departures);
  expect(scan.candidates.map(c => [c.arrival_hours_over_limit, c.arrival_hours_no_data])).toEqual([[1, 9], [4, 0], [1, 0]]);
  expect(scan.best_index).toBe(2);
  const ranked = rankCandidates(scan.candidates);
  expect(ranked.tied_indices).not.toContain(0);
  expect(rankCandidates(scan.candidates.slice(0, 2)).best_index).toBe(1);
});

it('ignores a layer missing from every candidate of the scan, so it never becomes passage length', async () => {
  // no candidate has a wave value: waves are left out for everyone; the gust hours decide
  const noWaves = (count: number, overFrom: number) => analysedWith(leg('L1', t('00:00'), t(String(count).padStart(2, '0') + ':00'),
    hourly(count, i => ({ visibility: 'ok', wave: 'unknown', steepness: undefined, ...(i >= overFrom ? { gust: 'exceeded' } : {}) }), () => null)));
  vi.mocked(runAnalysis).mockResolvedValueOnce(noWaves(10, 6)).mockResolvedValueOnce(noWaves(21, 20));
  const scan = await scanDepartures(base, departures.slice(0, 2));
  expect(scan.candidates.map(c => [c.arrival_hours_over_limit, c.arrival_hours_no_data])).toEqual([[4, 0], [1, 0]]);
  expect(scan.best_index).toBe(1);
});

it('counts missing visibility as no data when another time of the scan has it', async () => {
  const noVisibility = analysedWith(leg('L1', t('00:00'), t('06:00'), hourly(6, () => ({ wave: 'ok', steepness: 'ok', visibility: undefined }))));
  const visibility = analysedWith(leg('L1', t('00:00'), t('06:00'), hourly(6, i => ({ ...known, ...(i < 2 ? { gust: 'exceeded' } : {}) }))));
  vi.mocked(runAnalysis).mockResolvedValueOnce(noVisibility).mockResolvedValueOnce(visibility);
  const scan = await scanDepartures(base, departures.slice(0, 2));
  expect(scan.candidates.map(c => c.arrival_hours_no_data)).toEqual([6, 0]);
  expect(scan.best_index).toBe(1);
  // with no visibility anywhere, the layer is ignored and the calmer time is marked
  vi.mocked(runAnalysis).mockResolvedValueOnce(noVisibility).mockResolvedValueOnce(analysedWith(leg('L1', t('00:00'), t('06:00'),
    hourly(6, i => ({ wave: 'ok', steepness: 'ok', visibility: undefined, ...(i < 2 ? { gust: 'exceeded' } : {}) })))));
  const without = await scanDepartures(base, departures.slice(0, 2));
  expect(without.candidates.map(c => c.arrival_hours_no_data)).toEqual([0, 0]);
  expect(without.best_index).toBe(0);
});

it('ignores an undeclared limit for missing data', async () => {
  const profile = { ...base.profile, max_wave_height_m: undefined, max_steepness: undefined };
  const noWaves = analysedWith(leg('L1', t('00:00'), t('04:00'), hourly(4, () => ({ visibility: 'ok' }), () => undefined)));
  const waves = analysedWith(leg('L1', t('00:00'), t('04:00'), hourly(4, i => ({ visibility: 'ok', ...(i === 0 ? { gust: 'exceeded' } : {}) }))));
  vi.mocked(runAnalysis).mockResolvedValueOnce(noWaves).mockResolvedValueOnce(waves);
  const scan = await scanDepartures({ ...base, profile }, departures.slice(0, 2));
  expect(scan.candidates.map(c => c.arrival_hours_no_data)).toEqual([0, 0]);
  expect(scan.best_index).toBe(0);
});

/** Hour figures with a verdict consistent with them: a time with an hour over a limit "exceeds" unless told otherwise. */
const hours = (over: number, approaching = 0, extra: Partial<WindowCandidate> = {}) =>
  candidate({ verdict: over > 0 ? 'exceeds' : 'within', arrival_hours_over_limit: over, arrival_hours_approaching: approaching, arrival_hours_no_data: 0, expected_hours_over_limit: over, ...extra });

it('typical ranks severity, then hours over a limit, then hours approaching, then the ratio', () => {
  const list = [
    hours(5, 0, { worst_ratio: 0.1 }),
    hours(2, 9, { worst_ratio: 0.9 }),
    hours(2, 3, { worst_ratio: 0.95 }),
    hours(0, 0, { verdict: 'warning_active', worst_ratio: 0.1 }),
  ];
  expect(rankCandidates(list)).toEqual({ best_index: 2, tied_indices: [] });
  // equal hours: the ratio decides, as before
  expect(rankCandidates([hours(3, 3, { worst_ratio: 0.8 }), hours(3, 3, { worst_ratio: 0.5 })]).best_index).toBe(1);
});

it('ranks on the arrival range, not the expected timing, like the verdict', () => {
  // both exceed: A is over for 2 h in its whole arrival range; B for 12 h, none of them on its expected timing
  const a = hours(2, 0, { verdict: 'exceeds', worst_ratio: 1.05, expected_hours_over_limit: 2 });
  const b = hours(12, 0, { verdict: 'exceeds', worst_ratio: 1.6, expected_hours_over_limit: 0 });
  expect(rankCandidates([a, b])).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates([b, a])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([a, b], { mode: 'cautious' })).toEqual({ best_index: 0, tied_indices: [] });
});

it('cautious ranks severity, then the scenario share, then the hours, then the ratio', () => {
  const list = [
    hours(1, 0, { max_fraction: 0.3, worst_ratio: 0.1 }),
    hours(6, 0, { max_fraction: 0.1, worst_ratio: 0.2 }),
    hours(4, 0, { max_fraction: 0.1, worst_ratio: 0.9 }),
  ];
  expect(rankCandidates(list, { mode: 'cautious' }).best_index).toBe(2);
  expect(rankCandidates(list, { mode: 'typical' }).best_index).toBe(0);
  // on an equal scenario share, fewer hours over a limit rank first whatever the ratio
  expect(rankCandidates([hours(4, 0, { max_fraction: 0.1, worst_ratio: 0.1 }), hours(1, 0, { max_fraction: 0.1, worst_ratio: 0.9 })], { mode: 'cautious' }).best_index).toBe(1);
});

// ---- Missing data: the worst-case severity leads, then the verdict ---------------------------
const missing = (n: number, extra: Partial<WindowCandidate> = {}) => hours(extra.arrival_hours_over_limit ?? 0, 0, { arrival_hours_no_data: n, ...extra });
/** Marked in both orders, and never tied with the other. */
function expectMarkedUntied(first: Cand, second: Cand, mode: RankMode = 'typical') {
  expect(rankCandidates([first, second], { mode })).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates([second, first], { mode })).toEqual({ best_index: 1, tied_indices: [] });
}

it('ranks a time with missing hours at the exceeds level first, then on its own verdict, then on the hours', () => {
  // behind a fully known "within" time, whatever its hours approaching
  expectMarkedUntied(hours(0, 6), missing(3));
  // at the exceeds level with fully known "exceeds" times, its own "within" verdict then comes first
  expectMarkedUntied(missing(3), hours(3));
  expectMarkedUntied(missing(3), hours(2));
  // among times with missing hours and the same verdict, over plus missing hours decide, with the one-hour tie
  expect(rankCandidates([missing(3), missing(2)])).toEqual({ best_index: 1, tied_indices: [0] });
  expectMarkedUntied(missing(2), missing(4));
});

it('(a) marks a fully known "approaching" time ahead of a "within" time with 8 missing hours, untied', () => {
  for (const mode of ['typical', 'cautious'] as const) {
    expectMarkedUntied(hours(0, 3, { verdict: 'approaching' }), missing(8), mode);
  }
});

it('(b) when both have masked hours, the verdict decides before passage length', () => {
  const a = missing(6, { verdict: 'exceeds', worst_ratio: 1.6, arrival_hours_over_limit: 1 });
  const b = missing(10, { verdict: 'within', worst_ratio: 0.4 });
  for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(b, a, mode);
});

it('(c) with one shared unknown hour, "within" is marked ahead of "approaching" and "insufficient", untied', () => {
  const within = missing(1, { worst_ratio: 0.6 });
  // approaching from a reason that is not an hour (a tidal gate or squall): no approaching hour
  const approaching = missing(1, { verdict: 'approaching', worst_ratio: 0.5 });
  const insufficient = missing(1, { verdict: 'insufficient', worst_ratio: 0.58 });
  for (const mode of ['typical', 'cautious'] as const) {
    expectMarkedUntied(within, approaching, mode);
    expectMarkedUntied(within, insufficient, mode);
  }
});

it('(d) does not rank an unknown hour behind a known exceedance: the "within" time with those hours unknown is marked', () => {
  const known = hours(5, 0, { verdict: 'exceeds', worst_ratio: 1.3 });
  const unknown = missing(5, { worst_ratio: 0.4 });
  for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(unknown, known, mode);
});

it('(e) marks a "within" time with one unknown hour ahead of a fully known "exceeds" time, whatever the ratios', () => {
  for (const [withinRatio, exceedsRatio] of [[0.2, 1.1], [0.9, 1.01], [null, 3], [0.74, 1.02]] as const) {
    const exceeds = hours(1, 0, { verdict: 'exceeds', worst_ratio: exceedsRatio });
    const within = missing(1, { worst_ratio: withinRatio });
    for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(within, exceeds, mode);
  }
});

it('(f) marks a fully known "insufficient" time ahead of a "within" time with missing hours', () => {
  for (const mode of ['typical', 'cautious'] as const) {
    expectMarkedUntied(hours(0, 0, { verdict: 'insufficient', worst_ratio: 0.9 }), missing(1, { worst_ratio: 0.1 }), mode);
  }
});

it('(g) keeps an official warning at its own level, behind all of the above', () => {
  const warning = hours(0, 0, { verdict: 'warning_active', worst_ratio: 0.1 });
  const others = [
    missing(8), missing(10, { verdict: 'exceeds', arrival_hours_over_limit: 4, worst_ratio: 2 }), hours(5, 0, { verdict: 'exceeds', worst_ratio: 2 }),
    hours(0, 0, { verdict: 'insufficient' }), hours(0, 3, { verdict: 'approaching' }), missing(1, { verdict: 'insufficient' }),
  ];
  for (const other of others) for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(other, warning, mode);
  // a warning with missing hours still ranks at its own level, and behind a warning without
  expectMarkedUntied(hours(0, 0, { verdict: 'warning_active' }), missing(2, { verdict: 'warning_active' }));
});

it('ranks an "insufficient" time with known hours over a limit at the exceeds level too', () => {
  // decideVerdict reports model disagreement before an exceedance: W misses one hour, I is over for 6 known hours
  const w = missing(1, { worst_ratio: 0.3 });
  const i = hours(6, 0, { verdict: 'insufficient', worst_ratio: 1.9 });
  for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(w, i, mode);
});

it('keeps a fully known "insufficient" time with no hour over a limit ahead of any time with missing hours', () => {
  const clean = hours(0, 2, { verdict: 'insufficient', worst_ratio: 0.9 });
  for (const mode of ['typical', 'cautious'] as const) {
    expectMarkedUntied(clean, missing(1, { worst_ratio: 0.1 }), mode);
    expectMarkedUntied(clean, missing(3, { verdict: 'exceeds', arrival_hours_over_limit: 1 }), mode);
  }
});

it('keeps the committed order between an "insufficient" time with hours over a limit and a fully known "exceeds" time', () => {
  // both at the exceeds level now; the verdict decides next, as the verdict alone did at f38b319
  const insufficient = hours(3, 0, { verdict: 'insufficient', worst_ratio: 1.5 });
  const exceeds = hours(1, 0, { verdict: 'exceeds', worst_ratio: 1.1 });
  for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(insufficient, exceeds, mode);
});

it('marks an "insufficient" time without hours over a limit ahead of one with them, untied', () => {
  // 0 h against 1 h over with close ratios was a tie at f38b319; now the one with an hour over ranks at the exceeds level
  const without = hours(0, 0, { verdict: 'insufficient', worst_ratio: 1 });
  const withOver = hours(1, 0, { verdict: 'insufficient', worst_ratio: 1.02 });
  for (const mode of ['typical', 'cautious'] as const) expectMarkedUntied(without, withOver, mode);
});

it('keeps the scenario share ahead of the hours in cautious mode, after both severities', () => {
  const lowShare = missing(4, { verdict: 'exceeds', max_fraction: 0.1, arrival_hours_over_limit: 2 });
  const highShare = missing(1, { verdict: 'exceeds', max_fraction: 0.5, arrival_hours_over_limit: 0 });
  expect(rankCandidates([highShare, lowShare], { mode: 'cautious' }).best_index).toBe(1);
  expect(rankCandidates([highShare, lowShare], { mode: 'typical' }).best_index).toBe(0);
});

it('ties only at the same worst-case severity and the same verdict', () => {
  // same verdict, one with a missing hour: different worst-case severity, never tied
  expect(rankCandidates([hours(0, 0, { worst_ratio: 0.5 }), missing(1, { worst_ratio: 0.5 })])).toEqual({ best_index: 0, tied_indices: [] });
  // both missing one hour, same verdict, close ratios: tied
  expect(rankCandidates([missing(1, { worst_ratio: 0.5 }), missing(1, { worst_ratio: 0.52 })])).toEqual({ best_index: 0, tied_indices: [1] });
  // both missing, different verdicts, close everything else: not tied
  expect(rankCandidates([missing(1, { worst_ratio: 0.5 }), missing(1, { verdict: 'approaching', worst_ratio: 0.5 })])).toEqual({ best_index: 0, tied_indices: [] });
});

// ---- Generated properties ----------------------------------------------------------------------
/** Small seeded generator, so a failure names the seed that reproduces it. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
type Cand = Parameters<typeof rankCandidates>[0][number];
const iso = (minutes: number) => new Date(Date.parse('2026-07-12T00:00:00Z') + minutes * 60_000).toISOString().replace('.000Z', 'Z');
const SEVERITY_ORDER = ['within', 'approaching', 'insufficient', 'exceeds', 'warning_active'] as const;
type Verdict = typeof SEVERITY_ORDER[number];

/**
 * One scan of hand-built findings: 1 to 5 legs (some shorter than an hour), every limit,
 * overlapping arrival ranges, hours masked on one candidate or on every candidate at the
 * same valid time (a shared land-masked point), and verdicts that also come from reasons
 * that are not hours (a tidal gate, model disagreement, an official warning).
 */
function generateScan(rand: () => number, count: number, { masks = true } = {}): Cand[] {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const shared = masks && rand() < 0.5 ? { minute: Math.floor(rand() * 10) * 60, key: pick(ALL) } : null;
  const findingsList: Findings[] = [];
  const extras: Array<{ verdict: Verdict; worst_ratio: number | null; max_fraction: number | null }> = [];
  for (let c = 0; c < count; c++) {
    const legs: Array<Findings['legs'][number]> = [];
    let start = 0;
    const legCount = 1 + Math.floor(rand() * 5);
    const statuses: Array<[Status, number]> = [];
    const calm = rand() < 0.4; // no hour over a limit anywhere
    for (let k = 0; k < legCount; k++) {
      const length = rand() < 0.3 ? 20 + Math.floor(rand() * 35) : 60 + Math.floor(rand() * 180); // minutes; some under an hour
      const from = start, to = start + length;
      start = to;
      const firstHour = Math.max(0, Math.floor(from / 60) - 1), lastHour = Math.ceil(to / 60) + 1;
      const hourSpecs: HourSpec[] = [];
      for (let h = firstHour; h <= lastHour; h++) {
        const status: HourSpec[1] = {};
        const ratio: Partial<Record<Limit, number>> = {};
        for (const key of ALL) {
          const r = rand();
          const value: Status = r < (calm ? 0 : 0.1) ? 'exceeded' : r < 0.3 ? 'approaching' : 'ok';
          status[key] = value;
          ratio[key] = value === 'exceeded' ? 1 + rand() * 0.6 : value === 'approaching' ? 0.75 + rand() * 0.24 : 0;
        }
        if (masks && rand() < 0.08) status[pick(ALL)] = rand() < 0.5 ? 'unknown' : undefined;
        if (shared && h * 60 === shared.minute) status[shared.key] = 'unknown';
        // the verdict and the ratio see only what stayed known, as the audit does
        for (const key of ALL) if (status[key] && status[key] !== 'unknown') statuses.push([status[key]!, ratio[key]!]);
        hourSpecs.push([hh(h), status, 1]);
      }
      legs.push({ ...leg(`L${k}`, iso(from), iso(to), []), hours: leg(`L${k}`, iso(from), iso(to), hourSpecs).hours } as Findings['legs'][number]);
    }
    findingsList.push(findingsOf(...legs));
    // The verdict, consistent with the known hours as decideVerdict orders it: an official warning,
    // then model disagreement, then an exceedance; "approaching" can also come from a reason that
    // is not an hour. A time with an hour over a limit is never "within" or "approaching".
    const fromHours: Verdict = statuses.some(([s]) => s === 'exceeded') ? 'exceeds' : statuses.some(([s]) => s === 'approaching') ? 'approaching' : 'within';
    const r = rand();
    const verdict: Verdict = r < 0.08 ? 'warning_active' : r < 0.2 ? 'insufficient' : r < 0.3 && fromHours === 'within' ? 'approaching' : fromHours;
    const evaluated = statuses.filter(([s]) => s !== 'ok').map(([, v]) => v);
    extras.push({ verdict, worst_ratio: evaluated.length ? Math.round(Math.max(...evaluated) * 100) / 100 : null, max_fraction: rand() < 0.3 ? null : Math.round(rand() * 10) / 31 });
  }
  const limits = presentLimits(base.profile, findingsList);
  return findingsList.map((findings, i) => candidate({ ...extras[i]!, ensemble_covered: true, ...passageLimitHours(findings, { limits }) }));
}
const hh = (n: number) => String(n).padStart(2, '0') + ':00';

/** The committed C4 ranking (f38b319), for times with no missing hours: verdict, [share], hours, ratio. */
function committedC4(candidates: readonly Cand[], mode: RankMode) {
  const sev = (c: Cand) => SEVERITY_ORDER.indexOf(c.verdict as Verdict);
  const frac = (c: Cand) => c.max_fraction ?? 0;
  const cov = (c: Cand) => c.ensemble_covered === true || c.max_fraction != null;
  const ratio = (c: Cand) => c.worst_ratio ?? 0;
  const cmp = (a: Cand, b: Cand) => {
    const d = sev(a) - sev(b);
    if (d) return d;
    if (mode === 'cautious') {
      const cv = Number(cov(b)) - Number(cov(a));
      if (cv) return cv;
      if (cov(a) && frac(a) !== frac(b)) return frac(a) - frac(b);
    }
    const h = (a.arrival_hours_over_limit! - b.arrival_hours_over_limit!) || (a.arrival_hours_approaching! - b.arrival_hours_approaching!);
    if (h) return h;
    return ratio(a) === ratio(b) ? 0 : ratio(a) < ratio(b) ? -1 : 1;
  };
  const near = (x: number, y: number, tol: number) => x === y || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tol + 1e-9);
  let best = 0;
  for (let i = 1; i < candidates.length; i++) if (cmp(candidates[i]!, candidates[best]!) < 0) best = i;
  const b = candidates[best]!;
  const tied = candidates.flatMap((c, i) => {
    if (i === best || sev(c) !== sev(b)) return [];
    if (mode === 'cautious' && (cov(c) !== cov(b) || (cov(b) && !near(frac(b), frac(c), 0.05)))) return [];
    if (!near(b.arrival_hours_over_limit!, c.arrival_hours_over_limit!, 1) || !near(b.arrival_hours_approaching!, c.arrival_hours_approaching!, 1)) return [];
    return near(ratio(b), ratio(c), 0.05) ? [i] : [];
  });
  return { best_index: best, tied_indices: tied };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

it('P1: a time with missing hours is never marked ahead of a fully known time with no hour over a limit and no official warning (seeds 1-200)', () => {
  const clean = (c: Cand) => c.arrival_hours_no_data === 0 && c.arrival_hours_over_limit === 0 && c.verdict !== 'warning_active';
  let pairs = 0;
  for (const seed of SEEDS) {
    const rand = prng(seed);
    for (const mode of ['typical', 'cautious'] as const) {
      const scan = generateScan(rand, 2 + Math.floor(rand() * 5));
      for (const x of scan) for (const y of scan) {
        if (x === y || !(x.arrival_hours_no_data! > 0) || !clean(y)) continue;
        expect(rankCandidates([x, y], { mode }), `seed ${seed} ${mode}`).toEqual({ best_index: 1, tied_indices: [] });
        expect(rankCandidates([y, x], { mode }), `seed ${seed} ${mode}`).toEqual({ best_index: 0, tied_indices: [] });
        pairs += 1;
      }
      // and within the whole scan: the marked time is fully known whenever such a clean time exists
      const { best_index } = rankCandidates(scan, { mode });
      if (scan.some(clean)) expect(scan[best_index!]!.arrival_hours_no_data, `seed ${seed} ${mode}`).toBe(0);
    }
  }
  expect(pairs).toBeGreaterThan(100);
});

it('P2: with no missing hours anywhere, the ranking equals f38b319 except where an insufficient time has hours over a limit (seeds 1-200)', () => {
  let exceptions = 0;
  for (const seed of SEEDS) {
    const rand = prng(seed);
    const scan = generateScan(rand, 2 + Math.floor(rand() * 6), { masks: false });
    expect(scan.every(c => c.arrival_hours_no_data === 0)).toBe(true);
    for (const mode of ['typical', 'cautious'] as const) {
      const now = rankCandidates(scan, { mode }), before = committedC4(scan, mode);
      const insufficientOver = (c: Cand) => c.verdict === 'insufficient' && c.arrival_hours_over_limit! > 0;
      // Cautious only: f38b319 ranked the scenario share before the hours, so an "insufficient" time with
      // hours over a limit could be marked ahead of an "insufficient" one without; now the latter is.
      if (mode === 'cautious' && insufficientOver(scan[before.best_index!]!) && scan.some(c => c.verdict === 'insufficient' && !insufficientOver(c))) {
        expect(scan[now.best_index!]!, `seed ${seed} ${mode}`).toMatchObject({ verdict: 'insufficient', arrival_hours_over_limit: 0 });
        exceptions += 1;
        continue;
      }
      expect(now.best_index, `seed ${seed} ${mode}`).toBe(before.best_index);
      // The one allowed difference: an "insufficient" time with hours over a limit now ranks at the
      // exceeds level first, so it is no longer tied with an "insufficient" time without any.
      const overSplit = (i: number) => scan[i]!.verdict === 'insufficient' && scan[before.best_index!]!.verdict === 'insufficient'
        && (scan[i]!.arrival_hours_over_limit! > 0) !== (scan[before.best_index!]!.arrival_hours_over_limit! > 0);
      expect(now.tied_indices, `seed ${seed} ${mode}`).toEqual(before.tied_indices.filter(i => !overSplit(i)));
    }
  }
  expect(exceptions).toBeLessThan(SEEDS.length); // the exception stays rare; every other case matches f38b319
});

it('P3: the marked time does not depend on input order beyond exact equality (seeds 1-200)', () => {
  for (const seed of SEEDS) {
    const rand = prng(seed);
    const scan = generateScan(rand, 2 + Math.floor(rand() * 6));
    for (const mode of ['typical', 'cautious'] as const) {
      const marked = scan[rankCandidates(scan, { mode }).best_index!]!;
      for (let shuffle = 0; shuffle < 4; shuffle++) {
        const order = scan.map((_c, i) => [rand(), i] as const).sort((p, q) => p[0] - q[0]).map(([, i]) => scan[i]!);
        const other = order[rankCandidates(order, { mode }).best_index!]!;
        // the same time, or one exactly equal on every ranked key (each is marked first in either order)
        if (other !== marked) {
          expect(rankCandidates([marked, other], { mode }).best_index, `seed ${seed} ${mode}`).toBe(0);
          expect(rankCandidates([other, marked], { mode }).best_index, `seed ${seed} ${mode}`).toBe(0);
        }
      }
    }
  }
});

it('ties hours within one hour of the best, inclusive, and not beyond it', () => {
  expect(rankCandidates([hours(2), hours(3)])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(2), hours(4)])).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates([hours(0, 4), hours(0, 5), hours(0, 6)])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(2), hours(3)], { hourTolerance: 0 })).toEqual({ best_index: 0, tied_indices: [] });
  expect(rankCandidates([hours(2), hours(4)], { hourTolerance: 2 })).toEqual({ best_index: 0, tied_indices: [1] });
  // the ratio tolerance stays separate
  expect(rankCandidates([hours(2), hours(3)], { tolerance: 0.3 }).tied_indices).toEqual([1]);
});

it('never moves the mark with the hour tolerance: one hour fewer over a limit is still marked', () => {
  expect(rankCandidates([hours(3, 0, { worst_ratio: 0.5 }), hours(2, 0, { worst_ratio: 0.9 })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([hours(3), hours(2)], { hourTolerance: 10 }).best_index).toBe(1);
});

it('measures ties against the best only, so a chain of one-hour steps does not tie the far end', () => {
  // 1 h ~ 2 h and 2 h ~ 3 h, but 3 h is two hours worse than the marked time
  expect(rankCandidates([hours(1), hours(2), hours(3)])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(3), hours(2), hours(1)])).toEqual({ best_index: 2, tied_indices: [1] });
  // the same with hours approaching, at "within"
  expect(rankCandidates([hours(0, 0), hours(0, 1), hours(0, 2)])).toEqual({ best_index: 0, tied_indices: [1] });
  // a later key cannot pull in a time that is worse by more than the tolerance on an earlier key
  expect(rankCandidates([hours(1, 9), hours(3, 0)])).toEqual({ best_index: 0, tied_indices: [] });
  // every key must be close: one hour more over a limit and three more approaching is not tied
  expect(rankCandidates([hours(1, 0), hours(2, 3)])).toEqual({ best_index: 0, tied_indices: [] });
});

it('keeps the first candidate on equal hours, and the hours never tie different severities', () => {
  expect(rankCandidates([hours(2, 1), hours(2, 1), hours(2, 1)])).toEqual({ best_index: 0, tied_indices: [1, 2] });
  expect(rankCandidates([hours(0, 0, { verdict: 'approaching' }), hours(0, 9)])).toEqual({ best_index: 1, tied_indices: [] });
});

it('keeps Infinity and null ratio handling with the hours in front', () => {
  expect(rankCandidates([hours(1, 0, { worst_ratio: Infinity }), hours(1, 0, { worst_ratio: Infinity })])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: Infinity }), hours(1, 0, { worst_ratio: 3 })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: 3 }), hours(0, 0, { worst_ratio: Infinity })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: null }), hours(1, 0, { worst_ratio: 0.5 })]).best_index).toBe(0);
});

it('ranks a candidate without the hour figures after one with them, and two without as equal', () => {
  const bare = candidate({ worst_ratio: 0.1 });
  expect(rankCandidates([bare, hours(0, 9, { worst_ratio: 0.9 })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([candidate({ worst_ratio: 0.5 }), candidate({ worst_ratio: 0.52 })])).toEqual({ best_index: 0, tied_indices: [1] });
});

it('scanDepartures ranks on the hours before the ratio', async () => {
  // the first time has the lower ratio but more hours over a limit
  const calmer = result(1);
  for (const l of calmer.findings.legs) for (const h of l.hours) h.limit_status = { ...h.limit_status, sustained: 'ok', gust: 'ok', wave: 'ok', steepness: 'ok', visibility: 'ok' };
  vi.mocked(runAnalysis).mockResolvedValueOnce(result(10)).mockResolvedValueOnce(calmer);
  const scan = await scanDepartures(base, departures.slice(0, 2));
  expect(scan.candidates.map(c => [c.worst_ratio, c.arrival_hours_over_limit])).toEqual([[0.2, 19], [2, 0]]);
  expect(scan.best_index).toBe(1);
});
