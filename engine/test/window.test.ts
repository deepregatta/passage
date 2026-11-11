import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import { RANK_TIE_TOLERANCE, candidateDepartures, rankCandidates, scanDepartures, type ScanOptions, type WindowCandidate } from '../src/window.js';
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

function candidate(over: Partial<WindowCandidate> = {}): WindowCandidate {
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
  expect(rankCandidates([candidate({ ensemble_covered: false, max_fraction: null }), legacy as WindowCandidate], { mode: 'cautious' }).best_index).toBe(1);
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
