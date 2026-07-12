/**
 * Best-window scan: run the same audit across candidate departures and rank them.
 * The app still never says "GO" — it says which window stays furthest inside your
 * declared limits and why (driver evidence per candidate).
 */

import { runAnalysis, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { MemoryCacheStore } from './fetch/openMeteo.js';
import type { VerdictState } from './types.js';

export interface WindowCandidate {
  departure_utc: string;
  verdict: VerdictState;
  /** worst value/limit ratio among evidence (deterministic) */
  worst_ratio: number | null;
  /** worst ensemble exceedance fraction across the passage */
  max_fraction: number | null;
  driver_summary: string | null;
  avoids_event_key?: string;
  delta?: { peak_gust_kt: number; hours_over_limit: number };
}

export interface WindowScan {
  candidates: WindowCandidate[];
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
  base: Omit<AnalyzeOptions, 'departureUtc'>,
  departures: string[],
  onCandidate?: (candidate: WindowCandidate) => void,
): Promise<WindowScan> {
  // one shared cache: candidates inside the same date window reuse the same responses
  const cache = base.cache ?? new MemoryCacheStore();
  const candidates: WindowCandidate[] = [];
  const eventKeys: string[][] = [];

  for (const departureUtc of departures) {
    let result: AnalyzeResult;
    try {
      result = await runAnalysis({ ...base, cache, departureUtc });
    } catch {
      continue; // a failed candidate (e.g. beyond forecast horizon) is skipped, not fatal
    }
    const findings = result.findings;
    let worstRatio: number | null = null;
    let maxFraction: number | null = null;
    for (const e of findings.evidence) {
      if (typeof e.value === 'number' && typeof e.limit === 'number' && e.limit > 0 && !e.member_fraction) {
        worstRatio = Math.max(worstRatio ?? 0, e.value / e.limit);
      }
      if (e.member_fraction) {
        maxFraction = Math.max(maxFraction ?? 0, e.member_fraction.exceed / e.member_fraction.total);
      }
    }
    const driver = findings.evidence.find(
      (e) => e.evidence_id === findings.verdict.driver_evidence_id,
    );
    const candidate: WindowCandidate = {
      departure_utc: departureUtc,
      verdict: findings.verdict.state,
      worst_ratio: worstRatio !== null ? Math.round(worstRatio * 100) / 100 : null,
      max_fraction: maxFraction !== null ? Math.round(maxFraction * 100) / 100 : null,
      driver_summary: driver
        ? `${driver.rule_id} on ${driver.leg_id} at ${driver.valid_time}`
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

  return { candidates, best_index: bestIndex };
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
