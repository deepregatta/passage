/**
 * Ensemble scenario-exceedance: the fraction of forecast scenarios
 * exceeding a declared limit. Raw member counts — presented as "N of M forecast
 * scenarios", NEVER as a calibrated probability.
 */

export interface ExceedanceCount {
  exceed: number;
  total: number;
}

/** Count members whose value at timeIdx exceeds the limit. Missing values don't count toward total. */
export function countExceedance(
  members: Array<Array<number | null>>,
  timeIdx: number,
  limit: number,
): ExceedanceCount | null {
  let exceed = 0;
  let total = 0;
  for (const series of members) {
    const value = series[timeIdx];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    total += 1;
    if (value > limit) exceed += 1;
  }
  return total > 0 ? { exceed, total } : null;
}

export function fraction(count: ExceedanceCount): number {
  return count.exceed / count.total;
}

/** Phrase used identically in both registers. */
export function phraseExceedance(count: ExceedanceCount, limitLabel: string): string {
  if (count.exceed === count.total) {
    return `all ${count.total} forecast scenarios exceed ${limitLabel}`;
  }
  if (count.exceed === 0) {
    return `none of the ${count.total} forecast scenarios exceed ${limitLabel}`;
  }
  return `${count.exceed} of ${count.total} forecast scenarios exceed ${limitLabel}`;
}
