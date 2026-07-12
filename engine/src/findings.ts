/**
 * Findings assembler: route + schedules + point forecasts + declared limits
 * -> evidence-bearing findings JSON (contracts/findings.schema.json).
 *
 * Every number a user sees must be traceable: evidence entries carry
 * rule id, model, run, leg, hour, value, limit, source kind.
 */

import { assessDisagreement } from './disagreement.js';
import { computeSchedules, parseUtc } from './eta.js';
import { countExceedance, fraction, phraseExceedance } from './exceedance.js';
import { hazardNoun, plainValueVsLimit } from './plainLanguage.js';
import {
  GridSampler,
  alongCourseKt,
  crossCourseKt,
  currentSetDeg,
  currentSpeedKt,
  type RegionGrid,
} from './grids.js';
import { contentHash } from './hash.js';
import { haversineNm, interpolatePosition, wrap180 } from './geo.js';
import { squallPotential } from './hazards/convective.js';
import { assessGates, type GateDef, type TidesDoc } from './hazards/tides.js';
import { evaluateMinVisibility, fogRisk, visibilityNm } from './hazards/visibility.js';
import { assessCrossSea, steepness, windAgainstSwell } from './hazards/waves.js';
import {
  approachingRatio,
  evaluateAgainstLimit,
  pointOfSail,
  sustainedLimitKt,
  trueWindAngle,
} from './limits.js';
import { deriveLegs, legMidpoints } from './route.js';
import { decideVerdict, worstEvidence } from './verdict.js';
import { assignEventKeys } from './events.js';
import type {
  EnsemblePointForecast,
  EnsembleRequestMeta,
  ForecastRequestMeta,
  HazardPointForecast,
  MarineRequestMeta,
  MultiModelRequestMeta,
  PointForecast,
  WavePointForecast,
} from './fetch/openMeteo.js';
import type {
  Evidence,
  CapabilityCoverage,
  CausalEvent,
  Findings,
  FindingsEvent,
  LegFinding,
  LegHour,
  LimitsProfile,
  Route,
  SynopticFeatures,
  WarningsInput,
} from './types.js';

export const RULES = {
  SUSTAINED: 'W-SUST-01',
  GUST: 'W-GUST-01',
  SUSTAINED_ENSEMBLE: 'W-SUST-03',
  GUST_ENSEMBLE: 'W-GUST-03',
  WIND_AGAINST_CURRENT: 'T-WAC-01',
  WAVE_HEIGHT: 'S-WAVE-01',
  STEEPNESS: 'S-STEEP-01',
  CROSS_SEA: 'S-CROSS-01',
  WIND_AGAINST_SWELL: 'S-WAS-01',
  SQUALL: 'C-CAPE-01',
  VISIBILITY: 'V-VIS-01',
  DIVERGENCE: 'D-DIVERGE-01',
  AUTHORITY: 'A-WARN-01',
} as const;

const DEFAULT_SCENARIO_FLOOR = 0.3;

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
  /** wave forecasts per leg midpoint (M3+) */
  legMarine?: WavePointForecast[];
  marineMeta?: MarineRequestMeta;
  /** multi-model deterministic forecasts for hazards + disagreement (M3+) */
  multiModel?: { byModel: Record<string, HazardPointForecast[]>; meta: MultiModelRequestMeta };
  /** official marine warnings (M5 seam; live/synthetic feed lands at M9) */
  warnings?: WarningsInput;
  /** prepared CMEMS surface-current region grid (M7+) */
  currentGrid?: RegionGrid;
  /** tidal gates (M10): HW/LW predictions + named-gate timing rules */
  tides?: TidesDoc;
  gates?: GateDef[];
  /** prepared synoptic system tracks used for conservative route attribution */
  synoptic?: SynopticFeatures;
  engineVersion: string;
  /** injected clock (ms) for byte-stable goldens */
  nowMs: number;
}

export function assembleFindings(options: AssembleOptions): Findings {
  const {
    route,
    profile,
    departureUtc,
    legForecasts,
    requestMeta,
    legEnsembles,
    ensembleMeta,
    legMarine,
    marineMeta,
    multiModel,
  } = options;
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
  const grid = options.currentGrid;
  const gridSampler = grid ? new GridSampler(grid) : null;
  const currentSampler = gridSampler
    ? (lat: number, lon: number, timeMs: number) => gridSampler.sample(lat, lon, timeMs)
    : undefined;
  const schedules = computeSchedules(legs, route.speeds_kt, departureUtc, currentSampler);
  const ratio = approachingRatio(profile);
  const scenarioFloor = profile.scenario_fraction_floor ?? DEFAULT_SCENARIO_FLOOR;

  const evidence: Evidence[] = [];
  const events: FindingsEvent[] = [];
  const verdictCandidates: Array<{ evidence: Evidence; ratio: number }> = [];
  let evidenceCounter = 0;
  let anyExceeded = false;
  let anyApproaching = false;
  let scenarioFractionAboveFloor = false;
  let insufficientConfidence = false;

  const model = requestMeta[0]?.model ?? null;
  const run = requestMeta[0]?.run_inferred ?? null;
  const ensembleModel = ensembleMeta ? `${ensembleMeta.model} ensemble` : null;
  const ensembleRun = ensembleMeta?.run_inferred ?? null;
  const marineModel = marineMeta ? `marine ${marineMeta.model}` : null;
  /** visibility source order: ICON-EU (EU high-res) then GFS — ECMWF has no visibility */
  const VIS_MODELS = ['icon_eu', 'gfs_global'];

  const nextEvidence = (partial: Omit<Evidence, 'evidence_id'>): Evidence => {
    evidenceCounter += 1;
    const e = { evidence_id: `E${evidenceCounter}`, ...partial };
    evidence.push(e);
    return e;
  };

  const legFindings: LegFinding[] = legs.map((leg, i) => {
    const schedule = schedules[i]!;
    const forecast = legForecasts[i]!;
    const timeIndex = new Map<number, number>();
    forecast.times.forEach((t, idx) => timeIndex.set(parseUtc(t), idx));

    const ensemble = legEnsembles?.[i] ?? null;
    const ensembleTimeIndex = new Map<number, number>();
    ensemble?.times.forEach((t, idx) => ensembleTimeIndex.set(parseUtc(t), idx));

    const marine = legMarine?.[i] ?? null;
    const marineTimeIndex = new Map<number, number>();
    marine?.times.forEach((t, idx) => marineTimeIndex.set(parseUtc(t), idx));

    const modelIndexes: Array<{ model: string; fc: HazardPointForecast; index: Map<number, number> }> =
      [];
    if (multiModel) {
      for (const [m, forecasts] of Object.entries(multiModel.byModel)) {
        const fc = forecasts[i];
        if (!fc) continue;
        const index = new Map<number, number>();
        fc.times.forEach((t, idx) => index.set(parseUtc(t), idx));
        modelIndexes.push({ model: m, fc, index });
      }
    }

    const midpointPos = interpolatePosition(leg.from, leg.to, 0.5);
    const hours: LegHour[] = [];
    let worstWac: { hour: LegHour; opposition: number } | null = null;
    let worstSustained: { hour: LegHour; limit: number; ratio: number } | null = null;
    let worstGust: { hour: LegHour; ratio: number } | null = null;
    let worstEnsembleGust: { hour: LegHour; count: { exceed: number; total: number } } | null = null;
    let worstEnsembleSustained: {
      hour: LegHour;
      count: { exceed: number; total: number };
      limit: number;
    } | null = null;
    let worstWave: { hour: LegHour; ratio: number } | null = null;
    let worstSteepness: { hour: LegHour; ratio: number } | null = null;
    let worstVisibility: { hour: LegHour } | null = null;
    let maxCape: { hour: LegHour; level: 'elevated' | 'high' } | null = null;
    let crossSeaHour: LegHour | null = null;
    let windAgainstSwellHour: LegHour | null = null;
    const disagreementInput: Array<{
      valid_time: string;
      byModel: Record<string, number | null>;
      sustained_limit_kt: number;
    }> = [];
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

      // ---- surface current at this hour (M7, CMEMS region grid) ----
      if (gridSampler) {
        const sample = gridSampler.sample(midpointPos.lat, midpointPos.lon, parseUtc(validTime));
        if (sample) {
          const speed = currentSpeedKt(sample);
          const set = currentSetDeg(sample);
          // wind-against-current: water moving INTO the wind (set ≈ wind-from direction)
          // steepens the sea — the Alderney Race effect. Needs real current + real wind.
          const opposition =
            windDir !== null && wind !== null && speed >= 1 && wind >= 12
              ? 180 - Math.abs(wrap180(set - windDir))
              : null;
          const wac = opposition !== null && opposition > 135;
          hour.current = {
            u_kt: sample.u_kt,
            v_kt: sample.v_kt,
            speed_kt: speed,
            set_deg: Math.round(set),
            along_kt: alongCourseKt(sample, leg.bearing_deg_true),
            cross_kt: crossCourseKt(sample, leg.bearing_deg_true),
            wind_against_current: wac,
          };
          if (wac && (!worstWac || speed > (worstWac.hour.current?.speed_kt ?? 0))) {
            worstWac = { hour, opposition: opposition! };
          }
        } else {
          hour.current = null;
        }
      }

      // ---- sea state (M3, deterministic wave model only) ----
      if (marine) {
        const mIdx = marineTimeIndex.get(parseUtc(validTime));
        if (mIdx !== undefined) {
          const hs = marine.hs_m[mIdx] ?? null;
          const period = marine.period_s[mIdx] ?? null;
          const st = hs !== null && period !== null ? steepness(hs, period) : null;
          const crossSea = assessCrossSea(
            marine.wind_wave_h_m[mIdx] ?? null,
            marine.wind_wave_dir_deg[mIdx] ?? null,
            marine.swell_h_m[mIdx] ?? null,
            marine.swell_dir_deg[mIdx] ?? null,
          );
          const was = windAgainstSwell(
            windDir,
            wind,
            marine.swell_dir_deg[mIdx] ?? null,
            marine.swell_h_m[mIdx] ?? null,
          );
          hour.waves = {
            hs_m: hs,
            period_s: period,
            steepness: st !== null ? Math.round(st * 10000) / 10000 : null,
            wind_wave_h_m: marine.wind_wave_h_m[mIdx] ?? null,
            swell_h_m: marine.swell_h_m[mIdx] ?? null,
            cross_sea_deg: crossSea?.angle_deg ?? null,
            cross_sea_significant: crossSea?.significant ?? false,
            wind_against_swell: was,
          };
          if (profile.max_wave_height_m !== undefined) {
            const status = evaluateAgainstLimit(hs, profile.max_wave_height_m, ratio);
            hour.limit_status.wave = status;
            if (status === 'exceeded') anyExceeded = true;
            if (status === 'approaching') anyApproaching = true;
            if (hs !== null && (status === 'exceeded' || status === 'approaching')) {
              const r = hs / profile.max_wave_height_m;
              if (!worstWave || r > worstWave.ratio) worstWave = { hour, ratio: r };
            }
          }
          if (profile.max_steepness !== undefined && st !== null) {
            const status = evaluateAgainstLimit(st, profile.max_steepness, ratio);
            hour.limit_status.steepness = status;
            if (status === 'exceeded') anyExceeded = true;
            if (status === 'approaching') anyApproaching = true;
            if (status === 'exceeded' || status === 'approaching') {
              const r = st / profile.max_steepness;
              if (!worstSteepness || r > worstSteepness.ratio) worstSteepness = { hour, ratio: r };
            }
          }
          if (profile.cross_sea_flag && crossSea?.significant && !crossSeaHour) crossSeaHour = hour;
          if (was && !windAgainstSwellHour) windAgainstSwellHour = hour;
        }
      }

      // ---- convective screening + visibility/fog + model disagreement (M3) ----
      if (modelIndexes.length > 0) {
        const primary = modelIndexes.find((m) => m.model === model) ?? modelIndexes[0]!;
        const pIdx = primary.index.get(parseUtc(validTime));
        if (pIdx !== undefined) {
          const cape = primary.fc.cape_jkg[pIdx] ?? null;
          hour.cape_jkg = cape;
          hour.squall_potential = squallPotential(cape);
          if (hour.squall_potential === 'high') {
            anyApproaching = true;
            if (!maxCape || (cape ?? 0) > (maxCape.hour.cape_jkg ?? 0)) {
              maxCape = { hour, level: 'high' };
            }
          } else if (hour.squall_potential === 'elevated' && !maxCape) {
            maxCape = { hour, level: 'elevated' };
          }
          hour.fog_risk = fogRisk(
            primary.fc.temp_c[pIdx] ?? null,
            primary.fc.dew_point_c[pIdx] ?? null,
            wind,
          );
        }
        for (const vm of VIS_MODELS) {
          const src = modelIndexes.find((m) => m.model === vm);
          const vIdx = src?.index.get(parseUtc(validTime));
          const visM = vIdx !== undefined ? (src!.fc.visibility_m[vIdx] ?? null) : null;
          if (visM !== null) {
            hour.visibility_nm = visibilityNm(visM);
            break;
          }
        }
        const visStatus = evaluateMinVisibility(
          hour.visibility_nm ?? null,
          profile.min_visibility_nm,
        );
        hour.limit_status.visibility = visStatus;
        if (visStatus === 'exceeded') {
          anyExceeded = true;
          if (!worstVisibility || (hour.visibility_nm ?? 99) < (worstVisibility.hour.visibility_nm ?? 99)) {
            worstVisibility = { hour };
          }
        }
        if (visStatus === 'approaching') anyApproaching = true;

        const byModelWind: Record<string, number | null> = {};
        for (const m of modelIndexes) {
          const idx2 = m.index.get(parseUtc(validTime));
          byModelWind[m.model] = idx2 !== undefined ? (m.fc.wind_kt[idx2] ?? null) : null;
        }
        const windVals = Object.values(byModelWind).filter((v): v is number => v !== null);
        hour.model_spread_kt =
          windVals.length >= 2
            ? Math.round((Math.max(...windVals) - Math.min(...windVals)) * 10) / 10
            : null;
        disagreementInput.push({
          valid_time: validTime,
          byModel: byModelWind,
          sustained_limit_kt: sustainedLimit,
        });
      }

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
    // ---- M7: wind-against-current (steep breaking seas — Alderney Race effect) ----
    if (worstWac) {
      const c = worstWac.hour.current!;
      const e = nextEvidence({
        rule_id: RULES.WIND_AGAINST_CURRENT,
        model: grid?.source.dataset_id ?? 'cmems',
        run: grid?.run_id ?? null,
        leg_id: leg.leg_id,
        valid_time: worstWac.hour.valid_time,
        value: `${c.speed_kt} kt set ${c.set_deg}° vs wind ${worstWac.hour.wind_kt} kt from ${worstWac.hour.wind_dir_deg}°`,
        limit: null,
        units: null,
        source_kind: grid?.source.mode === 'synthetic' ? 'emulated' : 'currents',
      });
      events.push({
        kind: 'wind_against_current',
        leg_id: leg.leg_id,
        window: { from: worstWac.hour.valid_time, to: worstWac.hour.valid_time },
        refs: [e.evidence_id],
      });
      anyApproaching = true; // steep breaking seas deserve at least a look
    }

    // ---- M3 hazard evidence ----
    if (worstWave) {
      const e = nextEvidence({
        rule_id: RULES.WAVE_HEIGHT,
        model: marineModel,
        run: null,
        leg_id: leg.leg_id,
        valid_time: worstWave.hour.valid_time,
        value: worstWave.hour.waves?.hs_m ?? null,
        limit: profile.max_wave_height_m ?? null,
        units: 'm',
        source_kind: 'deterministic',
      });
      verdictCandidates.push({ evidence: e, ratio: worstWave.ratio });
    }
    if (worstSteepness) {
      const e = nextEvidence({
        rule_id: RULES.STEEPNESS,
        model: marineModel,
        run: null,
        leg_id: leg.leg_id,
        valid_time: worstSteepness.hour.valid_time,
        value: worstSteepness.hour.waves?.steepness ?? null,
        limit: profile.max_steepness ?? null,
        units: 'H/L',
        source_kind: 'deterministic',
      });
      verdictCandidates.push({ evidence: e, ratio: worstSteepness.ratio });
    }
    if (crossSeaHour) {
      const e = nextEvidence({
        rule_id: RULES.CROSS_SEA,
        model: marineModel,
        run: null,
        leg_id: leg.leg_id,
        valid_time: crossSeaHour.valid_time,
        value: crossSeaHour.waves?.cross_sea_deg ?? null,
        limit: 45,
        units: 'deg',
        source_kind: 'deterministic',
      });
      events.push({
        kind: 'cross_sea',
        leg_id: leg.leg_id,
        window: { from: crossSeaHour.valid_time, to: crossSeaHour.valid_time },
        refs: [e.evidence_id],
      });
    }
    if (windAgainstSwellHour) {
      const e = nextEvidence({
        rule_id: RULES.WIND_AGAINST_SWELL,
        model: marineModel,
        run: null,
        leg_id: leg.leg_id,
        valid_time: windAgainstSwellHour.valid_time,
        value: windAgainstSwellHour.waves?.swell_h_m ?? null,
        limit: null,
        units: 'm',
        source_kind: 'deterministic',
      });
      events.push({
        kind: 'wind_against_swell',
        leg_id: leg.leg_id,
        window: { from: windAgainstSwellHour.valid_time, to: windAgainstSwellHour.valid_time },
        refs: [e.evidence_id],
      });
    }
    if (maxCape) {
      const e = nextEvidence({
        rule_id: RULES.SQUALL,
        model,
        run,
        leg_id: leg.leg_id,
        valid_time: maxCape.hour.valid_time,
        value: maxCape.hour.cape_jkg ?? null,
        limit: maxCape.level === 'high' ? 1000 : 300,
        units: 'J/kg',
        source_kind: 'deterministic',
      });
      events.push({
        kind: 'squall_potential',
        leg_id: leg.leg_id,
        window: { from: maxCape.hour.valid_time, to: maxCape.hour.valid_time },
        refs: [e.evidence_id],
      });
    }
    if (worstVisibility) {
      nextEvidence({
        rule_id: RULES.VISIBILITY,
        model: 'icon_eu/gfs_global',
        run,
        leg_id: leg.leg_id,
        valid_time: worstVisibility.hour.valid_time,
        value: worstVisibility.hour.visibility_nm ?? null,
        limit: profile.min_visibility_nm ?? null,
        units: 'nm (minimum)',
        source_kind: 'deterministic',
      });
    }

    // ---- model disagreement (M3) ----
    let divergentHours: LegFinding['divergent_hours'];
    if (disagreementInput.length > 0) {
      const result = assessDisagreement(disagreementInput);
      if (result.divergent_hours.length > 0) {
        divergentHours = result.divergent_hours;
        const worstDivergence = result.divergent_hours.reduce((a, b) =>
          b.spread_kt > a.spread_kt ? b : a,
        );
        const e = nextEvidence({
          rule_id: RULES.DIVERGENCE,
          model: Object.keys(worstDivergence.values).join(','),
          run,
          leg_id: leg.leg_id,
          valid_time: worstDivergence.valid_time,
          value: worstDivergence.values,
          limit: null,
          units: 'kt spread',
          source_kind: 'deterministic',
        });
        events.push({
          kind: 'model_divergence',
          leg_id: leg.leg_id,
          window: {
            from: result.divergent_hours[0]!.valid_time,
            to: result.divergent_hours[result.divergent_hours.length - 1]!.valid_time,
          },
          refs: [e.evidence_id],
        });
      }
      if (result.insufficient) insufficientConfidence = true;
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
      ...(divergentHours ? { divergent_hours: divergentHours } : {}),
    };
  });

  // ---- tidal gates (M10): transit timing vs favorable windows ----
  const gateAssessments =
    options.tides && options.gates
      ? assessGates(options.gates, options.tides, legs, schedules)
      : [];
  for (const gate of gateAssessments) {
    const e = nextEvidence({
      rule_id: 'T-GATE-01',
      model: options.tides!.source.mode === 'synthetic' ? 'synthetic harmonics' : 'tide tables',
      run: null,
      leg_id: gate.leg_id,
      valid_time: gate.transit.from,
      value: `${gate.name}: transit ${gate.transit.from}–${gate.transit.to} vs ${gate.rule_text}`,
      limit: null,
      units: null,
      source_kind: options.tides!.source.mode === 'synthetic' ? 'emulated' : 'tides',
    });
    events.push({
      kind: `gate_${gate.status}`,
      leg_id: gate.leg_id,
      window: gate.transit,
      refs: [e.evidence_id],
    });
    if (gate.status === 'conflict' || gate.status === 'marginal') anyApproaching = true;
  }

  // ---- official warnings: authority override (brief §7) ----
  // A bulletin covering a route zone and overlapping the passage window forces the
  // authority state. It never claims a numeric limit was exceeded.
  const departureMs = parseUtc(departureUtc);
  const slowArrivalMs = parseUtc(schedules[schedules.length - 1]!.exit.slow);
  let warningActive = false;
  let warningBulletinRef: string | null = null;
  if (options.warnings) {
    const { doc, routeZoneIds } = options.warnings;
    for (const bulletin of doc.bulletins) {
      if (!routeZoneIds.includes(bulletin.zone_id)) continue;
      if (parseUtc(bulletin.valid_from) >= slowArrivalMs) continue;
      if (parseUtc(bulletin.valid_to) <= departureMs) continue;
      warningActive = true;
      warningBulletinRef = `${bulletin.zone_id}:${bulletin.kind}:${bulletin.valid_from}`;
      nextEvidence({
        rule_id: RULES.AUTHORITY,
        model: doc.source.name ?? 'official bulletin',
        run: null,
        leg_id: null,
        valid_time: bulletin.valid_from,
        value: `${bulletin.kind} — ${bulletin.zone_name ?? bulletin.zone_id}`,
        limit: null,
        units: null,
        source_kind: doc.source.mode === 'synthetic' ? 'emulated' : 'warning',
        bulletin_ref: {
          source: doc.source.name ?? 'official bulletin',
          issued_at: doc.fetched_at,
          valid_from: bulletin.valid_from,
          valid_to: bulletin.valid_to,
          zone_ids: [bulletin.zone_id],
        },
      });
      events.push({
        kind: 'official_warning',
        window: { from: bulletin.valid_from, to: bulletin.valid_to },
        refs: [evidence[evidence.length - 1]!.evidence_id],
      });
    }
  }

  const worst = worstEvidence(verdictCandidates);
  const verdict = decideVerdict({
    worstRatio: worst?.ratio ?? null,
    anyExceeded,
    anyApproaching,
    scenarioFractionAboveFloor,
    insufficientConfidence,
    warningActive,
    warningBulletinRef,
    driverEvidenceId: worst?.evidence.evidence_id ?? null,
  });

  const routeHash = contentHash(route);
  const profileHash = contentHash(profile);
  const allMeta: Array<Record<string, unknown>> = requestMeta.map((m) => ({ ...m }));
  if (ensembleMeta) allMeta.push({ ...ensembleMeta });
  if (marineMeta) allMeta.push({ ...marineMeta });
  if (multiModel) allMeta.push({ ...multiModel.meta });
  if (grid) {
    allMeta.push({
      api: 'cmems-current-grid',
      model: grid.source.dataset_id ?? 'cmems',
      run: grid.run_id,
      mode: grid.source.mode,
      fetched_at: grid.source.fetched_at ?? grid.generated_at,
      resolution_deg: grid.source.resolution_deg ?? null,
      request_digest: contentHash({ run: grid.run_id, kind: grid.kind }),
    });
  }
  const inputs = {
    prepared_run_id: options.synoptic?.run_id ?? grid?.run_id ?? null,
    synoptic_run_id: options.synoptic?.run_id ?? null,
    openmeteo: allMeta,
    warnings_ref: options.warnings?.ref ?? null,
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
      ...(marineMeta ? [marineMeta.request_digest] : []),
      ...(multiModel ? [multiModel.meta.request_digest] : []),
      ...(grid ? [grid.run_id] : []),
      ...(options.synoptic ? [options.synoptic.run_id] : []),
    ],
  }).slice(0, 8)}`;

  const causalEvents = assignEventKeys(
    [
      ...deriveCausalEvents(options.synoptic, legFindings, evidence),
      ...deriveOperationalEvents(gateAssessments, events, evidence, legFindings),
    ].map((event, index) => ({ ...event, event_id: `CE${index + 1}` })),
    options.synoptic,
  );
  const coverage = deriveCoverage({
    evidence,
    hasEnsemble: Boolean(legEnsembles),
    hasMarine: Boolean(legMarine),
    hasMultiModel: Boolean(multiModel),
    warnings: options.warnings,
    hasCurrents: Boolean(grid),
    hasTides: Boolean(options.tides && options.gates),
    hasSynoptic: Boolean(options.synoptic),
    currentDetail: grid?.under_resolved_note,
  });

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
    coverage,
    causal_events: causalEvents,
    ...(gateAssessments.length ? { gates: gateAssessments } : {}),
    unsupported_hazards: coverage
      .filter((item) => item.status === 'not_assessed')
      .map((item) => item.detail ?? item.capability.replaceAll('_', ' ')),
  };
}

interface CoverageInputs {
  evidence: Evidence[];
  hasEnsemble: boolean;
  hasMarine: boolean;
  hasMultiModel: boolean;
  warnings?: WarningsInput;
  hasCurrents: boolean;
  hasTides: boolean;
  hasSynoptic: boolean;
  currentDetail?: string | null;
}

function deriveCoverage(input: CoverageInputs): CapabilityCoverage[] {
  const ids = (rules: string[]) =>
    input.evidence.filter((item) => rules.includes(item.rule_id)).map((item) => item.evidence_id);
  const warningIds = ids([RULES.AUTHORITY]);
  const warningStatus = !input.warnings
    ? 'not_assessed'
    : input.warnings.doc.source.mode === 'synthetic'
      ? 'assessed_emulated'
      : 'assessed';
  return [
    { capability: 'sustained_wind', status: 'assessed', evidence_ids: ids([RULES.SUSTAINED, RULES.SUSTAINED_ENSEMBLE]) },
    { capability: 'gusts', status: input.hasEnsemble ? 'assessed' : 'partially_assessed', evidence_ids: ids([RULES.GUST, RULES.GUST_ENSEMBLE]) },
    {
      capability: 'waves',
      status: input.hasMarine ? 'partially_assessed' : 'not_assessed',
      detail: input.hasMarine
        ? 'deterministic wave model only; no wave ensemble'
        : 'waves (no marine forecast input)',
      evidence_ids: ids([RULES.WAVE_HEIGHT, RULES.STEEPNESS, RULES.CROSS_SEA, RULES.WIND_AGAINST_SWELL]),
    },
    {
      capability: 'visibility_and_convection',
      status: input.hasMultiModel ? 'partially_assessed' : 'not_assessed',
      detail: input.hasMultiModel
        ? 'screening signals only; official warnings remain authoritative'
        : 'visibility and convection (no supporting model input)',
      evidence_ids: ids([RULES.VISIBILITY, RULES.SQUALL]),
    },
    {
      capability: 'tidal_currents',
      status: input.hasCurrents ? (input.currentDetail ? 'partially_assessed' : 'assessed') : 'not_assessed',
      detail: input.hasCurrents
        ? input.currentDetail ?? 'prepared current grid assessed'
        : 'tidal currents (no prepared current grid)',
      evidence_ids: ids([RULES.WIND_AGAINST_CURRENT]),
    },
    {
      capability: 'tidal_gates',
      status: input.hasTides ? 'assessed' : 'not_assessed',
      detail: input.hasTides ? undefined : 'tidal gates & HW/LW heights (no tide data)',
      evidence_ids: ids(['T-GATE-01']),
    },
    {
      capability: 'official_warnings',
      status: warningStatus,
      detail:
        warningStatus === 'not_assessed'
          ? 'official marine warnings (no feed configured)'
          : warningStatus === 'assessed_emulated'
            ? 'synthetic bulletin scenario; not authority'
            : 'official warning feed assessed for route zones',
      evidence_ids: warningIds,
    },
    {
      capability: 'synoptic_attribution',
      status: input.hasSynoptic ? 'assessed' : 'not_assessed',
      detail: input.hasSynoptic
        ? 'system tracks assessed against the route ETA envelope'
        : 'causal synoptic attribution (no prepared synoptic run)',
    },
    { capability: 'tropical_systems', status: 'not_assessed', detail: 'tropical systems' },
    { capability: 'ice', status: 'not_assessed', detail: 'ice' },
  ];
}

/**
 * Attribute only evidence that is on the affected leg and inside the interval in
 * which a tracked system is near the route. Broad weather-system influence is
 * deliberately not inferred when there is no temporal and spatial overlap.
 */
function deriveCausalEvents(
  synoptic: SynopticFeatures | undefined,
  legs: LegFinding[],
  evidence: Evidence[],
): CausalEvent[] {
  if (!synoptic) return [];
  const causal: CausalEvent[] = [];
  const HOUR = 3600_000;
  for (const system of synoptic.systems) {
    for (const leg of legs) {
      const occupancyStart = Date.parse(leg.enter_range.fast);
      // Findings are evaluated at whole forecast hours, including the ceiling
      // hour that contains the slow ETA. Keep attribution on that same grid.
      const occupancyEnd = Date.parse(leg.eta_range.slow) + HOUR;
      const nearby = system.track.filter((point) => {
        const time = Date.parse(point.valid_time);
        return (
          time >= occupancyStart - 3 * HOUR &&
          time <= occupancyEnd + 3 * HOUR &&
          haversineNm(point.lat, point.lon, leg.sample_point.lat, leg.sample_point.lon) <=
            (system.kind === 'low' ? 420 : 300)
        );
      });
      if (!nearby.length) continue;
      const start = Math.max(
        occupancyStart,
        Math.min(...nearby.map((point) => Date.parse(point.valid_time))) - 3 * HOUR,
      );
      const end = Math.min(
        occupancyEnd,
        Math.max(...nearby.map((point) => Date.parse(point.valid_time))) + 3 * HOUR,
      );
      const attributed = evidence.filter((item) => {
        if (item.leg_id !== leg.leg_id || !item.valid_time) return false;
        const time = Date.parse(item.valid_time);
        return time >= start && time <= end;
      });
      if (!attributed.length) continue;
      const strongest = [...attributed].sort(evidenceMateriality)[0]!;
      const pressure = nearby.reduce((best, point) =>
        system.kind === 'low'
          ? point.center_hpa < best.center_hpa ? point : best
          : point.center_hpa > best.center_hpa ? point : best,
      );
      const limitLabel = `your ${strongest.limit} ${strongest.units ?? ''} limit`.replace(/\s+/g, ' ').trim();
      const fractionText = strongest.member_fraction
        ? `${phraseExceedance(strongest.member_fraction, limitLabel)} (${hazardNoun(strongest.rule_id)})`
        : typeof strongest.value === 'number' && typeof strongest.limit === 'number'
          ? plainValueVsLimit(strongest.rule_id, strongest.value, strongest.limit, strongest.units)
          : `${String(strongest.value)} ${strongest.units ?? ''}`.trim();
      causal.push({
        event_id: `CE${causal.length + 1}`,
        name: `${system.kind === 'low' ? 'Low' : 'High'} ${system.system_id}`,
        kind: system.kind,
        system_id: system.system_id,
        route_intersection: {
          leg_id: leg.leg_id,
          window_start: new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          window_end: new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          eta_sensitivity: round1(
            (Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / HOUR,
          ),
        },
        consequence: {
          register_plain: `${fractionText.charAt(0).toUpperCase()}${fractionText.slice(1)} while ${system.kind === 'low' ? 'the low' : 'the high'} crosses ${leg.name}.`,
          register_pro: `${system.system_id} (${Math.round(pressure.center_hpa)} hPa) is within the conservative route-attribution radius during ${new Date(start).toISOString()}–${new Date(end).toISOString()}; only same-leg evidence inside that window is attributed.`,
          evidence_ids: attributed.map((item) => item.evidence_id),
        },
      });
    }
  }
  return causal;
}

function evidenceMateriality(a: Evidence, b: Evidence): number {
  const ratio = (item: Evidence) => {
    if (item.member_fraction) return item.member_fraction.exceed / item.member_fraction.total;
    if (typeof item.value === 'number' && typeof item.limit === 'number' && item.limit !== 0) {
      return item.value / item.limit;
    }
    return 0;
  };
  return ratio(b) - ratio(a);
}

function deriveOperationalEvents(
  gates: ReturnType<typeof assessGates>,
  events: FindingsEvent[],
  evidence: Evidence[],
  legs: LegFinding[],
): CausalEvent[] {
  const out: CausalEvent[] = [];
  for (const gate of gates) {
    const refs = evidence.filter((item) => item.rule_id === 'T-GATE-01' && item.leg_id === gate.leg_id);
    const leg = legs.find((item) => item.leg_id === gate.leg_id);
    out.push({
      event_id: '',
      event_key: `gate:${gate.gate_id}`,
      name: gate.name,
      kind: 'gate',
      route_intersection: {
        leg_id: gate.leg_id,
        window_start: gate.transit.from,
        window_end: gate.transit.to,
        eta_sensitivity: leg ? round1((Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / 3600_000) : 0,
      },
      consequence: {
        register_plain: `${gate.name} is ${gate.status}; ${gate.rule_text}.`,
        register_pro: `Named gate ${gate.gate_id} evaluated against ${gate.reference_port} tide timing.`,
        evidence_ids: refs.map((item) => item.evidence_id),
      },
    });
  }
  for (const event of events.filter((item) => item.kind === 'wind_against_current' && item.leg_id && item.window)) {
    const leg = legs.find((item) => item.leg_id === event.leg_id);
    out.push({
      event_id: '',
      event_key: `wind-against-current:${event.leg_id}`,
      name: `Wind against current · ${leg?.name ?? event.leg_id}`,
      kind: 'wind_against_current',
      route_intersection: { leg_id: event.leg_id!, window_start: event.window!.from, window_end: event.window!.to, eta_sensitivity: leg ? round1((Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / 3600_000) : 0 },
      consequence: { register_plain: `Wind opposes the current at ${leg?.name ?? event.leg_id}, increasing the risk of short, steep seas.`, register_pro: 'Course-relative wind and sampled surface-current vectors oppose within the route occupancy window.', evidence_ids: event.refs },
    });
  }
  for (const warning of evidence.filter((item) => item.rule_id === RULES.AUTHORITY && item.bulletin_ref)) {
    const zones = warning.bulletin_ref!.zone_ids;
    out.push({
      event_id: '',
      event_key: `warning:${zones.join('+')}:${warning.bulletin_ref!.valid_from}`,
      name: `${zones.join(' / ')} marine warning`,
      kind: 'front',
      consequence: { register_plain: `${warning.value} covers a crossed marine zone.`, register_pro: `Bulletin source ${warning.bulletin_ref!.source}; valid ${warning.bulletin_ref!.valid_from}–${warning.bulletin_ref!.valid_to}.`, evidence_ids: [warning.evidence_id] },
    });
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
