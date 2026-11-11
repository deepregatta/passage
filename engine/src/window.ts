/**
 * Best-window scan: run the same audit across candidate departures and rank them.
 * The app still never says "GO" — it says which window stays furthest inside your
 * declared limits and why (driver evidence per candidate).
 */

import { runAnalysis, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { evidenceLimitRatio } from './findings.js';
import { forecastRunGone } from './forecast/store.js';
import { resolveCurrentInput } from './currentInput.js';
import { computeRouteSchedules } from './eta.js';
import type { Route, VerdictState } from './types.js';

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
// Candidate values are rounded to two decimals, so a gap of exactly the tolerance
// can come out a hair above it in floating point (1.05 - 1 > 0.05).
const TIE_EPSILON = 1e-9;

type Rankable = Pick<WindowCandidate, 'verdict' | 'worst_ratio' | 'max_fraction'> & { ensemble_covered?: boolean };

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

/** Negative when `a` ranks ahead of `b`; zero when every key of the mode is equal. */
function compareCandidates(a: Rankable, b: Rankable, mode: RankMode): number {
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
  const ratioA = ratioOf(a), ratioB = ratioOf(b);
  if (ratioA === ratioB) return 0;
  return ratioA < ratioB ? -1 : 1;
}

/** True when every key the mode ranks on is within the tolerance of the best candidate's. */
function tiedWith(best: Rankable, c: Rankable, mode: RankMode, limit: number): boolean {
  if (SEVERITY[c.verdict] !== SEVERITY[best.verdict]) return false;
  if (mode === 'cautious') {
    if (coveredOf(c) !== coveredOf(best)) return false;
    if (coveredOf(best) && distance(fractionOf(best), fractionOf(c)) > limit) return false;
  }
  return distance(ratioOf(best), ratioOf(c)) <= limit;
}

/**
 * Rank candidates without ever saying GO. The best candidate is exact: the lowest
 * under the mode's order, the first one when equal. The tolerance only labels the
 * others that are effectively tied with it (same verdict severity, and every value
 * the mode ranks on within the tolerance), so it never moves the mark.
 * - typical: verdict severity, then worst deterministic ratio.
 * - cautious: verdict severity, then worst ensemble fraction (a covered candidate with
 *   no exceeding scenario counts as 0; a candidate with no ensemble ranks after covered
 *   ones), then the ratio.
 * `tied_indices` excludes the best one.
 */
export function rankCandidates(
  candidates: readonly Rankable[],
  { mode = 'typical', tolerance = RANK_TIE_TOLERANCE }: { mode?: RankMode; tolerance?: number } = {},
): { best_index: number | null; tied_indices: number[] } {
  if (candidates.length === 0) return { best_index: null, tied_indices: [] };
  let bestIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (compareCandidates(candidates[i]!, candidates[bestIndex]!, mode) < 0) bestIndex = i;
  }
  const best = candidates[bestIndex]!;
  const limit = tolerance + TIE_EPSILON;
  const tied: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i !== bestIndex && tiedWith(best, candidates[i]!, mode, limit)) tied.push(i);
  }
  return { best_index: bestIndex, tied_indices: tied };
}

export async function scanDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate?: (candidate: WindowCandidate) => void,
): Promise<WindowScan> {
  // one shared ForecastStore: every candidate reads the same immutable tile
  // run, so the store's tile cache serves all candidates after the first
  const { routeFor, ...analyzeBase } = base;
  const candidates: WindowCandidate[] = [];
  const skipped: WindowScan['skipped'] = [];
  const eventKeys: string[][] = [];
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
      result = await runAnalysis({ ...analyzeBase, route, departureUtc, currentInput });
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
      delta: passageMetrics(findings),
    };
    candidates.push(candidate);
    eventKeys.push((findings.causal_events ?? []).map((event) => event.event_key).filter((key): key is string => Boolean(key)));
    onCandidate?.(candidate);
  }

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
