/**
 * Best-window scan: run the same audit across candidate departures and rank them.
 * The app still never says "GO" — it says which window stays furthest inside your
 * declared limits and why (driver evidence per candidate).
 */

import { runAnalysis, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { evidenceLimitRatio } from './findings.js';
import { forecastRunGone } from './forecast/store.js';
import { currentGridCovers, OUTSIDE_SCAN_CURRENT, OUTSIDE_SELECTED_CURRENT, resolveComparisonCurrent, type CurrentInput } from './currentInput.js';
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
  /**
   * Present only when the comparison ran on a prepared (regional) current grid
   * that left departures out because its time axis does not reach them: the
   * latest departure that grid carries (a covered or assessed one), and how
   * many departures were not assessed because the grid does not cover them
   * (at least 1; they are in `skipped` with OUTSIDE_SCAN_CURRENT, or, for a
   * computed refinement, OUTSIDE_SELECTED_CURRENT). A departure left out can
   * be earlier than the last covered one: its own passage can outlast the grid.
   */
  current_reach?: { last_departure_utc: string; not_covered: number };
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

/**
 * What `scanDepartures` returns on request (`{ refinable: true }`), so that
 * `refineScan` can add departures later and give exactly the result one scan
 * over every departure would have given. Never a candidate's findings: per
 * candidate only the data the scan's final figures are computed from.
 * Engine-internal state, not for display or saving.
 */
export interface ScanRefinement {
  /** Every departure the scan was asked for, in its order (candidates and skipped). */
  departures: string[];
  /** One record per candidate, in candidate order. */
  records: CandidateRecord[];
  /**
   * The one current input every candidate was audited on: the caller's, or the
   * one a drawn scan resolved once for all its candidates. A refinement audits
   * its departures on this same input.
   */
  current_input: CurrentInput;
}

/** One audited candidate before the scan-wide figures: what the final step needs and nothing else. */
export interface CandidateRecord {
  /** The candidate as audited: zero hour figures, its own (absolute) passage metrics in `delta`, no `avoids_event_key`. */
  candidate: WindowCandidate;
  /** Its own peak gust and gust hours, from which the baseline-relative `delta` is computed. */
  metrics: { peak_gust_kt: number; hours_over_limit: number };
  /** The causal event keys of its audit, from which `avoids_event_key` is computed. */
  event_keys: string[];
  /** Its hour profile, from which the hour figures are computed once the scan-wide limits are known. */
  hours: HourProfile;
  /** Its audit's forecast tile records; the scan reports the first candidate's. */
  input_records: AnalyzeResult['findings']['inputs']['forecast_tiles'];
}

/**
 * The hours of one audit reduced to what `passageLimitHours` and `presentLimits`
 * read: per distinct valid time, whether any leg's hour there is over a limit
 * or approaching one, and which limits lack a known status in any leg's hour
 * there; the limits with a known status somewhere; and the expected-timing count.
 */
export interface HourProfile {
  known: LimitKey[];
  times: Array<{ over: boolean; approaching: boolean; unknown: LimitKey[] }>;
  expected_hours_over_limit: number;
}

export type RefinableScan = WindowScan & { refinement: ScanRefinement };

export async function scanDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate?: (candidate: WindowCandidate) => void,
): Promise<WindowScan>;
export async function scanDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate: ((candidate: WindowCandidate) => void) | undefined,
  options: { refinable: true },
): Promise<RefinableScan>;
/**
 * Audit every departure and rank them. With `{ refinable: true }` the result
 * also carries `refinement` (see ScanRefinement), for `refineScan`; without it
 * the result is exactly the scan's usual shape.
 */
export async function scanDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate?: (candidate: WindowCandidate) => void,
  { refinable = false }: { refinable?: boolean } = {},
): Promise<WindowScan | RefinableScan> {
  const audited = await auditDepartures(base, departures, onCandidate, { savedIdentity: false });
  const scan = withReach(finishScan(audited.records, audited.skipped, departures, base.profile), audited.currentInput, audited.records);
  return refinable ? { ...scan, refinement: { departures: [...departures], records: audited.records, current_input: audited.currentInput } } : scan;
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
  const audited = await auditDepartures(base, departures, onCandidate, { savedIdentity });
  return withReach(finishScan(audited.records, audited.skipped, departures, base.profile), audited.currentInput, audited.records);
}

/**
 * The scan with `current_reach` when its current input is a prepared grid that
 * left departures out (CurrentInput.coverage): the later of the grid's last
 * covered departure and the last assessed one (a refinement can assess a time
 * between the last covered departure and the next one asked for).
 */
function withReach(scan: WindowScan, currentInput: CurrentInput, records: readonly CandidateRecord[]): WindowScan {
  const coverage = currentInput.coverage;
  if (!coverage?.not_covered.length || currentInput.provenance?.current_source !== 'prepared') return scan;
  let last = coverage.last_covered_utc;
  for (const { candidate } of records) if (Date.parse(candidate.departure_utc) > Date.parse(last)) last = candidate.departure_utc;
  const notCovered = scan.skipped.filter(({ reason }) => reason === OUTSIDE_SCAN_CURRENT || reason === OUTSIDE_SELECTED_CURRENT).length;
  return { ...scan, current_reach: { last_departure_utc: last, not_covered: notCovered } };
}

const abortsScan = (error: unknown) => Boolean(forecastRunGone(error)) || (error as { code?: string })?.code === 'forecast-updated';

/**
 * Why a departure is skipped when the prepared current grid the comparison uses
 * does not carry it: a departure that grid's time axis does not reach, or a
 * refined departure whose route leaves it. Defined with the selection.
 */
export { OUTSIDE_SCAN_CURRENT };

/**
 * Route and audit each departure on one current input, without ranking.
 * `admitPrepared`: a refinement audits on the coarse scan's input as given, so a
 * prepared grid must still cover each of its routes (the audit would otherwise
 * read no current there); a departure it does not cover is skipped.
 */
async function auditDepartures(
  base: ScanOptions,
  departures: string[],
  onCandidate: ((candidate: WindowCandidate) => void) | undefined,
  { savedIdentity, admitPrepared = false }: { savedIdentity: boolean; admitPrepared?: boolean },
): Promise<{ records: CandidateRecord[]; skipped: WindowScan['skipped']; currentInput: CurrentInput }> {
  // one shared ForecastStore: every candidate reads the same immutable tile
  // run, so the store's tile cache serves all candidates after the first
  const { routeFor, ...analyzeBase } = base;
  const records: CandidateRecord[] = [];
  const skipped: WindowScan['skipped'] = [];
  const planned: Array<{ route: Route; departureUtc: string }> = [];
  // Route once before selecting current coverage across the entire scan.
  for (const departureUtc of departures) {
    try {
      const route = routeFor ? await routeFor(departureUtc) : analyzeBase.route;
      computeRouteSchedules(route, departureUtc); // invalid candidates cannot poison shared source admission
      planned.push({ route, departureUtc });
    } catch (error) {
      if (abortsScan(error)) throw error;
      skipped.push({ departure_utc: departureUtc, reason: error instanceof Error ? error.message : String(error || 'Unknown error') });
    }
  }
  if (!planned.length) return { records, skipped, currentInput: base.currentInput ?? {} };
  if (!base.currentInput) await base.store.init();
  // A drawn scan's prepared grid may leave later departures out (resolveComparisonCurrent): they are not assessed.
  const currentInput = base.currentInput
    ?? await resolveComparisonCurrent(planned, departures, base.store, base.currentGrid, base.currentGridProvenance);
  const preparedGrid = admitPrepared && currentInput.provenance?.current_source === 'prepared' ? currentInput.grid : undefined;
  const notCovered = new Set(currentInput.coverage?.not_covered ?? []);

  for (const { route, departureUtc } of planned) {
    if (notCovered.has(departureUtc)) {
      skipped.push({ departure_utc: departureUtc, reason: OUTSIDE_SCAN_CURRENT });
      continue;
    }
    if (preparedGrid && !currentGridCovers(preparedGrid, { route, departureUtc })) {
      skipped.push({ departure_utc: departureUtc, reason: OUTSIDE_SCAN_CURRENT });
      continue;
    }
    let result: AnalyzeResult;
    try {
      const options = { ...analyzeBase, route, departureUtc, currentInput };
      result = await runAnalysis(savedIdentity ? options : withoutSavedIdentity(options));
    } catch (error) {
      // a deleted forecast run fails every candidate: the caller refreshes and retries
      if (abortsScan(error)) throw error;
      const reason = error instanceof Error ? error.message : error == null ? '' : String(error);
      skipped.push({ departure_utc: departureUtc, reason: reason || 'Unknown error' });
      continue;
    }
    const findings = result.findings;
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
    records.push({
      candidate: { ...candidate, delta: { ...candidate.delta! } },
      metrics: { ...candidate.delta! },
      event_keys: (findings.causal_events ?? []).map((event) => event.event_key).filter((key): key is string => Boolean(key)),
      hours: hourProfile(findings),
      input_records: findings.inputs.forecast_tiles,
    });
    // Progress only: the hour figures are still zero here and filled in once every candidate is audited.
    onCandidate?.(candidate);
  }
  return { records, skipped, currentInput };
}

/**
 * The scan's result from its audited candidates: the hour figures against the
 * limits present across all of them, the typical ranking, the fields relative
 * to the first candidate (the baseline), and the skipped departures in the
 * order of `departures`. A pure function of its inputs, shared by a scan and a
 * refinement, so a refinement's merged result is the one-pass result.
 */
function finishScan(records: readonly CandidateRecord[], skipped: WindowScan['skipped'], departures: readonly string[],
  profile: ScanOptions['profile']): WindowScan {
  const limits = presentLimitsOf(profile, records.map((record) => record.hours.known));
  const candidates: WindowCandidate[] = records.map((record) => ({
    ...record.candidate,
    ...hourFigures(record.hours, limits),
    delta: { ...record.metrics },
  }));
  const { best_index: bestIndex } = rankCandidates(candidates, { mode: 'typical' });

  const baseline = records[0];
  if (baseline) {
    candidates.forEach((candidate, i) => {
      if (i === 0) return;
      const avoided = baseline.event_keys.find((key) => !records[i]!.event_keys.includes(key));
      if (avoided) candidate.avoids_event_key = avoided;
      candidate.delta = {
        peak_gust_kt: Math.round((records[i]!.metrics.peak_gust_kt - baseline.metrics.peak_gust_kt) * 10) / 10,
        hours_over_limit: records[i]!.metrics.hours_over_limit - baseline.metrics.hours_over_limit,
      };
    });
  }

  const sortedSkipped = [...skipped].sort((a, b) => departures.indexOf(a.departure_utc) - departures.indexOf(b.departure_utc));
  // The first candidate's records, or the next one's when it has none, as the scan always reported them.
  const inputRecords = records.find((record) => record.input_records != null)?.input_records;
  return { candidates, best_index: bestIndex, skipped: sortedSkipped, ...(inputRecords ? { input_records: inputRecords } : {}) };
}

export interface RefineOptions {
  /** Hours between added departures (default 2). */
  stepH?: number;
  /** How far either side of each anchor to add departures, in hours (default 6). */
  spanH?: number;
}

const HOUR_MS = 3600_000;
const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The departures a refinement adds to a scan, and the candidates it adds them
 * around (its anchors).
 *
 * - Anchors: the marked candidate and the candidates effectively tied with it in
 *   the typical ranking, and in the cautious ranking too when any candidate has
 *   forecast-scenario evidence. Both rankings, so the set does not depend on the
 *   ranking the skipper happens to be viewing.
 * - Added: every `stepH` hours within `spanH` hours either side of each anchor,
 *   on the anchor's own grid, never before the first candidate (it is the
 *   baseline every relative field is measured from) nor after the scan's last
 *   departure (the shared current grid and assessment window were sized for the
 *   scan's span), and never a time the scan already asked for, whether it became
 *   a candidate or was skipped. Earliest first, each time once.
 *
 * `rankings` names the rankings the anchors came from (Typical, and Cautious when any
 * candidate has scenario evidence), so a caller can say which marks were refined around.
 * Works on a scan's usual result: every departure it asked for is either a candidate or skipped.
 */
export function refinementDepartures(scan: Pick<WindowScan, 'candidates' | 'skipped'>,
  { stepH = 2, spanH = 6 }: RefineOptions = {}): { departures: string[]; anchors: string[]; rankings: RankMode[] } {
  const { candidates } = scan;
  const modes: RankMode[] = candidates.some(coveredOf) ? ['typical', 'cautious'] : ['typical'];
  if (!candidates.length || !(stepH > 0) || !(spanH > 0)) return { departures: [], anchors: [], rankings: modes };
  const asked = [...candidates.map((c) => c.departure_utc), ...(scan.skipped ?? []).map((s) => s.departure_utc)]
    .map((iso) => Date.parse(iso)).filter(Number.isFinite);
  const present = new Set(asked);
  const first = Math.min(...candidates.map((c) => Date.parse(c.departure_utc)));
  const last = Math.max(...asked);
  const anchorIndices = new Set<number>();
  for (const mode of modes) {
    const { best_index: best, tied_indices: tied } = rankCandidates(candidates, { mode });
    if (best !== null) anchorIndices.add(best);
    for (const i of tied) anchorIndices.add(i);
  }
  const anchorTimes = [...anchorIndices].map((i) => Date.parse(candidates[i]!.departure_utc)).filter(Number.isFinite).sort((a, b) => a - b);
  const added = new Set<number>();
  const steps = Math.floor(spanH / stepH + 1e-9);
  for (const anchor of anchorTimes) {
    for (let k = -steps; k <= steps; k++) {
      const t = anchor + k * stepH * HOUR_MS;
      if (k === 0 || t < first || t > last || present.has(t)) continue;
      added.add(t);
    }
  }
  return {
    departures: [...added].sort((a, b) => a - b).map(isoUtc),
    anchors: [...new Set(anchorTimes)].map(isoUtc),
    rankings: modes,
  };
}

export type RefinedScan = RefinableScan & {
  /** The departures this refinement asked for (candidates or skipped now), earliest first. */
  refined_departures: string[];
  /** The candidates it refined around (see refinementDepartures). */
  refined_around: string[];
};

/**
 * Route and audit extra departures around the marked and effectively tied
 * candidates of a scan (see refinementDepartures), and merge them in: the
 * result is the scan a single pass over every departure of both would give on
 * the same current input (same candidates and figures, ranking, ties, input
 * records and skipped departures). Every figure that depends on the whole scan
 * is recomputed: the limits present across all candidates and so every
 * candidate's hour figures, the ranking, and the fields relative to the first
 * candidate.
 *
 * - `base` must be the options the coarse scan ran with (same store and runs,
 *   profile, assessment window, and for a computed scan a `routeFor` on the same
 *   current grid); its current input is replaced by the coarse scan's own.
 * - On a prepared current grid, a departure whose route the grid does not cover
 *   is skipped (OUTSIDE_SCAN_CURRENT): no departure is audited on another source.
 * - Findings stay inside: only candidate data comes out.
 */
export async function refineScan(
  base: ScanOptions,
  coarse: RefinableScan,
  options: RefineOptions = {},
  onCandidate?: (candidate: WindowCandidate) => void,
): Promise<RefinedScan> {
  const { departures: added, anchors } = refinementDepartures(coarse, options);
  const { refinement } = coarse;
  const extra = added.length
    ? await auditDepartures({ ...base, currentInput: refinement.current_input }, added, onCandidate, { savedIdentity: false, admitPrepared: true })
    : { records: [], skipped: [] };
  const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);
  const departures = [...refinement.departures, ...added].sort(byTime);
  const records = [...refinement.records, ...extra.records]
    .sort((a, b) => byTime(a.candidate.departure_utc, b.candidate.departure_utc));
  const scan = withReach(finishScan(records, [...coarse.skipped, ...extra.skipped], departures, base.profile), refinement.current_input, records);
  return {
    ...scan,
    refinement: { departures, records, current_input: refinement.current_input },
    refined_departures: added,
    refined_around: anchors,
  };
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

/*
 * An hour lacks a value one of the counted limits needs when that limit's status
 * is "unknown" or absent (HourProfile.unknown). Every limit counts alike, steepness
 * included: its status is absent when the wave period is, and an hour whose
 * steepness was over the limit must not look clean once the period goes missing. A
 * layer no time of the scan has a value for is not counted (presentLimits).
 */

/**
 * The limits whose missing values count as missing data across a scan: those the
 * profile declares (sustained and gust always; waves, steepness and visibility when
 * set) that have a known status in at least one hour of at least one candidate. A
 * layer missing from every candidate is left out for everyone, so it never turns
 * into passage length.
 */
export function presentLimits(profile: LimitsProfile, findingsList: ReadonlyArray<Findings | null | undefined>): Set<LimitKey> {
  return presentLimitsOf(profile, findingsList.map((findings) => knownLimits(findings)));
}

type LimitsProfile = { max_wave_height_m?: number; max_steepness?: number; min_visibility_nm?: number | null } | null | undefined;

/** presentLimits over each audit's limits with a known status somewhere (HourProfile.known). */
function presentLimitsOf(profile: LimitsProfile, knownLists: ReadonlyArray<readonly LimitKey[]>): Set<LimitKey> {
  const declared = new Set<LimitKey>(['sustained', 'gust']);
  if (profile?.max_wave_height_m !== undefined) declared.add('wave');
  if (profile?.max_steepness !== undefined) declared.add('steepness');
  if (profile?.min_visibility_nm !== undefined && profile?.min_visibility_nm !== null) declared.add('visibility');
  const present = new Set<LimitKey>();
  for (const known of knownLists) {
    for (const key of known) if (declared.has(key)) present.add(key);
  }
  return present;
}

/** The limits with a known status in at least one hour of these findings, in LIMIT_KEYS order. */
function knownLimits(findings: Findings | null | undefined): LimitKey[] {
  return LIMIT_KEYS.filter((key) => (findings?.legs ?? [])
    .some((leg) => (leg.hours ?? []).some((hour) => knownStatus(hour.limit_status?.[key]))));
}

/** The reduction of an audit's hours that the hour figures are computed from (see HourProfile). */
export function hourProfile(findings: Findings | null | undefined): HourProfile {
  const byTime = new Map<string, LegHour[]>();
  for (const leg of findings?.legs ?? []) {
    for (const hour of leg.hours ?? []) {
      const list = byTime.get(hour.valid_time);
      if (list) list.push(hour);
      else byTime.set(hour.valid_time, [hour]);
    }
  }
  const times = [...byTime.values()].map((hours) => ({
    over: hours.some(overLimit),
    approaching: hours.some((hour) => statuses(hour).includes('approaching')),
    unknown: LIMIT_KEYS.filter((key) => hours.some((hour) => !knownStatus(hour.limit_status?.[key]))),
  }));
  return {
    known: knownLimits(findings),
    times,
    expected_hours_over_limit: nominalPassageHours(findings).filter(({ hour }) => overLimit(hour)).length,
  };
}

/** The hour figures of a profile against `limits` (see passageLimitHours). */
function hourFigures(profile: HourProfile, limits: ReadonlySet<LimitKey>): HourFigures {
  let over = 0, approaching = 0, noData = 0;
  for (const time of profile.times) {
    if (time.over) over += 1;
    else if (time.unknown.some((key) => limits.has(key))) noData += 1;
    else if (time.approaching) approaching += 1;
  }
  return { arrival_hours_over_limit: over, arrival_hours_approaching: approaching, arrival_hours_no_data: noData,
    expected_hours_over_limit: profile.expected_hours_over_limit };
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
  const profile = hourProfile(findings);
  return hourFigures(profile, limits ?? new Set(profile.known));
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
