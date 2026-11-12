/**
 * D2: the refinement pass. The central property: refining a scan gives exactly
 * the scan one pass over every departure of both would give on the same current
 * input (candidates and every figure, the mark, the ties in both rankings, the
 * input records and the skipped departures). Analysis is mocked here and keyed
 * on the departure, so the one-pass oracle sees the same audit for each time;
 * refineScanFixtures.test.ts runs the same property on the committed fixtures.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import {
  candidateDepartures, hourProfile, passageLimitHours, rankCandidates, refineScan, refinementDepartures, scanDepartures,
  type LimitKey, type RefinableScan, type ScanOptions, type WindowCandidate, type WindowScan,
} from '../src/window.js';
import type { Findings } from '../src/types.js';

vi.mock('../src/analyze.js', () => ({ runAnalysis: vi.fn() }));
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const GOLDEN_FINDINGS = read('./golden/findings-cherbourg-plymouth.json') as Findings;
const CURRENT = { grid: undefined, provenance: { current_source: 'tiles', source: 'tiles' } };
const base: ScanOptions = {
  route: read('../../config/routes/cherbourg-plymouth.json'),
  profile: read('../../config/profiles/default-limits.json'),
  store: {} as ScanOptions['store'],
  currentInput: CURRENT,
};
const H = 3600_000;
const FROM = Date.parse('2026-07-12T00:00:00Z');
const COARSE = candidateDepartures(FROM, 48, 6); // 9 departures, 6 h apart
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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

type Status = 'ok' | 'approaching' | 'exceeded' | 'unknown' | undefined;
const LIMITS: LimitKey[] = ['sustained', 'gust', 'wave', 'steepness', 'visibility'];
const VERDICTS = ['within', 'approaching', 'insufficient', 'exceeds', 'warning_active'] as const;

/**
 * The audit of one departure, built from the seed and the departure alone: one
 * or two legs with overlapping arrival ranges, statuses with values missing, a
 * verdict, ratios, ensemble counts on some times, causal events, tile records.
 * With `layerOnlyOffGrid`, visibility has no value at any 6-hourly time and a
 * value at some refined times: refining then changes which limits are present,
 * so the coarse candidates' hour figures must change.
 */
function audit(seed: number, departureUtc: string, { layerOnlyOffGrid = false, failures = new Set<string>() } = {}): AnalyzeResult {
  if (failures.has(departureUtc)) throw new Error(`no forecast for ${departureUtc}`);
  const dep = Date.parse(departureUtc);
  const rand = prng(seed * 7919 + dep / H);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const onGrid = ((dep - FROM) / H) % 6 === 0;
  const calm = rand() < 0.5;
  const legs = [0, 1].slice(0, 1 + Math.floor(rand() * 2)).map((k) => {
    const from = dep + k * 5 * H, to = from + (4 + Math.floor(rand() * 4)) * H;
    const hours = [];
    for (let t = from - H; t <= to + H; t += H) {
      const limit_status: Record<string, Status> = {};
      for (const key of LIMITS) {
        const r = rand();
        limit_status[key] = r < (calm ? 0.01 : 0.12) ? 'exceeded' : r < 0.3 ? 'approaching' : 'ok';
      }
      if (rand() < 0.1) limit_status[pick(['wave', 'steepness', 'gust'] as const)] = rand() < 0.5 ? 'unknown' : undefined;
      if (layerOnlyOffGrid) limit_status.visibility = onGrid ? undefined : rand() < 0.7 ? 'ok' : 'unknown';
      for (const key of Object.keys(limit_status)) if (limit_status[key] === undefined) delete limit_status[key];
      const covered = rand() < 0.5;
      hours.push({
        valid_time: iso(t), wind_kt: 10, gust_kt: Math.round(rand() * 300) / 10, wind_dir_deg: 0, twa_deg: 90, point_of_sail: 'reach',
        limit_status,
        ...(covered ? { exceedance: { gust: { exceed: Math.floor(rand() * 6), total: 31 }, sustained: null } } : {}),
      });
    }
    return { leg_id: `L${k}`, enter_range: { fast: iso(from), nominal: iso(from), slow: iso(from) },
      eta_range: { fast: iso(to), nominal: iso(to), slow: iso(to + H) }, hours };
  });
  const findings = structuredClone(GOLDEN_FINDINGS);
  findings.legs = legs as unknown as Findings['legs'];
  const evidence = { ...findings.evidence[0]!, evidence_id: 'e1', rule_id: 'V-GUST-01', value: Math.round(rand() * 400) / 10, limit: 25 };
  delete evidence.member_fraction;
  findings.evidence = [evidence, ...(rand() < 0.5 ? [{ ...evidence, evidence_id: 'e2', member_fraction: { exceed: Math.floor(rand() * 4), total: 31 } }] : [])];
  findings.verdict = { ...findings.verdict, state: pick(VERDICTS), driver_evidence_id: 'e1' };
  findings.causal_events = (['k1', 'k2', 'k3'] as const).filter(() => rand() < 0.5).map((event_key) => ({ event_key })) as unknown as Findings['causal_events'];
  findings.inputs = { ...findings.inputs, forecast_tiles: [{ layer: 'weather', run_id: 'w1', departure: departureUtc }] as unknown as Findings['inputs']['forecast_tiles'] };
  return { findings } as AnalyzeResult;
}

function mockAudits(seed: number, opts: Parameters<typeof audit>[2] = {}) {
  vi.mocked(runAnalysis).mockReset().mockImplementation(async (o: { departureUtc: string }) => audit(seed, o.departureUtc, opts));
}

/** What the property compares: everything a scan reports, and both rankings' ties. */
function observable(scan: WindowScan) {
  return {
    candidates: scan.candidates,
    best_index: scan.best_index,
    typical: rankCandidates(scan.candidates, { mode: 'typical' }),
    cautious: rankCandidates(scan.candidates, { mode: 'cautious' }),
    input_records: scan.input_records,
    skipped: scan.skipped,
  };
}

/** The oracle: one scan over the merged departure list, on the coarse scan's current input. */
async function onePass(coarse: RefinableScan, added: string[]) {
  const merged = [...coarse.refinement.departures, ...added].sort((a, b) => Date.parse(a) - Date.parse(b));
  return scanDepartures({ ...base, currentInput: coarse.refinement.current_input }, merged);
}

beforeEach(() => { vi.mocked(runAnalysis).mockReset(); });

describe('refineScan equals one scan over the merged departures', () => {
  const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);
  it('on generated audits with missing values, failures and a layer present only at refined times (seeds 1-120)', async () => {
    let changedByRefining = 0, refinedSeeds = 0, markMovedToRefined = 0;
    for (const seed of SEEDS) {
      const rand = prng(seed);
      const layerOnlyOffGrid = seed % 3 === 0;
      const failures = new Set<string>();
      if (rand() < 0.3) failures.add(COARSE[0]!); // the first departure skipped: the baseline is the next one
      for (const d of COARSE) if (rand() < 0.08) failures.add(d);
      for (let h = 0; h <= 48; h += 2) if (h % 6 && rand() < 0.08) failures.add(iso(FROM + h * H));
      mockAudits(seed, { layerOnlyOffGrid, failures });
      const coarse = await scanDepartures(base, COARSE, undefined, { refinable: true });
      const refined = await refineScan(base, coarse);
      const oracle = await onePass(coarse, refined.refined_departures);
      expect(observable(refined), `seed ${seed}`).toEqual(observable(oracle));
      // the default shape: refinement data only on request
      expect(Object.keys(oracle)).not.toContain('refinement');
      // no departure twice, earliest first, and none before the first candidate
      const all = [...refined.candidates.map((c) => c.departure_utc), ...refined.skipped.map((s) => s.departure_utc)];
      expect(new Set(all).size, `seed ${seed}`).toBe(all.length);
      expect(refined.candidates.map((c) => Date.parse(c.departure_utc))).toEqual(refined.candidates.map((c) => Date.parse(c.departure_utc)).sort((a, b) => a - b));
      if (coarse.candidates.length) {
        expect(refined.candidates[0]!.departure_utc, `seed ${seed}`).toBe(coarse.candidates[0]!.departure_utc);
      }
      if (refined.refined_departures.length) refinedSeeds += 1;
      const before = new Map(coarse.candidates.map((c) => [c.departure_utc, c]));
      if (refined.candidates.some((c) => before.has(c.departure_utc) && before.get(c.departure_utc)!.arrival_hours_no_data !== c.arrival_hours_no_data)) changedByRefining += 1;
      const best = refined.best_index === null ? null : refined.candidates[refined.best_index]!.departure_utc;
      if (best && refined.refined_departures.includes(best)) markMovedToRefined += 1;
    }
    // the property is not vacuous: refining added times, moved the mark, and changed coarse figures
    expect(refinedSeeds).toBeGreaterThan(100);
    expect(markMovedToRefined).toBeGreaterThan(10);
    expect(changedByRefining).toBeGreaterThan(10);
  });

  it('recomputes every baseline-relative field against the first coarse candidate', async () => {
    mockAudits(4);
    const coarse = await scanDepartures(base, COARSE, undefined, { refinable: true });
    const refined = await refineScan(base, coarse);
    expect(refined.refined_departures.length).toBeGreaterThan(0);
    const audits = new Map(refined.candidates.map((c) => [c.departure_utc, audit(4, c.departure_utc).findings]));
    const first = audits.get(refined.candidates[0]!.departure_utc)!;
    const gusts = (f: Findings) => Math.max(...f.legs.flatMap((l) => l.hours.map((h) => h.gust_kt ?? 0)));
    const gustHours = (f: Findings) => f.legs.flatMap((l) => l.hours).filter((h) => h.limit_status.gust === 'exceeded').length;
    const keys = (f: Findings) => (f.causal_events ?? []).map((e) => e.event_key);
    refined.candidates.forEach((c, i) => {
      const own = audits.get(c.departure_utc)!;
      if (i === 0) {
        expect(c.delta).toEqual({ peak_gust_kt: gusts(own), hours_over_limit: gustHours(own) });
        expect(c).not.toHaveProperty('avoids_event_key');
        return;
      }
      expect(c.delta).toEqual({ peak_gust_kt: Math.round((gusts(own) - gusts(first)) * 10) / 10, hours_over_limit: gustHours(own) - gustHours(first) });
      const avoided = keys(first).find((k) => !keys(own).includes(k!));
      if (avoided) expect(c.avoids_event_key).toBe(avoided);
      else expect(c).not.toHaveProperty('avoids_event_key');
    });
  });

  it('audits the added departures on the coarse scan\'s own current input, and never resolves another', async () => {
    mockAudits(5);
    const store = { init: vi.fn(async () => {}), getCurrentGrid: vi.fn(async () => null) } as unknown as ScanOptions['store'];
    const drawn = { ...base, store, currentInput: undefined };
    const coarse = await scanDepartures(drawn, COARSE, undefined, { refinable: true });
    expect(store.getCurrentGrid).toHaveBeenCalledTimes(1);
    const resolved = coarse.refinement.current_input;
    vi.mocked(runAnalysis).mockClear();
    const refined = await refineScan(drawn, coarse);
    expect(refined.refined_departures.length).toBeGreaterThan(0);
    expect(store.getCurrentGrid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAnalysis).mock.calls.map(([o]) => (o as { currentInput?: unknown }).currentInput === resolved)).toEqual(refined.refined_departures.map(() => true));
    expect(refined.refinement.current_input).toBe(resolved);
  });
});

describe('which departures a refinement adds', () => {
  const cand = (departure_utc: string, extra: Partial<WindowCandidate> = {}): WindowCandidate => ({
    departure_utc, verdict: 'exceeds', worst_ratio: 2, max_fraction: null, ensemble_covered: false, max_members: null, driver_summary: null,
    passage_h: 10, arrival_hours_over_limit: 10, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 10, ...extra,
  });
  const at = (h: number) => iso(FROM + h * H);
  const calm = { verdict: 'within', worst_ratio: 0.5, arrival_hours_over_limit: 0, expected_hours_over_limit: 0 } as const;

  it('adds every 2 h within 6 h of the marked time, skipping the 6-hourly times already there', () => {
    const scan = { candidates: [0, 6, 12, 18, 24].map((h) => cand(at(h), h === 12 ? calm : {})), skipped: [] };
    expect(refinementDepartures(scan)).toEqual({ departures: [8, 10, 14, 16].map(at), anchors: [at(12)], rankings: ['typical'] });
  });

  it('clamps to the first candidate and the last departure asked for, and never re-adds a skipped time', () => {
    // the first departure was skipped: the baseline is the 6 h candidate, so nothing goes before it
    const skipped = [{ departure_utc: at(0), reason: 'x' }, { departure_utc: at(24), reason: 'y' }];
    const early = { candidates: [6, 12, 18].map((h) => cand(at(h), h === 6 ? calm : {})), skipped };
    expect(refinementDepartures(early).departures).toEqual([8, 10].map(at));
    const late = { candidates: [6, 12, 18].map((h) => cand(at(h), h === 18 ? calm : {})), skipped };
    // 24 h was asked for and skipped: 20 and 22 are inside the span, 24 is not re-added
    expect(refinementDepartures(late).departures).toEqual([14, 16, 20, 22].map(at));
  });

  it('adds around tied times too, each time once, and 2k + 2 for k adjacent anchors', () => {
    const scan = { candidates: [0, 6, 12, 18, 24, 30].map((h) => cand(at(h), h === 12 || h === 18 ? calm : {})), skipped: [] };
    expect(rankCandidates(scan.candidates).tied_indices).toEqual([3]);
    expect(refinementDepartures(scan)).toEqual({ departures: [8, 10, 14, 16, 20, 22].map(at), anchors: [at(12), at(18)], rankings: ['typical'] });
  });

  it('adds around the cautious ranking\'s marked and tied times as well, so the set does not depend on the toggle', () => {
    const covered = (fraction: number) => ({ ensemble_covered: true, max_fraction: fraction });
    const scan = { candidates: [
      cand(at(0), { ...covered(0.5), ...calm }), // typical's mark, many scenarios over
      cand(at(6), covered(0.5)),
      cand(at(12), { ...covered(0), verdict: 'within', worst_ratio: 0.9, arrival_hours_over_limit: 0, expected_hours_over_limit: 0, arrival_hours_approaching: 4 }), // cautious's mark
      cand(at(18), covered(0.5)),
    ], skipped: [] };
    expect(rankCandidates(scan.candidates, { mode: 'typical' }).best_index).toBe(0);
    expect(rankCandidates(scan.candidates, { mode: 'cautious' }).best_index).toBe(2);
    expect(refinementDepartures(scan)).toEqual({ departures: [2, 4, 8, 10, 14, 16].map(at), anchors: [at(0), at(12)], rankings: ['typical', 'cautious'] });
  });

  it('adds nothing without candidates, and honours another step and span', () => {
    expect(refinementDepartures({ candidates: [], skipped: [{ departure_utc: at(0), reason: 'x' }] })).toEqual({ departures: [], anchors: [], rankings: ['typical'] });
    const scan = { candidates: [0, 6, 12].map((h) => cand(at(h), h === 6 ? calm : {})), skipped: [] };
    expect(refinementDepartures(scan, { stepH: 3, spanH: 3 }).departures).toEqual([3, 9].map(at));
  });

  it('returns the coarse result unchanged, refinement data aside, when there is nothing to add', async () => {
    mockAudits(6);
    const coarse = await scanDepartures(base, COARSE.slice(0, 1), undefined, { refinable: true });
    const refined = await refineScan(base, coarse);
    expect(refined.refined_departures).toEqual([]);
    const { refinement: _a, ...plain } = coarse;
    const { refinement: _b, refined_departures: _c, refined_around: _d, ...merged } = refined;
    expect(merged).toEqual(plain);
  });
});

describe('the hour profile behind a scan\'s figures', () => {
  /** The figures as passageLimitHours computed them before the profile existed (commit 127f5be), for comparison. */
  function reference(findings: Findings, limits: ReadonlySet<LimitKey>) {
    const known = (s: string | undefined) => s === 'ok' || s === 'approaching' || s === 'exceeded';
    const byTime = new Map<string, Findings['legs'][number]['hours']>();
    for (const leg of findings.legs) for (const hour of leg.hours) byTime.set(hour.valid_time, [...(byTime.get(hour.valid_time) ?? []), hour]);
    let over = 0, approaching = 0, noData = 0;
    for (const hours of byTime.values()) {
      if (hours.some((h) => Object.values(h.limit_status ?? {}).includes('exceeded'))) over += 1;
      else if (hours.some((h) => [...limits].some((key) => !known(h.limit_status?.[key])))) noData += 1;
      else if (hours.some((h) => Object.values(h.limit_status ?? {}).includes('approaching'))) approaching += 1;
    }
    return { over, approaching, noData };
  }
  const subsets = Array.from({ length: 32 }, (_, mask) => new Set(LIMITS.filter((_, i) => mask & (1 << i))));

  it('gives the same figures as counting the hours directly, for every set of limits (golden findings and seeds 1-40)', () => {
    const cases = [GOLDEN_FINDINGS, ...Array.from({ length: 40 }, (_, i) => audit(i + 1, COARSE[i % COARSE.length]!).findings)];
    for (const findings of cases) {
      expect(hourProfile(findings).times.length).toBe(new Set(findings.legs.flatMap((l) => l.hours.map((h) => h.valid_time))).size);
      for (const limits of subsets) {
        const { over, approaching, noData } = reference(findings, limits);
        expect(passageLimitHours(findings, { limits })).toMatchObject({
          arrival_hours_over_limit: over, arrival_hours_approaching: approaching, arrival_hours_no_data: noData,
        });
      }
    }
  });
});
