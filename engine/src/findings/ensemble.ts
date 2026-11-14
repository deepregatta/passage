import type { LegHour, LimitsProfile } from '../types.js';
import type { EnsemblePointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { fraction, type ExceedanceCount } from '../exceedance.js';
import { pointTimeIndex, type HourPoints } from './points.js';
import type { PointWind } from './wind.js';

/**
 * Ensemble scenario exceedance per hour, from every sample point the hour
 * reads (`hourPoints`): for each limit, how many scenarios exceed it at some
 * point the boat can be at in that hour, out of the scenarios with a value at
 * one of them at least. The sustained limit at a point is the one its
 * deterministic wind direction gives on the leg's bearing (members carry speed
 * and gusts only). On a leg read at one point this is countExceedance there.
 */
export function evaluateEnsemble(
  inputHours: LegHour[], hourPoints: HourPoints,
  pointWinds: ReadonlyArray<ReadonlyMap<number, PointWind>>, sustainedLimits: readonly number[],
  ensembles: readonly EnsemblePointForecast[] | null, profile: LimitsProfile, scenarioFloor: number,
) {
  const timeIndex = pointTimeIndex(ensembles ?? []);
  const hours: LegHour[] = [];
  let worstEnsembleGust: { hour: LegHour; index: number; count: ExceedanceCount } | null = null;
  let worstEnsembleSustained: {
    hour: LegHour;
    index: number;
    count: ExceedanceCount;
    limit: number;
  } | null = null;
  let scenarioFractionAboveFloor = false;
  for (const [i, input] of inputHours.entries()) {
    const hour = { ...input };
    const tMs = parseUtc(hour.valid_time);
    if (ensembles) {
      // A scenario (member) counts as exceeding a limit when it exceeds it at any point the boat can
      // be at in this hour, each point judged on its own sustained limit; it counts toward the total
      // when it has a value at one of them at least.
      const read: Array<{ ensemble: EnsemblePointForecast; idx: number; limit: number }> = [];
      for (const p of hourPoints[i] ?? []) {
        const ensemble = ensembles[p];
        const eIdx = ensemble ? timeIndex(p, tMs) : undefined;
        if (!ensemble || eIdx === undefined) continue;
        read.push({ ensemble, idx: eIdx, limit: pointWinds[i]?.get(p)?.limit ?? sustainedLimits[i]! });
      }
      const gustCount = anyPointExceedance(read.map((r) => ({ members: r.ensemble.gust_kt_members, idx: r.idx, limit: profile.max_gust_kt })));
      const sustainedCount = anyPointExceedance(read.map((r) => ({ members: r.ensemble.wind_kt_members, idx: r.idx, limit: r.limit })));
      // the limit an evidence item states: one point's (all points share it on a single-point leg)
      const sustainedLimit = read.length === 1 ? read[0]!.limit : Math.min(...read.map((r) => r.limit));
      if (read.length) {
        hour.exceedance = { sustained: sustainedCount, gust: gustCount };
        if (gustCount && fraction(gustCount) >= scenarioFloor) scenarioFractionAboveFloor = true;
        if (sustainedCount && fraction(sustainedCount) >= scenarioFloor) {
          scenarioFractionAboveFloor = true;
        }
        if (gustCount && (!worstEnsembleGust || fraction(gustCount) > fraction(worstEnsembleGust.count))) {
          worstEnsembleGust = { hour, index: i, count: gustCount };
        }
        if (
          sustainedCount &&
          (!worstEnsembleSustained ||
            fraction(sustainedCount) > fraction(worstEnsembleSustained.count))
        ) {
          worstEnsembleSustained = { hour, index: i, count: sustainedCount, limit: sustainedLimit };
        }
      }
    }
    hours.push(hour);
  }
  return { hours, worstEnsembleGust, worstEnsembleSustained, scenarioFractionAboveFloor };
}

/**
 * Members exceeding at any of the reads, each read with its own limit; total is
 * the members with a finite value in at least one read. Null when no member has
 * one (countExceedance's rule, across points).
 */
function anyPointExceedance(reads: Array<{ members: Array<Array<number | null>>; idx: number; limit: number }>): ExceedanceCount | null {
  const n = Math.max(0, ...reads.map((r) => r.members.length));
  let exceed = 0;
  let total = 0;
  for (let m = 0; m < n; m++) {
    let seen = false;
    let over = false;
    for (const r of reads) {
      const value = r.members[m]?.[r.idx];
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      seen = true;
      if (value > r.limit) over = true;
    }
    if (seen) total += 1;
    if (over) exceed += 1;
  }
  return total > 0 ? { exceed, total } : null;
}
