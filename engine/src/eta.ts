/**
 * Leg schedules: enter/exit times per speed scenario (slow/nominal/fast).
 * ETA uncertainty is explicit — conditions are evaluated across the whole
 * occupancy window [enter(fast), exit(slow)], never at a single instant.
 * When currents are supplied, fixed-point iteration couples SOG and ETA.
 */

import { alongCourseComponentKt } from './vectors.js';
import { interpolatePosition } from './geo.js';
import { deriveLegs } from './route.js';
import type { Leg, Route, SpeedsKt } from './types.js';

export interface LegSchedule {
  leg_id: string;
  /** arrival at leg start, per scenario (ISO UTC) */
  enter: { slow: string; nominal: string; fast: string };
  /** arrival at leg end, per scenario (ISO UTC) */
  exit: { slow: string; nominal: string; fast: string };
  /** EFFECTIVE speed over ground per scenario (current-corrected when a sampler is given) */
  sog_kt: SpeedsKt;
  /** hourly UTC instants covering [enter.fast, exit.slow] */
  occupancy_hours: string[];
}

/** u/v in knots (east/north) at a position and time; null outside coverage */
export type CurrentSampler = (
  lat: number,
  lon: number,
  timeMs: number,
) => { u_kt: number; v_kt: number } | null;

const SCENARIOS = ['slow', 'nominal', 'fast'] as const;
const MIN_SOG_KT = 0.5;
/** ETA and the current you meet are coupled — a few fixed-point rounds converge fast */
const CURRENT_ITERATIONS = 3;

/** One timing boundary shared by forecast-window selection and final findings. */
export function computeRouteSchedules(
  route: Route,
  departureUtc: string,
  currentSampler?: CurrentSampler,
): LegSchedule[] {
  if (!route.speeds_kt) throw new Error(`Route ${route.route_id} needs speeds_kt`);
  const legs = deriveLegs(route);
  const timing = route.timing;
  if (timing?.basis === 'routed') {
    const departureMs = parseUtc(departureUtc);
    if (departureMs !== parseUtc(timing.departure_utc)) {
      throw new Error('Computed route timing belongs to another departure. Compute the route again.');
    }
    if (timing.legs.length !== legs.length) throw new Error('Computed route timing does not match its legs');
    const time = { slow: departureMs, nominal: departureMs, fast: departureMs };
    return legs.map((leg, i) => {
      const routed = timing.legs[i]!;
      if (routed.leg_id !== leg.leg_id ||
        !SCENARIOS.every(s => Number.isFinite(routed.duration_ms[s]) && routed.duration_ms[s] > 0) ||
        !Number.isFinite(routed.through_water_kt) || routed.through_water_kt <= 0 ||
        !Number.isFinite(routed.speed_over_ground_kt) || routed.speed_over_ground_kt <= 0 ||
        routed.duration_ms.fast > routed.duration_ms.nominal ||
        routed.duration_ms.nominal > routed.duration_ms.slow) {
        throw new Error('Invalid computed route leg timing');
      }
      const enter = { slow: toIso(time.slow), nominal: toIso(time.nominal), fast: toIso(time.fast) };
      for (const s of SCENARIOS) time[s] += routed.duration_ms[s];
      const exit = { slow: toIso(time.slow), nominal: toIso(time.nominal), fast: toIso(time.fast) };
      const sog = (s: typeof SCENARIOS[number]) => round2(
        routed.speed_over_ground_kt * routed.duration_ms.nominal / routed.duration_ms[s],
      );
      return {
        leg_id: leg.leg_id, enter, exit,
        sog_kt: { slow: sog('slow'), nominal: sog('nominal'), fast: sog('fast') },
        occupancy_hours: hourlyRange(parseUtc(enter.fast), parseUtc(exit.slow)),
      };
    });
  }
  // Pre-timing computed routes stored SOG. Drawn, imported and fixed routes
  // stored through-water speeds. Keep both saved-data interpretations explicit.
  const basis = timing?.basis ?? (route.mode === 'computed' ? 'speed_over_ground' : 'through_water');
  return computeSchedules(legs, route.speeds_kt, departureUtc,
    basis === 'through_water' ? currentSampler : undefined);
}

export function computeSchedules(
  legs: Leg[],
  speeds: SpeedsKt,
  departureUtc: string,
  currentSampler?: CurrentSampler,
): LegSchedule[] {
  const departureMs = parseUtc(departureUtc);

  // effective SOG per scenario per leg; starts as still-water speed
  const sog: Record<(typeof SCENARIOS)[number], number[]> = {
    slow: legs.map(() => speeds.slow),
    nominal: legs.map(() => speeds.nominal),
    fast: legs.map(() => speeds.fast),
  };

  const buildTimes = () => {
    const enter: Record<string, number[]> = { slow: [], nominal: [], fast: [] };
    const exit: Record<string, number[]> = { slow: [], nominal: [], fast: [] };
    for (const s of SCENARIOS) {
      let t = departureMs;
      legs.forEach((leg, i) => {
        enter[s]!.push(t);
        t += (leg.distance_nm / sog[s][i]!) * 3_600_000;
        exit[s]!.push(t);
      });
    }
    return { enter, exit };
  };

  let times = buildTimes();
  if (currentSampler) {
    for (let iteration = 0; iteration < CURRENT_ITERATIONS; iteration++) {
      for (const s of SCENARIOS) {
        legs.forEach((leg, i) => {
          const midMs = (times.enter[s]![i]! + times.exit[s]![i]!) / 2;
          const mid = interpolatePosition(leg.from, leg.to, 0.5);
          const sample = currentSampler(mid.lat, mid.lon, midMs);
          if (!sample) {
            sog[s][i] = speeds[s];
            return;
          }
          const along = alongCourseComponentKt(sample, leg.bearing_deg_true);
          sog[s][i] = Math.max(MIN_SOG_KT, speeds[s] + along);
        });
      }
      times = buildTimes();
    }
  }

  return legs.map((leg, i) => {
    const enter = {
      slow: toIso(times.enter.slow![i]!),
      nominal: toIso(times.enter.nominal![i]!),
      fast: toIso(times.enter.fast![i]!),
    };
    const exit = {
      slow: toIso(times.exit.slow![i]!),
      nominal: toIso(times.exit.nominal![i]!),
      fast: toIso(times.exit.fast![i]!),
    };
    return {
      leg_id: leg.leg_id,
      enter,
      exit,
      sog_kt: {
        slow: round2(sog.slow[i]!),
        nominal: round2(sog.nominal[i]!),
        fast: round2(sog.fast[i]!),
      },
      occupancy_hours: hourlyRange(parseUtc(enter.fast), parseUtc(exit.slow)),
    };
  });
}

const round2 = (x: number) => Math.round(x * 100) / 100;

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
  // Honor either offset sign; timestamps without a zone are explicitly UTC.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid UTC timestamp: ${iso}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
