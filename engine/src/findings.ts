/**
 * Findings assembler: route + schedules + point forecasts + declared limits
 * -> evidence-bearing findings JSON (contracts/findings.schema.json).
 *
 * Every number a user sees must be traceable: evidence entries carry
 * rule id, model, run, leg, hour, value, limit, source kind.
 */

import { computeSchedules, parseUtc } from './eta.js';
import { contentHash } from './hash.js';
import {
  approachingRatio,
  evaluateAgainstLimit,
  pointOfSail,
  sustainedLimitKt,
  trueWindAngle,
} from './limits.js';
import { deriveLegs, legMidpoints } from './route.js';
import { decideVerdict, worstEvidence } from './verdict.js';
import type { ForecastRequestMeta, PointForecast } from './fetch/openMeteo.js';
import type {
  Evidence,
  Findings,
  FindingsEvent,
  LegFinding,
  LegHour,
  LimitsProfile,
  Route,
} from './types.js';

export const RULES = {
  SUSTAINED: 'W-SUST-01',
  GUST: 'W-GUST-01',
} as const;

/** Hazards this analysis did NOT assess — stated in every report (brief §5/§6). */
const UNSUPPORTED_M1 = [
  'sea state / waves',
  'convective / squalls',
  'fog / visibility',
  'tidal currents & gates',
  'official marine warnings',
  'tropical systems',
  'ice',
];

export interface AssembleOptions {
  route: Route;
  profile: LimitsProfile;
  departureUtc: string;
  /** one forecast per leg (midpoint), index-aligned with derived legs */
  legForecasts: PointForecast[];
  requestMeta: ForecastRequestMeta[];
  engineVersion: string;
  /** injected clock (ms) for byte-stable goldens */
  nowMs: number;
}

export function assembleFindings(options: AssembleOptions): Findings {
  const { route, profile, departureUtc, legForecasts, requestMeta } = options;
  if (!route.speeds_kt) {
    throw new Error(`Route ${route.route_id} has no speeds_kt (polar-based ETA lands at M11)`);
  }

  const legs = deriveLegs(route);
  if (legForecasts.length !== legs.length) {
    throw new Error(`Expected ${legs.length} leg forecasts, got ${legForecasts.length}`);
  }
  const midpoints = legMidpoints(legs);
  const schedules = computeSchedules(legs, route.speeds_kt, departureUtc);
  const ratio = approachingRatio(profile);

  const evidence: Evidence[] = [];
  const events: FindingsEvent[] = [];
  const verdictCandidates: Array<{ evidence: Evidence; ratio: number }> = [];
  let evidenceCounter = 0;
  let anyExceeded = false;
  let anyApproaching = false;

  const model = requestMeta[0]?.model ?? null;
  const run = requestMeta[0]?.run_inferred ?? null;

  const legFindings: LegFinding[] = legs.map((leg, i) => {
    const schedule = schedules[i]!;
    const forecast = legForecasts[i]!;
    const timeIndex = new Map<number, number>();
    forecast.times.forEach((t, idx) => timeIndex.set(parseUtc(t), idx));

    const hours: LegHour[] = [];
    let worstSustained: { hour: LegHour; limit: number; ratio: number } | null = null;
    let worstGust: { hour: LegHour; ratio: number } | null = null;
    const exceededWindows: string[] = [];

    for (const validTime of schedule.occupancy_hours) {
      const idx = timeIndex.get(parseUtc(validTime));
      const wind = idx !== undefined ? (forecast.wind_kt[idx] ?? null) : null;
      const gust = idx !== undefined ? (forecast.gust_kt[idx] ?? null) : null;
      const windDir = idx !== undefined ? (forecast.wind_dir_deg[idx] ?? null) : null;

      const twa = windDir !== null ? round1(trueWindAngle(windDir, leg.bearing_deg_true)) : null;
      const pos = twa !== null ? pointOfSail(twa) : null;
      const sustainedLimit = pos !== null ? sustainedLimitKt(profile, pos) : profile.max_sustained_kt.default;

      const sustainedStatus = evaluateAgainstLimit(wind, sustainedLimit, ratio);
      const gustStatus = evaluateAgainstLimit(gust, profile.max_gust_kt, ratio);

      const hour: LegHour = {
        valid_time: validTime,
        wind_kt: wind,
        gust_kt: gust,
        wind_dir_deg: windDir,
        twa_deg: twa,
        point_of_sail: pos,
        limit_status: { sustained: sustainedStatus, gust: gustStatus },
      };
      hours.push(hour);

      if (sustainedStatus === 'exceeded' || sustainedStatus === 'approaching') {
        const r = (wind as number) / sustainedLimit;
        if (!worstSustained || r > worstSustained.ratio) {
          worstSustained = { hour, limit: sustainedLimit, ratio: r };
        }
      }
      if (gustStatus === 'exceeded' || gustStatus === 'approaching') {
        const r = (gust as number) / profile.max_gust_kt;
        if (!worstGust || r > worstGust.ratio) worstGust = { hour, ratio: r };
      }
      if (sustainedStatus === 'exceeded' || gustStatus === 'exceeded') {
        anyExceeded = true;
        exceededWindows.push(validTime);
      }
      if (sustainedStatus === 'approaching' || gustStatus === 'approaching') {
        anyApproaching = true;
      }
    }

    if (worstSustained) {
      evidenceCounter += 1;
      const e: Evidence = {
        evidence_id: `E${evidenceCounter}`,
        rule_id: RULES.SUSTAINED,
        model,
        run,
        leg_id: leg.leg_id,
        valid_time: worstSustained.hour.valid_time,
        value: worstSustained.hour.wind_kt,
        limit: worstSustained.limit,
        units: 'kt',
        source_kind: 'deterministic',
      };
      evidence.push(e);
      verdictCandidates.push({ evidence: e, ratio: worstSustained.ratio });
    }
    if (worstGust) {
      evidenceCounter += 1;
      const e: Evidence = {
        evidence_id: `E${evidenceCounter}`,
        rule_id: RULES.GUST,
        model,
        run,
        leg_id: leg.leg_id,
        valid_time: worstGust.hour.valid_time,
        value: worstGust.hour.gust_kt,
        limit: profile.max_gust_kt,
        units: 'kt',
        source_kind: 'deterministic',
      };
      evidence.push(e);
      verdictCandidates.push({ evidence: e, ratio: worstGust.ratio });
    }
    if (exceededWindows.length > 0) {
      events.push({
        kind: 'limit_exceeded',
        leg_id: leg.leg_id,
        window: {
          from: exceededWindows[0]!,
          to: exceededWindows[exceededWindows.length - 1]!,
        },
        refs: evidence.filter((e) => e.leg_id === leg.leg_id).map((e) => e.evidence_id),
      });
    }

    return {
      leg_id: leg.leg_id,
      name: `${leg.from.name ?? leg.from.id} → ${leg.to.name ?? leg.to.id}`,
      distance_nm: leg.distance_nm,
      bearing_deg_true: leg.bearing_deg_true,
      eta_range: { slow: schedule.exit.slow, nominal: schedule.exit.nominal, fast: schedule.exit.fast },
      enter_range: { slow: schedule.enter.slow, nominal: schedule.enter.nominal, fast: schedule.enter.fast },
      sog_kt: schedule.sog_kt,
      hours,
      sample_point: { lat: midpoints[i]!.lat, lon: midpoints[i]!.lon },
    };
  });

  const worst = worstEvidence(verdictCandidates);
  const verdict = decideVerdict({
    worstRatio: worst?.ratio ?? null,
    anyExceeded,
    anyApproaching,
    driverEvidenceId: worst?.evidence.evidence_id ?? null,
  });

  const routeHash = contentHash(route);
  const profileHash = contentHash(profile);
  const inputs = {
    prepared_run_id: null,
    openmeteo: requestMeta.map((m) => ({ ...m })),
    warnings_ref: null,
    route_hash: routeHash,
    profile_hash: profileHash,
  };

  const departureCompact = departureUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const snapshotId = `${departureCompact}_${routeHash.slice(0, 8)}_${contentHash({
    routeHash,
    profileHash,
    departureUtc,
    digests: requestMeta.map((m) => m.request_digest),
  }).slice(0, 8)}`;

  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    route_id: route.route_id,
    profile_id: profile.profile_id,
    departure_utc: departureUtc,
    engine_version: options.engineVersion,
    generated_at: new Date(options.nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    inputs,
    legs: legFindings,
    events,
    verdict,
    evidence,
    unsupported_hazards: UNSUPPORTED_M1,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
