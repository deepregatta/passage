/**
 * Best-window scan: run the same audit across candidate departures and rank them.
 * The app still never says "GO" — it says which window stays furthest inside your
 * declared limits and why (driver evidence per candidate).
 */

import { runAnalysis, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { evidenceLimitRatio } from './findings.js';
import { forecastRunGone } from './forecast/store.js';
import { resolveCurrentInput } from './currentInput.js';
import { withoutSavedIdentity } from './identity.js';
import { computeRouteSchedules } from './eta.js';
import { nominalPassageHours } from './routeSummary.js';
import type { Findings, LegHour, Route, VerdictState } from './types.js';

export interface WindowCandidate {
  departure_utc: string;
  verdict: VerdictState;
  /** Worst deterministic limit ratio (limit/value for minimum visibility). Zero visibility gives Infinity. */
  worst_ratio: number | null;
  /** worst ensemble exceedance fraction across the passage; null when no scenario exceeds a limit or there is no ensemble */
  max_fraction: number | null;
  /**
   * True when any audited hour has an ensemble count for the gust or sustained limit.
   * `hour.exceedance` alone does not count: it is set even when both counts are null.
   * Separates "no ensemble" from "no scenario exceeds", which `max_fraction` cannot.
   */
  ensemble_covered: boolean;
  /** The counts behind the worst ensemble fraction ("6 of 31"); `exceed: 0` when covered and none exceeds; null when not covered. */
  max_members: { exceed: number; total: number } | null;
  driver_summary: string | null;
  /** nominal passage duration for this candidate's route */
  passage_h: number | null;
  /**
   * Distinct valid times anywhere in the arrival range (fastest entry to slowest
   * exit, every leg), where the verdict also looks, in which any declared limit is
   * exceeded on any leg. Each valid time counts once, whatever the number of legs
   * or limits over at it. Ranked (see passageLimitHours).
   */
  arrival_hours_over_limit: number;
  /** Valid times of the arrival range over no limit, with every needed value, and approaching one. Ranked. */
  arrival_hours_approaching: number;
  /** Valid times of the arrival range over no limit but missing a value one of the skipper's limits needs. Ranked as possibly over. */
  arrival_hours_no_data: number;
  /**
   * Whole hours of the expected (nominal) timing over any limit, each hour once by
   * the route summary's assignment. Shown, never ranked: at most the arrival figure.
   */
  expected_hours_over_limit: number;
  avoids_event_key?: string;
  delta?: { peak_gust_kt: number; hours_over_limit: number };
}

export interface ScanOptions extends Omit<AnalyzeOptions, 'departureUtc'> {
  /**
   * Weather-dependent routing: when set, each candidate departure is audited
   * against its own route (e.g. re-run the router per departure). A throw
   * skips that candidate, like any other failed candidate.
   */
  routeFor?: (departureUtc: string) => Route | Promise<Route>;
}

export interface WindowScan {
  /** Shared source provenance, retained by the planner along with the comparison. */
  input_records?: AnalyzeResult['findings']['inputs']['forecast_tiles'];
  candidates: WindowCandidate[];
  /** Candidates that failed routing or analysis, with the actual failure reason. */
  skipped: Array<{ departure_utc: string; reason: string }>;
  /** index into candidates of the least-bad window (never a GO) */
  best_index: number | null;
}

const SEVERITY: Record<VerdictState, number> = {
  within: 0,
  approaching: 1,
  insufficient: 2,
  exceeds: 3,
  warning_active: 4,
};

export type RankMode = 'typical' | 'cautious';

/**
 * Two times closer than this are effectively tied: 5 % of the limit for the
 * deterministic ratio, and one forecast scenario of 31 for the ensemble fraction
 * (one member is 0.03 once rounded, two are 0.06).
 */
export const RANK_TIE_TOLERANCE = 0.05;
/**
 * Two times whose hours over a limit (or approaching one) differ by one hour or
 * less are effectively tied on that figure: the expected timing is itself only
 * known to about an hour.
 */
export const RANK_HOUR_TIE_TOLERANCE = 1;
// Candidate values are rounded to two decimals, so a gap of exactly the tolerance
// can come out a hair above it in floating point (1.05 - 1 > 0.05).
const TIE_EPSILON = 1e-9;

type Rankable = Pick<WindowCandidate, 'verdict' | 'worst_ratio' | 'max_fraction'> & {
  ensemble_covered?: boolean;
  arrival_hours_over_limit?: number | null;
  arrival_hours_approaching?: number | null;
  arrival_hours_no_data?: number | null;
};

/** Absolute gap that never subtracts two infinities: equal infinities are 0 apart, one infinite value is infinitely far. */
function distance(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b);
}

const ratioOf = (c: Rankable): number => c.worst_ratio ?? 0;
// Ensemble evidence exists for this candidate. A candidate saved without the flag counts as covered when it has a fraction.
const coveredOf = (c: Rankable): boolean => c.ensemble_covered === true || c.max_fraction != null;
const fractionOf = (c: Rankable): number => c.max_fraction ?? 0;

const finiteCount = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
// The hour figures exist for this candidate. A candidate built without them (an older scan) ranks after one with them.
const hoursKnown = (c: Rankable): boolean => finiteCount(c.arrival_hours_over_limit) && finiteCount(c.arrival_hours_approaching);
// An hour missing a needed value may have been over a limit: for ranking it counts as one.
const possiblyOverOf = (c: Rankable): number => c.arrival_hours_over_limit! + (finiteCount(c.arrival_hours_no_data) ? c.arrival_hours_no_data : 0);
const approachingOf = (c: Rankable): number => c.arrival_hours_approaching!;
const noDataOf = (c: Rankable): number => (finiteCount(c.arrival_hours_no_data) ? c.arrival_hours_no_data : 0);

const overOf = (c: Rankable): number => (finiteCount(c.arrival_hours_over_limit) ? c.arrival_hours_over_limit : 0);

/**
 * The worst-case severity a candidate ranks at first: its verdict's, raised to
 * "exceeds" when any hour of its arrival range misses a value one of the skipper's
 * limits needs (that hour may have been over a limit) or is known to be over one.
 * The second case matters because decideVerdict reports model disagreement before
 * an exceedance, so an "insufficient" verdict can hide known hours over a limit.
 * An official warning, above "exceeds", keeps its own level. The verdict itself,
 * and the cell's colour, still ignore missing values.
 */
function worstCaseSeverity(c: Rankable): number {
  const own = SEVERITY[c.verdict];
  return noDataOf(c) > 0 || overOf(c) > 0 ? Math.max(own, SEVERITY.exceeds) : own;
}

/** Negative when `a` ranks ahead of `b` on the hour figures; missing figures rank last. */
function compareHours(a: Rankable, b: Rankable): number {
  const known = Number(hoursKnown(b)) - Number(hoursKnown(a));
  if (known !== 0 || !hoursKnown(a)) return known;
  return (possiblyOverOf(a) - possiblyOverOf(b)) || (approachingOf(a) - approachingOf(b));
}

/** Negative when `a` ranks ahead of `b`; zero when every key of the mode is equal. */
function compareCandidates(a: Rankable, b: Rankable, mode: RankMode): number {
  const worstCase = worstCaseSeverity(a) - worstCaseSeverity(b);
  if (worstCase !== 0) return worstCase;
  const severity = SEVERITY[a.verdict] - SEVERITY[b.verdict];
  if (severity !== 0) return severity;
  if (mode === 'cautious') {
    // No ensemble is "unknown", not "no scenario exceeds": it never beats a covered time.
    const covered = Number(coveredOf(b)) - Number(coveredOf(a));
    if (covered !== 0) return covered;
    if (coveredOf(a)) {
      const byFraction = fractionOf(a) - fractionOf(b);
      if (byFraction !== 0) return byFraction;
    }
  }
  const byHours = compareHours(a, b);
  if (byHours !== 0) return byHours;
  const ratioA = ratioOf(a), ratioB = ratioOf(b);
  if (ratioA === ratioB) return 0;
  return ratioA < ratioB ? -1 : 1;
}

/** True when every key the mode ranks on is within its tolerance of the best candidate's. */
function tiedWith(best: Rankable, c: Rankable, mode: RankMode, limit: number, hourLimit: number): boolean {
  if (worstCaseSeverity(c) !== worstCaseSeverity(best)) return false;
  if (SEVERITY[c.verdict] !== SEVERITY[best.verdict]) return false;
  if (mode === 'cautious') {
    if (coveredOf(c) !== coveredOf(best)) return false;
    if (coveredOf(best) && distance(fractionOf(best), fractionOf(c)) > limit) return false;
  }
  if (hoursKnown(c) !== hoursKnown(best)) return false;
  if (hoursKnown(best)) {
    if (distance(possiblyOverOf(best), possiblyOverOf(c)) > hourLimit) return false;
    if (distance(approachingOf(best), approachingOf(c)) > hourLimit) return false;
  }
  return distance(ratioOf(best), ratioOf(c)) <= limit;
}

/**
 * Rank candidates without ever saying GO. The best candidate is exact: the lowest
 * under the mode's order, the first one when equal. The tolerances only label the
 * others that are effectively tied with it (the same worst-case severity and the
 * same verdict, and every later value the mode ranks on within its tolerance of the
 * best's), so they never move the mark. Ties are measured against the best only: a
 * time one hour worse than a tied time but two hours worse than the best is not tied.
 *
 * - typical: worst-case severity, verdict severity, then hours over a limit plus
 *   hours missing data, then hours approaching one, then the worst deterministic ratio.
 * - cautious: worst-case severity, verdict severity, then the worst ensemble fraction
 *   (a covered candidate with no exceeding scenario counts as 0; a candidate with no
 *   ensemble ranks after covered ones), then the same two hour keys, then the ratio.
 *
 * The worst-case severity is the verdict's, raised to "exceeds" when any hour of
 * the arrival range misses a value one of the skipper's limits needs or is over a
 * limit (an "insufficient" verdict can hide known hours over a limit, since model
 * disagreement is reported first). So a time with missing hours ranks behind every
 * fully known time that is not over a limit and has no official warning, and an
 * official warning keeps its own, higher level. What it deliberately does not do:
 * among times that exceed a limit or have missing values, the verdict decides next,
 * so a "within" time with unknown hours is marked ahead of a time with a known
 * exceedance; the verdict and the cell's colour still ignore missing hours; and in
 * cautious mode the scenario share stays ahead of the hours.
 * The hours are distinct valid times of the whole arrival range, where the verdict
 * looks (passageLimitHours).
 * A candidate without the hour figures ranks after those with them.
 * `tied_indices` excludes the best one.
 */
export function rankCandidates(
  candidates: readonly Rankable[],
  { mode = 'typical', tolerance = RANK_TIE_TOLERANCE, hourTolerance = RANK_HOUR_TIE_TOLERANCE }:
  { mode?: RankMode; tolerance?: number; hourTolerance?: number } = {},
): { best_index: number | null; tied_indices: number[] } {
  if (candidates.length === 0) return { best_index: null, tied_indices: [] };
  let bestIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (compareCandidates(candidates[i]!, candidates[bestIndex]!, mode) < 0) bestIndex = i;
  }
  const best = candidates[bestIndex]!;
  const limit = tolerance + TIE_EPSILON;
  const hourLimit = hourTolerance + TIE_EPSILON;
  const tied: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i !== bestIndex && tiedWith(best, candidates[i]!, mode, limit, hourLimit)) tied.push(i);
  }
  return { best_index: bestIndex, tied_indices: tied };
}

export async function scanDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate?: (candidate: WindowCandidate) => void,
): Promise<WindowScan> {
  return scanCandidates(base, departures, onCandidate, { savedIdentity: false });
}

/**
 * Internal (not exported by the package): the scan, with `savedIdentity` saying
 * whether each candidate's audit also builds its saved identity. A scan only
 * ranks its candidates' findings, never shows or saves them, and a candidate the
 * skipper picks is checked afresh, so `scanDepartures` skips it. Tests run both
 * to show the scan's result does not depend on it.
 */
export async function scanCandidates(
  base: ScanOptions,
  departures: string[],
  onCandidate: ((candidate: WindowCandidate) => void) | undefined,
  { savedIdentity }: { savedIdentity: boolean },
): Promise<WindowScan> {
  // one shared ForecastStore: every candidate reads the same immutable tile
  // run, so the store's tile cache serves all candidates after the first
  const { routeFor, ...analyzeBase } = base;
  const candidates: WindowCandidate[] = [];
  const skipped: WindowScan['skipped'] = [];
  const eventKeys: string[][] = [];
  const candidateFindings: Findings[] = [];
  let inputRecords: WindowScan['input_records'];
  const planned: Array<{ route: Route; departureUtc: string }> = [];
  // Route once before selecting current coverage across the entire scan.
  for (const departureUtc of departures) {
    try {
      const route = routeFor ? await routeFor(departureUtc) : analyzeBase.route;
      computeRouteSchedules(route, departureUtc); // invalid candidates cannot poison shared source admission
      planned.push({ route, departureUtc });
    } catch (error) {
      if (forecastRunGone(error) || (error as { code?: string })?.code === 'forecast-updated') throw error;
      skipped.push({ departure_utc: departureUtc, reason: error instanceof Error ? error.message : String(error || 'Unknown error') });
    }
  }
  if (!planned.length) return { candidates, best_index: null, skipped };
  if (!base.currentInput) await base.store.init();
  const currentInput = base.currentInput ?? await resolveCurrentInput(planned, base.store, base.currentGrid, base.currentGridProvenance);

  for (const { route, departureUtc } of planned) {
    let result: AnalyzeResult;
    try {
      const options = { ...analyzeBase, route, departureUtc, currentInput };
      result = await runAnalysis(savedIdentity ? options : withoutSavedIdentity(options));
    } catch (error) {
      // a deleted forecast run fails every candidate: the caller refreshes and retries
      if (forecastRunGone(error) || (error as { code?: string })?.code === 'forecast-updated') throw error;
      const reason = error instanceof Error ? error.message : error == null ? '' : String(error);
      skipped.push({ departure_utc: departureUtc, reason: reason || 'Unknown error' });
      continue;
    }
    const findings = result.findings;
    inputRecords ??= findings.inputs.forecast_tiles;
    let worstRatio: number | null = null;
    let maxFraction: number | null = null;
    let maxMembers: { exceed: number; total: number } | null = null;
    for (const e of findings.evidence) {
      const ratio = evidenceLimitRatio(e);
      if (ratio !== null && !e.member_fraction) {
        worstRatio = Math.max(worstRatio ?? 0, ratio);
      }
      if (e.member_fraction) {
        const fraction = e.member_fraction.exceed / e.member_fraction.total;
        maxFraction = Math.max(maxFraction ?? 0, fraction);
        if (!maxMembers || fraction > maxMembers.exceed / maxMembers.total) maxMembers = { ...e.member_fraction };
      }
    }
    const coverage = ensembleCoverage(findings);
    // Covered but nothing exceeds: no evidence carries a count, so report none of the largest ensemble.
    if (coverage.covered && !maxMembers) maxMembers = { exceed: 0, total: coverage.total };
    const driver = findings.evidence.find(
      (e) => e.evidence_id === findings.verdict.driver_evidence_id,
    );
    const lastLeg = findings.legs[findings.legs.length - 1];
    const candidate: WindowCandidate = {
      departure_utc: departureUtc,
      verdict: findings.verdict.state,
      worst_ratio: worstRatio !== null ? Math.round(worstRatio * 100) / 100 : null,
      max_fraction: maxFraction !== null ? Math.round(maxFraction * 100) / 100 : null,
      ensemble_covered: coverage.covered,
      max_members: coverage.covered ? maxMembers : null,
      driver_summary: driver
        ? `${driver.rule_id} on ${driver.leg_id} at ${driver.valid_time}`
        : null,
      passage_h: lastLeg
        ? Math.round(((Date.parse(lastLeg.eta_range.nominal) - Date.parse(departureUtc)) / 3600_000) * 10) / 10
        : null,
      // Counted after the loop, once every candidate's findings say which layers are present.
      ...NO_HOURS,
      delta: passageMetrics(findings),
    };
    candidates.push(candidate);
    candidateFindings.push(findings);
    eventKeys.push((findings.causal_events ?? []).map((event) => event.event_key).filter((key): key is string => Boolean(key)));
    // Progress only: the hour figures are still zero here and filled in once every candidate is audited.
    onCandidate?.(candidate);
  }

  const limits = presentLimits(base.profile, candidateFindings);
  candidates.forEach((candidate, i) => Object.assign(candidate, passageLimitHours(candidateFindings[i], { limits })));
  const { best_index: bestIndex } = rankCandidates(candidates, { mode: 'typical' });

  const baseline = candidates[0];
  if (baseline?.delta) {
    for (const candidate of candidates.slice(1)) {
      const candidateIndex = candidates.indexOf(candidate);
      const avoided = eventKeys[0]?.find((key) => !eventKeys[candidateIndex]?.includes(key));
      if (avoided) candidate.avoids_event_key = avoided;
      if (candidate.delta) {
        candidate.delta = {
          peak_gust_kt: Math.round((candidate.delta.peak_gust_kt - baseline.delta.peak_gust_kt) * 10) / 10,
          hours_over_limit: candidate.delta.hours_over_limit - baseline.delta.hours_over_limit,
        };
      }
    }
  }

  skipped.sort((a, b) => departures.indexOf(a.departure_utc) - departures.indexOf(b.departure_utc));
  return { candidates, best_index: bestIndex, skipped, ...(inputRecords ? { input_records: inputRecords } : {}) };
}

/** Whether any audited hour carries an ensemble count, and the largest scenario total among them. */
function ensembleCoverage(findings: AnalyzeResult['findings']): { covered: boolean; total: number } {
  let total = 0;
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      for (const count of [hour.exceedance?.gust, hour.exceedance?.sustained]) {
        if (count) total = Math.max(total, count.total);
      }
    }
  }
  return { covered: total > 0, total };
}

export type LimitKey = keyof LegHour['limit_status'];
const LIMIT_KEYS: LimitKey[] = ['sustained', 'gust', 'wave', 'steepness', 'visibility'];
type HourFigures = Pick<WindowCandidate, 'arrival_hours_over_limit' | 'arrival_hours_approaching' | 'arrival_hours_no_data' | 'expected_hours_over_limit'>;
const NO_HOURS: HourFigures = { arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0, expected_hours_over_limit: 0 };

const statuses = (hour: LegHour) => Object.values(hour.limit_status ?? {});
const overLimit = (hour: LegHour): boolean => statuses(hour).includes('exceeded');
const knownStatus = (status: string | undefined): boolean => status === 'ok' || status === 'approaching' || status === 'exceeded';

/**
 * Whether this hour lacks a value one of `limits` needs: its status is "unknown" or
 * absent. Every limit counts alike, steepness included: its status is absent when
 * the wave period is, and an hour whose steepness was over the limit must not look
 * clean once the period goes missing. A layer no time of the scan has a value for is
 * not in `limits` (presentLimits).
 */
function missingData(hour: LegHour, limits: ReadonlySet<LimitKey>): boolean {
  for (const key of limits) {
    if (!knownStatus(hour.limit_status?.[key])) return true;
  }
  return false;
}

/**
 * The limits whose missing values count as missing data across a scan: those the
 * profile declares (sustained and gust always; waves, steepness and visibility when
 * set) that have a known status in at least one hour of at least one candidate. A
 * layer missing from every candidate is left out for everyone, so it never turns
 * into passage length.
 */
export function presentLimits(profile: { max_wave_height_m?: number; max_steepness?: number; min_visibility_nm?: number | null } | null | undefined,
  findingsList: ReadonlyArray<Findings | null | undefined>): Set<LimitKey> {
  const declared = new Set<LimitKey>(['sustained', 'gust']);
  if (profile?.max_wave_height_m !== undefined) declared.add('wave');
  if (profile?.max_steepness !== undefined) declared.add('steepness');
  if (profile?.min_visibility_nm !== undefined && profile?.min_visibility_nm !== null) declared.add('visibility');
  const present = new Set<LimitKey>();
  for (const findings of findingsList) {
    for (const leg of findings?.legs ?? []) {
      for (const hour of leg.hours ?? []) {
        for (const key of declared) if (knownStatus(hour.limit_status?.[key])) present.add(key);
      }
    }
  }
  return present;
}

/**
 * Hours over a declared limit and approaching one, from the audit's own per-hour
 * `limit_status` (sustained wind by point of sail, gust, wave height, steepness,
 * visibility): "exceeded" is above the limit (below it for visibility),
 * "approaching" is at or above the profile's approaching ratio of it (within
 * 1.5 times the minimum for visibility). Nothing is re-thresholded here.
 *
 * The three ranked figures count distinct valid times across every leg's whole
 * arrival range (fastest entry to slowest exit), where the verdict looks. Each
 * valid time lands in exactly one of: over (any leg's hour at that time exceeds
 * any limit), no data (else, any leg's hour at that time misses a value one of
 * `limits` needs), approaching (else, any leg's hour approaches any limit), or
 * neither. `limits` defaults to the declared-looking limits with a known status
 * somewhere in these findings; a scan passes the set present across all its
 * candidates (presentLimits).
 *
 * `expected_hours_over_limit` is the hours over any limit on the expected (nominal)
 * timing, each whole hour once by the route summary's assignment (nominalPassageHours).
 */
export function passageLimitHours(findings: Findings | null | undefined,
  { limits }: { limits?: ReadonlySet<LimitKey> } = {}): HourFigures {
  const counted = limits ?? new Set(LIMIT_KEYS.filter((key) => (findings?.legs ?? [])
    .some((leg) => (leg.hours ?? []).some((hour) => knownStatus(hour.limit_status?.[key])))));
  const byTime = new Map<string, LegHour[]>();
  for (const leg of findings?.legs ?? []) {
    for (const hour of leg.hours ?? []) {
      const list = byTime.get(hour.valid_time);
      if (list) list.push(hour);
      else byTime.set(hour.valid_time, [hour]);
    }
  }
  let over = 0, approaching = 0, noData = 0;
  for (const hours of byTime.values()) {
    if (hours.some(overLimit)) over += 1;
    else if (hours.some((hour) => missingData(hour, counted))) noData += 1;
    else if (hours.some((hour) => statuses(hour).includes('approaching'))) approaching += 1;
  }
  const expected = nominalPassageHours(findings).filter(({ hour }) => overLimit(hour)).length;
  return { arrival_hours_over_limit: over, arrival_hours_approaching: approaching, arrival_hours_no_data: noData, expected_hours_over_limit: expected };
}

function passageMetrics(findings: AnalyzeResult['findings']) {
  const gusts = findings.legs.flatMap((leg) => leg.hours.map((hour) => hour.gust_kt)).filter((value): value is number => value !== null);
  const hoursOver = findings.legs.flatMap((leg) => leg.hours).filter((hour) => hour.limit_status.gust === 'exceeded').length;
  return { peak_gust_kt: gusts.length ? Math.max(...gusts) : 0, hours_over_limit: hoursOver };
}

/** candidate departures every stepH hours across the next spanH hours */
export function candidateDepartures(fromUtcMs: number, spanH = 48, stepH = 6): string[] {
  const HOUR = 3600_000;
  const first = Math.ceil(fromUtcMs / (stepH * HOUR)) * stepH * HOUR;
  const out: string[] = [];
  for (let t = first; t <= fromUtcMs + spanH * HOUR; t += stepH * HOUR) {
    out.push(new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  return out;
}
