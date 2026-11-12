import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import { RANK_HOUR_TIE_TOLERANCE, RANK_TIE_TOLERANCE, candidateDepartures, passageLimitHours, rankCandidates, scanDepartures, type ScanOptions, type WindowCandidate } from '../src/window.js';
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

it('does not count a missing steepness as no data while the wave height is known', () => {
  const limits = new Set<Limit>(ALL);
  // no period, so no steepness: the wave height still answers the sea-state limits
  const known = findingsOf(leg('L1', t('06:00'), t('07:00'), [['06:00', { wave: 'ok', visibility: 'ok', steepness: undefined }, 1]]));
  expect(passageLimitHours(known, { limits })).toEqual(zero);
  // no wave height either: missing
  const missing = findingsOf(leg('L1', t('06:00'), t('07:00'), [['06:00', { wave: 'ok', visibility: 'ok', steepness: undefined }, null]]));
  expect(passageLimitHours(missing, { limits }).arrival_hours_no_data).toBe(1);
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

const hours = (over: number, approaching = 0, extra: Partial<WindowCandidate> = {}) =>
  candidate({ arrival_hours_over_limit: over, arrival_hours_approaching: approaching, arrival_hours_no_data: 0, expected_hours_over_limit: over, ...extra });

it('typical ranks severity, then hours over a limit, then hours approaching, then the ratio', () => {
  const list = [
    hours(5, 0, { worst_ratio: 0.1 }),
    hours(2, 9, { worst_ratio: 0.9 }),
    hours(2, 3, { worst_ratio: 0.95 }),
    hours(0, 0, { verdict: 'exceeds', worst_ratio: 0.1 }),
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
    hours(0, 0, { max_fraction: 0.3, worst_ratio: 0.1 }),
    hours(6, 0, { max_fraction: 0.1, worst_ratio: 0.2 }),
    hours(4, 0, { max_fraction: 0.1, worst_ratio: 0.9 }),
  ];
  expect(rankCandidates(list, { mode: 'cautious' }).best_index).toBe(2);
  expect(rankCandidates(list, { mode: 'typical' }).best_index).toBe(0);
  // on an equal scenario share, fewer hours over a limit rank first whatever the ratio
  expect(rankCandidates([hours(4, 0, { max_fraction: 0.1, worst_ratio: 0.1 }), hours(1, 0, { max_fraction: 0.1, worst_ratio: 0.9 })], { mode: 'cautious' }).best_index).toBe(1);
});

it('counts an hour with missing data as possibly over a limit for ranking', () => {
  const unknown = hours(0, 0, { arrival_hours_no_data: 3 });
  expect(rankCandidates([unknown, hours(2)]).best_index).toBe(1);
  expect(rankCandidates([unknown, hours(3)])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(3), unknown])).toEqual({ best_index: 0, tied_indices: [1] });
});

it('known limitation: missing data does not change the verdict, so a "within" time with unknown hours ranks ahead of a fully known "approaching" one', () => {
  // the severity key comes first and an unknown wind value does not raise the verdict (findings/wind.ts, verdict.ts)
  const unknown = hours(0, 0, { arrival_hours_no_data: 8 });
  const approaching = hours(0, 3, { verdict: 'approaching' });
  expect(rankCandidates([approaching, unknown])).toEqual({ best_index: 1, tied_indices: [] });
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
  // 0 h ~ 1 h and 1 h ~ 2 h, but 2 h is two hours worse than the marked time
  expect(rankCandidates([hours(0), hours(1), hours(2)])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(2), hours(1), hours(0)])).toEqual({ best_index: 2, tied_indices: [1] });
  // a later key cannot pull in a time that is worse by more than the tolerance on an earlier key
  expect(rankCandidates([hours(0, 9), hours(2, 0)])).toEqual({ best_index: 0, tied_indices: [] });
  // every key must be close: one hour more over a limit and three more approaching is not tied
  expect(rankCandidates([hours(1, 0), hours(2, 3)])).toEqual({ best_index: 0, tied_indices: [] });
});

it('keeps the first candidate on equal hours, and the hours never tie different severities', () => {
  expect(rankCandidates([hours(2, 1), hours(2, 1), hours(2, 1)])).toEqual({ best_index: 0, tied_indices: [1, 2] });
  expect(rankCandidates([hours(0, 0, { verdict: 'approaching' }), hours(9, 9)])).toEqual({ best_index: 1, tied_indices: [] });
});

it('keeps Infinity and null ratio handling with the hours in front', () => {
  expect(rankCandidates([hours(1, 0, { worst_ratio: Infinity }), hours(1, 0, { worst_ratio: Infinity })])).toEqual({ best_index: 0, tied_indices: [1] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: Infinity }), hours(1, 0, { worst_ratio: 3 })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: 3 }), hours(0, 0, { worst_ratio: Infinity })])).toEqual({ best_index: 1, tied_indices: [] });
  expect(rankCandidates([hours(1, 0, { worst_ratio: null }), hours(1, 0, { worst_ratio: 0.5 })]).best_index).toBe(0);
});

it('ranks a candidate without the hour figures after one with them, and two without as equal', () => {
  const bare = candidate({ worst_ratio: 0.1 });
  expect(rankCandidates([bare, hours(9, 9, { worst_ratio: 0.9 })])).toEqual({ best_index: 1, tied_indices: [] });
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
