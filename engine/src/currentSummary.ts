/**
 * What the current did over the passage, from the findings a snapshot already
 * saves and, for a computed route, the route saved beside them. Nothing here
 * changes Findings, a schema, a golden or an identity hash, so passages saved
 * before this existed get it too.
 *
 * - Distance gained or lost (nm, positive is gained), on the nominal timing:
 *   - `routed_timing`: a computed route's own figures, leg by leg
 *     (speed_over_ground_kt - through_water_kt) x the nominal leg duration.
 *     Used only when the saved route is the one the check hashed, belongs to
 *     the same departure, was routed on a current, and that current is the
 *     one the check recorded (same prepared digest, or same tile run).
 *   - `leg_samples`: otherwise, an estimate from `LegHour.current`, which is
 *     one sample at each leg's midpoint, hour by hour. For each leg the
 *     along-course current is interpolated linearly between its hourly samples
 *     and integrated over the leg's nominal window. When any leg lacks a
 *     sample it needs, there is no passage figure (null), never a partial sum.
 * - Strongest current: the highest sample speed over every audited hour of
 *   every leg, that is the whole arrival range (fastest entry to slowest exit)
 *   the check evaluates in findings/currents.ts, so it is never lower than the
 *   current in the check's own wind-against-current (T-WAC-01) evidence; the
 *   earliest such hour on a tie, then the first leg.
 * - Wind against current, with the engine's own per-hour `wind_against_current`
 *   flag (findings/currents.ts): the hours of the passage on the nominal timing
 *   (`nominalPassageHours`, as routeSummary counts them), and separately the
 *   distinct flagged hour instants anywhere in the arrival range.
 *
 * Hours with and against the current are deliberately absent: they are only
 * meaningful from an hourly source that resolves the tidal cycle, and no saved
 * record states the current grid's time step or whether it includes tide (a
 * recorded dataset id cannot: the factory may coarsen an hourly dataset).
 */

import { parseUtc } from './eta.js';
import { contentHash } from './hash.js';
import { nominalPassageHours } from './routeSummary.js';
import type { Findings, LegFinding, LegHour, Route } from './types.js';

export interface CurrentSummary {
  /** whole hours of the passage on its nominal timing (the same count as routeSummary) */
  total_hours: number;
  /** of those, hours with no current value */
  unavailable_hours: number;
  /** distance gained (positive) or lost (negative) to the current over the passage, nm; null when it cannot be given */
  gain: { nm: number; basis: 'routed_timing' | 'leg_samples' } | null;
  /** the strongest current sample over every audited hour of the arrival range */
  strongest: { speed_kt: number; set_deg: number; valid_time: string; leg_id: string } | null;
  /** hours with the engine's wind-against-current flag on the nominal timing */
  wind_against_current_hours: number;
  /** distinct hour instants with that flag anywhere in the arrival range (every audited hour of every leg) */
  wind_against_current_arrival_hours: number;
}

const HOUR = 3_600_000;

function utcMs(iso: string | null | undefined): number {
  if (typeof iso !== 'string') return Number.NaN;
  try {
    return parseUtc(iso);
  } catch {
    return Number.NaN;
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The record of the current grid a check read: `findings.inputs.forecast_tiles`'s
 * `currents` entry (skipping one marked `available: false`, written when no grid
 * was found), else an older check's `inputs.openmeteo` entry with api
 * `cmems-current-grid`. Null when neither exists.
 */
export function currentInputRecord(findings: Findings | null | undefined): Record<string, unknown> | null {
  const inputs = findings?.inputs as (Findings['inputs'] & { openmeteo?: unknown }) | undefined;
  const record = (inputs?.forecast_tiles ?? []).find((item) => item?.layer === 'currents' && item.available !== false);
  if (record) return record;
  const legacy = Array.isArray(inputs?.openmeteo)
    ? (inputs.openmeteo as Array<Record<string, unknown>>).find((item) => item?.api === 'cmems-current-grid')
    : undefined;
  return legacy ?? null;
}

/** The routed figures, when the saved route is the one the check audited, on the same current. */
function routedGain(findings: Findings, route: Route | null | undefined): number | null {
  const timing = route?.timing;
  if (!route || timing?.basis !== 'routed') return null;
  if (findings.inputs?.route_hash !== contentHash(route)) return null;
  const departure = utcMs(timing.departure_utc);
  if (!Number.isFinite(departure) || departure !== utcMs(findings.departure_utc)) return null;
  const request = route.provenance?.routing_request as Record<string, unknown> | undefined;
  if (!request || request.current_run === null || request.current_run === undefined) return null;
  const record = currentInputRecord(findings);
  if (!record) return null;
  const sameCurrent = request.current_source === 'prepared'
    ? record.current_source === 'prepared' && typeof request.current_digest === 'string' && record.content_digest === request.current_digest
    : record.current_source !== 'prepared' && (record.run_id ?? record.run) === request.current_run;
  if (!sameCurrent) return null;
  if (timing.legs.length !== findings.legs.length) return null;
  let nm = 0;
  for (const [i, leg] of timing.legs.entries()) {
    if (leg.leg_id !== findings.legs[i]!.leg_id) return null;
    const { speed_over_ground_kt: sog, through_water_kt: stw } = leg;
    const ms = leg.duration_ms?.nominal;
    if (!finite(sog) || !finite(stw) || !finite(ms) || ms <= 0) return null;
    nm += (sog - stw) * ms / HOUR;
  }
  return nm;
}

/** One leg's along-course current integrated over its nominal window, from its hourly samples; null without them. */
function legSampleGain(leg: LegFinding): number | null {
  const from = utcMs(leg.enter_range?.nominal);
  const to = utcMs(leg.eta_range?.nominal);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  if (to === from) return 0;
  const along = new Map<number, number>();
  for (const hour of leg.hours ?? []) {
    const at = utcMs(hour.valid_time);
    const value = hour.current?.along_kt;
    if (Number.isFinite(at) && finite(value)) along.set(at, value);
  }
  const first = Math.floor(from / HOUR) * HOUR;
  const last = Math.ceil(to / HOUR) * HOUR;
  if (first === last) return along.has(first) ? along.get(first)! * (to - from) / HOUR : null;
  let nm = 0;
  for (let t = first; t < last; t += HOUR) {
    const a = along.get(t);
    const b = along.get(t + HOUR);
    if (a === undefined || b === undefined) return null;
    const start = Math.max(t, from);
    const end = Math.min(t + HOUR, to);
    if (end <= start) continue;
    const at = (time: number) => a + (b - a) * (time - t) / HOUR;
    nm += (at(start) + at(end)) / 2 * (end - start) / HOUR;
  }
  return nm;
}

function sampledGain(findings: Findings): number | null {
  let nm = 0;
  for (const leg of findings.legs) {
    const gain = legSampleGain(leg);
    if (gain === null) return null;
    nm += gain;
  }
  return nm;
}

/**
 * Gain or loss on the nominal timing, the strongest current over the arrival
 * range, and wind-against-current hours on both. `route` is the route saved with the check;
 * without it (or when it does not qualify) the gain is the leg-sample estimate.
 *
 * Returns null when no audited hour has a current value.
 */
export function currentSummary(findings: Findings | null | undefined, route?: Route | null): CurrentSummary | null {
  if (!findings?.legs?.length) return null;
  const valid = (c: LegHour['current']): c is NonNullable<LegHour['current']> => Boolean(c) && finite(c!.speed_kt) && finite(c!.along_kt);
  // the whole arrival range: every audited hour of every leg
  let strongest: CurrentSummary['strongest'] = null;
  let strongestAt = Number.POSITIVE_INFINITY;
  const flagged = new Set<number>();
  for (const leg of findings.legs) {
    for (const hour of leg.hours ?? []) {
      const c = hour.current;
      if (!valid(c)) continue;
      const at = utcMs(hour.valid_time);
      if (c.wind_against_current === true && Number.isFinite(at)) flagged.add(at);
      if (!strongest || c.speed_kt > strongest.speed_kt || (c.speed_kt === strongest.speed_kt && at < strongestAt)) {
        strongest = { speed_kt: c.speed_kt, set_deg: c.set_deg, valid_time: hour.valid_time, leg_id: leg.leg_id };
        strongestAt = at;
      }
    }
  }
  if (!strongest) return null;
  // the passage on its nominal timing
  const hours = nominalPassageHours(findings);
  let sampled = 0;
  let wac = 0;
  for (const { hour } of hours) {
    if (!valid(hour.current)) continue;
    sampled += 1;
    if (hour.current.wind_against_current === true) wac += 1;
  }
  const routed = routedGain(findings, route);
  const sampledNm = routed === null ? sampledGain(findings) : null;
  return {
    total_hours: hours.length,
    unavailable_hours: hours.length - sampled,
    gain: routed !== null ? { nm: routed, basis: 'routed_timing' }
      : sampledNm !== null ? { nm: sampledNm, basis: 'leg_samples' } : null,
    strongest,
    wind_against_current_hours: wac,
    wind_against_current_arrival_hours: flagged.size,
  };
}
