/**
 * Leg schedules: enter/exit times per speed scenario (slow/nominal/fast).
 * ETA uncertainty is explicit — conditions are evaluated across the whole
 * occupancy window [enter(fast), exit(slow)], never at a single instant.
 * Current correction lands at M7 (fixed-point SOG iteration).
 */

import type { Leg, SpeedsKt } from './types.js';

export interface LegSchedule {
  leg_id: string;
  /** arrival at leg start, per scenario (ISO UTC) */
  enter: { slow: string; nominal: string; fast: string };
  /** arrival at leg end, per scenario (ISO UTC) */
  exit: { slow: string; nominal: string; fast: string };
  sog_kt: SpeedsKt;
  /** hourly UTC instants covering [enter.fast, exit.slow] */
  occupancy_hours: string[];
}

export function computeSchedules(legs: Leg[], speeds: SpeedsKt, departureUtc: string): LegSchedule[] {
  const departureMs = parseUtc(departureUtc);
  const scenarios = ['slow', 'nominal', 'fast'] as const;

  const cumulative: Record<(typeof scenarios)[number], number> = {
    slow: departureMs,
    nominal: departureMs,
    fast: departureMs,
  };

  return legs.map((leg) => {
    const enter = {
      slow: toIso(cumulative.slow),
      nominal: toIso(cumulative.nominal),
      fast: toIso(cumulative.fast),
    };
    for (const s of scenarios) {
      cumulative[s] += (leg.distance_nm / speeds[s]) * 3_600_000;
    }
    const exit = {
      slow: toIso(cumulative.slow),
      nominal: toIso(cumulative.nominal),
      fast: toIso(cumulative.fast),
    };
    return {
      leg_id: leg.leg_id,
      enter,
      exit,
      sog_kt: { ...speeds },
      occupancy_hours: hourlyRange(parseUtc(enter.fast), parseUtc(exit.slow)),
    };
  });
}

/** Hourly UTC instants (floor(start) .. ceil(end)), inclusive. */
export function hourlyRange(startMs: number, endMs: number): string[] {
  const HOUR = 3_600_000;
  const first = Math.floor(startMs / HOUR) * HOUR;
  const last = Math.ceil(endMs / HOUR) * HOUR;
  const out: string[] = [];
  for (let t = first; t <= last; t += HOUR) out.push(toIso(t));
  return out;
}

export function parseUtc(iso: string): number {
  const ms = Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid UTC timestamp: ${iso}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
