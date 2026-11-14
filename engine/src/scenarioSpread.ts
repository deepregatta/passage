/**
 * Spread of the forecast scenarios over the passage, from data a snapshot
 * already saves: the findings (which hours each leg audited) and the plume
 * (every member's wind and gust series). Nothing here changes Findings, a
 * schema, a golden or an identity hash, so passages saved before this existed
 * get it too.
 *
 * It describes a count of scenarios, never a probability: "in half of the
 * scenarios the strongest wind stays at or under X".
 */

import { parseUtc } from './eta.js';
import { quantile } from './quantile.js';
import type { Plume } from './snapshot.js';
import type { Findings } from './types.js';

/** Fewer scenarios than this is too few to describe a spread. */
export const SCENARIO_SPREAD_MIN_MEMBERS = 10;

export interface ScenarioSpreadValues {
  /** median of the members' passage maxima, kt (unrounded) */
  median: number;
  /** 90th percentile of the members' passage maxima, kt (unrounded) */
  p90: number;
  /** members that had at least one value over the audited hours */
  members: number;
}

export interface ScenarioSpread {
  /** strongest sustained wind per scenario over the passage; null below the minimum member count */
  wind: ScenarioSpreadValues | null;
  /** strongest gust per scenario over the passage; null below the minimum member count */
  gust: ScenarioSpreadValues | null;
  /**
   * Present on checks that read a leg at several points (engine semantics
   * `passage-audit-4`): the plume, and so this spread, is the reading at the
   * boat's expected position along each leg, not the worst of the points the
   * check judged. Absent when every leg was read at one point (older checks):
   * the plume is then that point's reading.
   */
  basis?: 'expected_position';
}

function utcMs(iso: string): number {
  try {
    return parseUtc(iso);
  } catch {
    return Number.NaN;
  }
}

function summarise(maxima: Array<number | null>): ScenarioSpreadValues | null {
  const values = maxima.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (values.length < SCENARIO_SPREAD_MIN_MEMBERS) return null;
  return { median: quantile(values, 0.5)!, p90: quantile(values, 0.9)!, members: values.length };
}

/**
 * For each ensemble member, its maximum wind and maximum gust over the hours
 * each leg audited (the valid times in `findings.legs[i].hours`, matched to the
 * plume's leg by leg id and to its time axis by instant, as the scenario counts
 * do). The plume holds far more hours than the passage; they are ignored. Then
 * the median and 90th percentile of those maxima across members, for wind and
 * gust separately. Missing values are skipped as `countExceedance` skips them;
 * the control member counts.
 *
 * Returns null when the plume is missing, when no leg has an ensemble time among
 * its audited hours, or when neither variable has enough members.
 */
export function scenarioSpread(findings: Findings, plume: Plume | null | undefined): ScenarioSpread | null {
  if (!plume?.legs?.length || !findings?.legs?.length) return null;
  const windMax: Array<number | null> = [];
  const gustMax: Array<number | null> = [];
  let anyAuditedEnsembleHour = false;
  const fold = (into: Array<number | null>, members: Array<Array<number | null>> | undefined, idx: number) => {
    members?.forEach((series, m) => {
      const value = series?.[idx];
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      const current = into[m];
      if (current === null || current === undefined || value > current) into[m] = value;
    });
  };
  for (const leg of findings.legs) {
    const plumeLeg = plume.legs.find((l) => l.leg_id === leg.leg_id);
    if (!plumeLeg) continue;
    const timeIndex = new Map<number, number>();
    plumeLeg.times?.forEach((t, idx) => timeIndex.set(utcMs(t), idx));
    for (const hour of leg.hours) {
      const idx = timeIndex.get(utcMs(hour.valid_time));
      if (idx === undefined) continue;
      anyAuditedEnsembleHour = true;
      fold(windMax, plumeLeg.wind_members, idx);
      fold(gustMax, plumeLeg.gust_members, idx);
    }
  }
  if (!anyAuditedEnsembleHour) return null;
  const wind = summarise(windMax);
  const gust = summarise(gustMax);
  if (!wind && !gust) return null;
  const expected = findings.legs.some((leg) => (leg.sample_points?.length ?? 0) > 1);
  return expected ? { wind, gust, basis: 'expected_position' } : { wind, gust };
}
