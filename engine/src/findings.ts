/**
 * Findings assembler: route + schedules + point forecasts + declared limits
 * -> evidence-bearing findings JSON (contracts/findings.schema.json).
 *
 * Every number a user sees must be traceable: evidence entries carry
 * rule id, model, run, leg, hour, value, limit, source kind.
 */

import { computeSchedules, parseUtc } from './eta.js';
import { countExceedance, fraction } from './exceedance.js';
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
import type {
  EnsemblePointForecast,
  EnsembleRequestMeta,
  ForecastRequestMeta,
  PointForecast,
} from './fetch/openMeteo.js';
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
  SUSTAINED_ENSEMBLE: 'W-SUST-03',
  GUST_ENSEMBLE: 'W-GUST-03',
} as const;

const DEFAULT_SCENARIO_FLOOR = 0.3;

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
  /** ensemble forecasts per leg midpoint (M2+); index-aligned with legs */
  legEnsembles?: EnsemblePointForecast[];
  ensembleMeta?: EnsembleRequestMeta;
  engineVersion: string;
  /** injected clock (ms) for byte-stable goldens */
  nowMs: number;
}

export function assembleFindings(options: AssembleOptions): Findings {
  const { route, profile, departureUtc, legForecasts, requestMeta, legEnsembles, ensembleMeta } =
    options;
  if (!route.speeds_kt) {
    throw new Error(`Route ${route.route_id} has no speeds_kt (polar-based ETA lands at M11)`);
  }

  const legs = deriveLegs(route);
  if (legForecasts.length !== legs.length) {
    throw new Error(`Expected ${legs.length} leg forecasts, got ${legForecasts.length}`);
  }
  if (legEnsembles && legEnsembles.length !== legs.length) {
    throw new Error(`Expected ${legs.length} leg ensembles, got ${legEnsembles.length}`);
  }
  const midpoints = legMidpoints(legs);
  const schedules = computeSchedules(legs, route.speeds_kt, departureUtc);
  const ratio = approachingRatio(profile);
  const scenarioFloor = profile.scenario_fraction_floor ?? DEFAULT_SCENARIO_FLOOR;

  const evidence: Evidence[] = [];
  const events: FindingsEvent[] = [];
  const verdictCandidates: Array<{ evidence: Evidence; ratio: number }> = [];
  let evidenceCounter = 0;
  let anyExceeded = false;
  let anyApproaching = false;
  let scenarioFractionAboveFloor = false;

  const model = requestMeta[0]?.model ?? null;
  const run = requestMeta[0]?.run_inferred ?? null;
  const ensembleModel = ensembleMeta ? `${ensembleMeta.model} ensemble` : null;
  const ensembleRun = ensembleMeta?.run_inferred ?? null;

  const legFindings: LegFinding[] = legs.map((leg, i) => {
    const schedule = schedules[i]!;
    const forecast = legForecasts[i]!;
    const timeIndex = new Map<number, number>();
    forecast.times.forEach((t, idx) => timeIndex.set(parseUtc(t), idx));

    const ensemble = legEnsembles?.[i] ?? null;
    const ensembleTimeIndex = new Map<number, number>();
    ensemble?.times.forEach((t, idx) => ensembleTimeIndex.set(parseUtc(t), idx));

    const hours: LegHour[] = [];
    let worstSustained: { hour: LegHour; limit: number; ratio: number } | null = null;
    let worstGust: { hour: LegHour; ratio: number } | null = null;
    let worstEnsembleGust: { hour: LegHour; count: { exceed: number; total: number } } | null = null;
    let worstEnsembleSustained: {
      hour: LegHour;
      count: { exceed: number; total: number };
      limit: number;
    } | null = null;
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

      // ensemble scenario exceedance for this hour (direction for the POS limit comes
      // from the deterministic run — members carry speed/gusts only; documented in §6 layer)
      if (ensemble) {
        const eIdx = ensembleTimeIndex.get(parseUtc(validTime));
        if (eIdx !== undefined) {
          const gustCount = countExceedance(ensemble.gust_kt_members, eIdx, profile.max_gust_kt);
          const sustainedCount = countExceedance(ensemble.wind_kt_members, eIdx, sustainedLimit);
          hour.exceedance = { sustained: sustainedCount, gust: gustCount };
          if (gustCount && fraction(gustCount) >= scenarioFloor) scenarioFractionAboveFloor = true;
          if (sustainedCount && fraction(sustainedCount) >= scenarioFloor) {
            scenarioFractionAboveFloor = true;
          }
          if (gustCount && (!worstEnsembleGust || fraction(gustCount) > fraction(worstEnsembleGust.count))) {
            worstEnsembleGust = { hour, count: gustCount };
          }
          if (
            sustainedCount &&
            (!worstEnsembleSustained ||
              fraction(sustainedCount) > fraction(worstEnsembleSustained.count))
          ) {
            worstEnsembleSustained = { hour, count: sustainedCount, limit: sustainedLimit };
          }
        }
      }
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
    if (worstEnsembleGust && worstEnsembleGust.count.exceed > 0) {
      evidenceCounter += 1;
      const e: Evidence = {
        evidence_id: `E${evidenceCounter}`,
        rule_id: RULES.GUST_ENSEMBLE,
        model: ensembleModel,
        run: ensembleRun,
        leg_id: leg.leg_id,
        valid_time: worstEnsembleGust.hour.valid_time,
        value: worstEnsembleGust.count.exceed,
        limit: profile.max_gust_kt,
        units: 'kt',
        source_kind: 'ensemble',
        member_fraction: worstEnsembleGust.count,
      };
      evidence.push(e);
      verdictCandidates.push({
        evidence: e,
        ratio: fraction(worstEnsembleGust.count) / scenarioFloor,
      });
    }
    if (worstEnsembleSustained && worstEnsembleSustained.count.exceed > 0) {
      evidenceCounter += 1;
      const e: Evidence = {
        evidence_id: `E${evidenceCounter}`,
        rule_id: RULES.SUSTAINED_ENSEMBLE,
        model: ensembleModel,
        run: ensembleRun,
        leg_id: leg.leg_id,
        valid_time: worstEnsembleSustained.hour.valid_time,
        value: worstEnsembleSustained.count.exceed,
        limit: worstEnsembleSustained.limit,
        units: 'kt',
        source_kind: 'ensemble',
        member_fraction: worstEnsembleSustained.count,
      };
      evidence.push(e);
      verdictCandidates.push({
        evidence: e,
        ratio: fraction(worstEnsembleSustained.count) / scenarioFloor,
      });
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
    scenarioFractionAboveFloor,
    driverEvidenceId: worst?.evidence.evidence_id ?? null,
  });

  const routeHash = contentHash(route);
  const profileHash = contentHash(profile);
  const allMeta: Array<Record<string, unknown>> = requestMeta.map((m) => ({ ...m }));
  if (ensembleMeta) allMeta.push({ ...ensembleMeta });
  const inputs = {
    prepared_run_id: null,
    openmeteo: allMeta,
    warnings_ref: null,
    route_hash: routeHash,
    profile_hash: profileHash,
  };

  const departureCompact = departureUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const snapshotId = `${departureCompact}_${routeHash.slice(0, 8)}_${contentHash({
    routeHash,
    profileHash,
    departureUtc,
    digests: [
      ...requestMeta.map((m) => m.request_digest),
      ...(ensembleMeta ? [ensembleMeta.request_digest] : []),
    ],
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
