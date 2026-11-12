/**
 * How the passage divides by point of sail and by wind strength, from the
 * findings a snapshot already saves. Nothing here changes Findings, a schema,
 * a golden or an identity hash, so passages saved before this existed get it
 * too.
 *
 * Each leg's `hours` span its whole arrival range (fastest entry to slowest
 * exit), so adjacent legs overlap and summing them counts hours twice. Here
 * each whole hour belongs to exactly one leg: the one whose nominal window
 * (`enter_range.nominal` up to, not including, `eta_range.nominal`) contains
 * the hour's start. The hours are therefore the passage on its nominal
 * (expected) timing, and they add up to the nominal passage time within one hour.
 *
 * The wind is `LegHour.wind_kt`: the deterministic sustained wind the audit
 * itself compares to the sustained-wind limit. Not gusts, not an ensemble
 * statistic.
 */

import { parseUtc } from './eta.js';
import type { Findings, LegHour, PointOfSail } from './types.js';

export type WindBandId = 'under_10' | 'from_10_to_15' | 'from_15_to_20' | 'from_20_to_25' | 'from_25_up';

/**
 * The wind bands, in kt, each half-open: a wind of exactly 10 kt is in the
 * 10 to 15 band, 25 kt is in the 25 and over band. `to` is exclusive.
 */
export const WIND_BANDS: ReadonlyArray<{ id: WindBandId; from: number; to: number }> = [
  { id: 'under_10', from: 0, to: 10 },
  { id: 'from_10_to_15', from: 10, to: 15 },
  { id: 'from_15_to_20', from: 15, to: 20 },
  { id: 'from_20_to_25', from: 20, to: 25 },
  { id: 'from_25_up', from: 25, to: Number.POSITIVE_INFINITY },
];

export interface RouteSummary {
  /** whole hours of the passage on its nominal timing (one per hour start inside a leg's nominal window) */
  total_hours: number;
  /** hours by point of sail; `unknown` is hours with no wind direction. Sums to `total_hours`. */
  by_point_of_sail: Record<PointOfSail | 'unknown', number>;
  /** hours by sustained wind band; `unknown` is hours with no usable wind value. Sums to `total_hours`. */
  by_wind_band: Record<WindBandId | 'unknown', number>;
}

function utcMs(iso: string): number {
  try {
    return parseUtc(iso);
  } catch {
    return Number.NaN;
  }
}

function bandOf(wind: number | null | undefined): WindBandId | 'unknown' {
  if (wind === null || wind === undefined || !Number.isFinite(wind) || wind < 0) return 'unknown';
  return WIND_BANDS.find((band) => wind >= band.from && wind < band.to)!.id;
}

function sailOf(hour: LegHour): PointOfSail | 'unknown' {
  const pos = hour.point_of_sail;
  return pos === 'upwind' || pos === 'reach' || pos === 'downwind' ? pos : 'unknown';
}

/**
 * The passage's hours by point of sail and by wind band, one hour counted once.
 * A leg's hour counts when its start lies in [enter_range.nominal,
 * eta_range.nominal) of that leg; an hour start already taken by an earlier
 * leg is not counted again. A leg whose window cannot be read contributes
 * nothing.
 *
 * Returns null when no hour qualifies (no legs, no hours, unreadable times).
 */
export function routeSummary(findings: Findings | null | undefined): RouteSummary | null {
  if (!findings?.legs?.length) return null;
  const taken = new Set<number>();
  const by_point_of_sail: RouteSummary['by_point_of_sail'] = { upwind: 0, reach: 0, downwind: 0, unknown: 0 };
  const by_wind_band: RouteSummary['by_wind_band'] = {
    under_10: 0, from_10_to_15: 0, from_15_to_20: 0, from_20_to_25: 0, from_25_up: 0, unknown: 0,
  };
  let total = 0;
  for (const leg of findings.legs) {
    const from = utcMs(leg.enter_range?.nominal);
    const to = utcMs(leg.eta_range?.nominal);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    for (const hour of leg.hours ?? []) {
      const start = utcMs(hour.valid_time);
      if (!Number.isFinite(start) || start < from || start >= to || taken.has(start)) continue;
      taken.add(start);
      total += 1;
      by_point_of_sail[sailOf(hour)] += 1;
      by_wind_band[bandOf(hour.wind_kt)] += 1;
    }
  }
  return total > 0 ? { total_hours: total, by_point_of_sail, by_wind_band } : null;
}
