/**
 * Best-window scan: run the same audit across candidate departures and rank them.
 * The app still never says "GO" — it says which window stays furthest inside your
 * declared limits and why (driver evidence per candidate).
 */

import { runAnalysis, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { evidenceLimitRatio } from './findings.js';
import type { Route, VerdictState } from './types.js';

export interface WindowCandidate {
  departure_utc: string;
  verdict: VerdictState;
  /** Worst deterministic limit ratio (limit/value for minimum visibility). Zero visibility gives Infinity. */
  worst_ratio: number | null;
  /** worst ensemble exceedance fraction across the passage */
  max_fraction: number | null;
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

  for (const departureUtc of departures) {
    let result: AnalyzeResult;
    try {
      const route = routeFor ? await routeFor(departureUtc) : analyzeBase.route;
      result = await runAnalysis({ ...analyzeBase, route, departureUtc });
    } catch (error) {
      const reason = error instanceof Error ? error.message : error == null ? '' : String(error);
      skipped.push({ departure_utc: departureUtc, reason: reason || 'Unknown error' });
      continue;
    }
    const findings = result.findings;
    let worstRatio: number | null = null;
    let maxFraction: number | null = null;
    for (const e of findings.evidence) {
      const ratio = evidenceLimitRatio(e);
      if (ratio !== null && !e.member_fraction) {
        worstRatio = Math.max(worstRatio ?? 0, ratio);
      }
      if (e.member_fraction) {
        maxFraction = Math.max(maxFraction ?? 0, e.member_fraction.exceed / e.member_fraction.total);
      }
    }
    const driver = findings.evidence.find(
      (e) => e.evidence_id === findings.verdict.driver_evidence_id,
    );
    const lastLeg = findings.legs[findings.legs.length - 1];
    const candidate: WindowCandidate = {
      departure_utc: departureUtc,
      verdict: findings.verdict.state,
      worst_ratio: worstRatio !== null ? Math.round(worstRatio * 100) / 100 : null,
      max_fraction: maxFraction !== null ? Math.round(maxFraction * 100) / 100 : null,
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

  let bestIndex: number | null = null;
  candidates.forEach((c, i) => {
    if (bestIndex === null) {
      bestIndex = i;
      return;
    }
    const best = candidates[bestIndex]!;
    const severityDelta = SEVERITY[c.verdict] - SEVERITY[best.verdict];
    if (severityDelta < 0) bestIndex = i;
    else if (severityDelta === 0 && (c.worst_ratio ?? 0) < (best.worst_ratio ?? 0)) bestIndex = i;
  });

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

  return { candidates, best_index: bestIndex, skipped };
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
