import { assessDisagreement } from '../disagreement.js';
import { modelRunAt } from '../forecast/modelRuns.js';
import { fraction } from '../exceedance.js';
import { interpolatePosition } from '../geo.js';
import type { GridSampler } from '../grids.js';
import { CAPE_HIGH_JKG, CAPE_ELEVATED_JKG } from '../hazards/convective.js';
import { CROSS_SEA_ANGLE_DEG } from '../hazards/waves.js';
import { parseUtc, toIso, type LegSchedule } from '../eta.js';
import type { Evidence, FindingsEvent, Leg, LegFinding, LegHour, SamplePoint } from '../types.js';
import { expectedPointIndex, legHourCandidates, type AuditSamplePoint } from '../auditSampling.js';
import type { AssembleOptions } from './options.js';
import { createEvidenceCollector } from './evidence.js';
import { RULES } from './rules.js';
import { evaluateWind } from './wind.js';
import { evaluateCurrents } from './currents.js';
import { evaluateSeaState } from './seaState.js';
import { evaluateHazards, VIS_MODELS } from './hazards.js';
import { evaluateEnsemble } from './ensemble.js';

interface LegInputs {
  options: AssembleOptions;
  leg: Leg;
  schedule: LegSchedule;
  midpoint: SamplePoint;
  /** this leg's audit sample points, along the leg */
  points: readonly AuditSamplePoint[];
  /** index of the leg's first point in the per-point forecast arrays */
  pointOffset: number;
  index: number;
  gridSampler: GridSampler | null;
  ratio: number;
  scenarioFloor: number;
  evidenceOffset: number;
}

/** Domain evaluators return local accumulators; evidence is emitted in rule order. */
export function assembleLeg({
  options, leg, schedule, midpoint, points, pointOffset, gridSampler, ratio, scenarioFloor, evidenceOffset,
}: LegInputs) {
  const { profile, requestMeta, ensembleMeta, marineMeta } = options;
  const grid = options.currentGrid;
  const model = requestMeta[0]?.model ?? null;
  const run = requestMeta[0]?.cycle ?? null;
  const ensembleModel = ensembleMeta ? `${ensembleMeta.model} ensemble` : null;
  const ensembleRun = ensembleMeta?.cycle ?? null;
  const marineModel = marineMeta ? `marine ${marineMeta.model}` : null;
  const hoursUtc = schedule.occupancy_hours;
  // Each hour reads every sample point the boat can be at in it (auditSampling.ts).
  const candidates = legHourCandidates(points, schedule);
  const hourPoints = hoursUtc.map((h) => (candidates.get(h) ?? []).map((k) => pointOffset + k));
  const pointId = (p: number | null | undefined) => (p === null || p === undefined ? undefined : points[p - pointOffset]?.point_id);
  // Each stage enriches fresh hour objects. This order preserves the serialized
  // field order; each accumulator retains the first hour on equal severity.
  const wind = evaluateWind(
    hoursUtc, hourPoints, options.pointForecasts, leg.bearing_deg_true, profile, ratio,
  );
  // Currents stay one value per leg, at its midpoint (timing and the wind-against-current check alike).
  const current = evaluateCurrents(
    wind.hours, gridSampler, interpolatePosition(leg.from, leg.to, 0.5), leg.bearing_deg_true,
  );
  const sea = evaluateSeaState(current.hours, hourPoints, options.pointMarine ?? null, wind.pointWinds, profile, ratio);
  const hazards = evaluateHazards(sea.hours, hourPoints, wind.pointWinds, options.multiModel, model, profile);
  const ensemble = evaluateEnsemble(
    hazards.hours, hourPoints, wind.pointWinds, wind.sustainedLimits, options.pointEnsembles ?? null, profile, scenarioFloor,
  );
  if (points.length > 1) attachExpected(ensemble.hours, options, leg, schedule, points, pointOffset, ratio);
  const { worstSustained, worstGust, exceededWindows } = wind;
  const { worstWac } = current;
  const { worstWave, worstSteepness, crossSeaHour, windAgainstSwellHour } = sea;
  const { worstVisibility, maxCape, disagreementInput } = hazards;
  const { hours, worstEnsembleGust, worstEnsembleSustained, scenarioFractionAboveFloor } = ensemble;
  const anyExceeded = wind.anyExceeded || sea.anyExceeded || hazards.anyExceeded;
  let anyApproaching = wind.anyApproaching || sea.anyApproaching || hazards.anyApproaching;
  let insufficientConfidence = false;
  const { evidence, nextEvidence } = createEvidenceCollector(evidenceOffset);
  const events: FindingsEvent[] = [];
  const legWindow = occupancyWindowClamp(schedule, options.departureUtc);
  const verdictCandidates: Array<{ evidence: Evidence; ratio: number }> = [];

  if (worstSustained) {
    const e = nextEvidence({
      rule_id: RULES.SUSTAINED,
      model,
      run,
      leg_id: leg.leg_id,
      valid_time: worstSustained.hour.valid_time,
      value: worstSustained.hour.wind_kt,
      limit: worstSustained.limit,
      units: 'kt',
      source_kind: 'deterministic',
      ...samplePoint(pointId(wind.drivers[worstSustained.index]?.sustained)),
    });
    verdictCandidates.push({ evidence: e, ratio: worstSustained.ratio });
  }
  if (worstGust) {
    const e = nextEvidence({
      rule_id: RULES.GUST,
      model,
      run,
      leg_id: leg.leg_id,
      valid_time: worstGust.hour.valid_time,
      value: worstGust.hour.gust_kt,
      limit: profile.max_gust_kt,
      units: 'kt',
      source_kind: 'deterministic',
      ...samplePoint(pointId(wind.drivers[worstGust.index]?.gust)),
    });
    verdictCandidates.push({ evidence: e, ratio: worstGust.ratio });
  }
  if (worstEnsembleGust && worstEnsembleGust.count.exceed > 0) {
    const e = nextEvidence({
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
    });
    verdictCandidates.push({
      evidence: e,
      ratio: fraction(worstEnsembleGust.count) / scenarioFloor,
    });
  }
  if (worstEnsembleSustained && worstEnsembleSustained.count.exceed > 0) {
    const e = nextEvidence({
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
    });
    verdictCandidates.push({
      evidence: e,
      ratio: fraction(worstEnsembleSustained.count) / scenarioFloor,
    });
  }
  // ---- wind-against-current (steep breaking seas; Alderney Race effect) ----
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
      window: legWindow(worstWac.hour.valid_time, worstWac.hour.valid_time),
      refs: [e.evidence_id],
    });
    anyApproaching = true; // steep breaking seas deserve at least a look
  }

  // ---- hazard evidence ----
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
      ...samplePoint(pointId(sea.drivers[worstWave.index]?.wave)),
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
      ...samplePoint(pointId(sea.drivers[worstSteepness.index]?.steepness)),
    });
    verdictCandidates.push({ evidence: e, ratio: worstSteepness.ratio });
  }
  if (crossSeaHour) {
    const { hour } = crossSeaHour;
    const e = nextEvidence({
      rule_id: RULES.CROSS_SEA,
      model: marineModel,
      run: null,
      leg_id: leg.leg_id,
      valid_time: hour.valid_time,
      value: hour.waves?.cross_sea_deg ?? null,
      limit: CROSS_SEA_ANGLE_DEG,
      units: 'deg',
      source_kind: 'deterministic',
      ...samplePoint(pointId(sea.drivers[crossSeaHour.index]?.crossSea ?? sea.drivers[crossSeaHour.index]?.wave)),
    });
    events.push({
      kind: 'cross_sea',
      leg_id: leg.leg_id,
      window: legWindow(hour.valid_time, hour.valid_time),
      refs: [e.evidence_id],
    });
  }
  if (windAgainstSwellHour) {
    const { hour } = windAgainstSwellHour;
    const e = nextEvidence({
      rule_id: RULES.WIND_AGAINST_SWELL,
      model: marineModel,
      run: null,
      leg_id: leg.leg_id,
      valid_time: hour.valid_time,
      value: hour.waves?.swell_h_m ?? null,
      limit: null,
      units: 'm',
      source_kind: 'deterministic',
      ...samplePoint(pointId(sea.drivers[windAgainstSwellHour.index]?.windAgainstSwell)),
    });
    events.push({
      kind: 'wind_against_swell',
      leg_id: leg.leg_id,
      window: legWindow(hour.valid_time, hour.valid_time),
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
      limit: maxCape.level === 'high' ? CAPE_HIGH_JKG : CAPE_ELEVATED_JKG,
      units: 'J/kg',
      source_kind: 'deterministic',
      ...samplePoint(pointId(hazards.drivers[maxCape.index]?.cape)),
    });
    events.push({
      kind: 'squall_potential',
      leg_id: leg.leg_id,
      window: legWindow(maxCape.hour.valid_time, maxCape.hour.valid_time),
      refs: [e.evidence_id],
    });
  }
  if (worstVisibility) {
    nextEvidence({
      rule_id: RULES.VISIBILITY,
      model: VIS_MODELS.join('/'),
      run,
      leg_id: leg.leg_id,
      valid_time: worstVisibility.hour.valid_time,
      value: worstVisibility.hour.visibility_nm ?? null,
      limit: profile.min_visibility_nm ?? null,
      units: 'nm (minimum)',
      source_kind: 'deterministic',
      ...samplePoint(pointId(hazards.drivers[worstVisibility.index]?.visibility)),
    });
  }

  // ---- model disagreement ----
  let divergentHours: LegFinding['divergent_hours'];
  if (disagreementInput.length > 0) {
    const result = assessDisagreement(disagreementInput);
    if (result.divergent_hours.length > 0) {
      divergentHours = result.divergent_hours;
      // The evidence shows the widest divergence among the hours where the models split near the
      // limit (what makes the verdict insufficient), or among all divergent hours when none does.
      const rowOf = (validTime: string) => hours.findIndex((h) => h.valid_time === validTime);
      const nearLimit = result.divergent_hours.filter((h) => hazards.drivers[rowOf(h.valid_time)]?.divergenceNearLimit);
      const worstDivergence = (nearLimit.length ? nearLimit : result.divergent_hours).reduce((a, b) =>
        b.spread_kt > a.spread_kt ? b : a,
      );
      const divergenceRow = rowOf(worstDivergence.valid_time);
      // Each model's own run at that hour, not the primary GFS cycle for all of them.
      const compared = Object.keys(worstDivergence.values);
      const modelRuns = compared.map((m) => modelRunAt(options.multiModel?.meta ?? [], m, worstDivergence.valid_time));
      const recordedRuns = modelRuns.some((r) => r.run_id !== null);
      const e = nextEvidence({
        rule_id: RULES.DIVERGENCE,
        model: compared.join(','),
        run: recordedRuns && modelRuns.every((r) => r.cycle !== null) ? modelRuns.map((r) => r.cycle).join(',') : run,
        leg_id: leg.leg_id,
        valid_time: worstDivergence.valid_time,
        value: worstDivergence.values,
        limit: null,
        units: 'kt spread',
        source_kind: 'deterministic',
        ...(recordedRuns ? { model_runs: modelRuns } : {}),
        ...samplePoint(pointId(hazards.drivers[divergenceRow]?.divergence)),
      });
      events.push({
        kind: 'model_divergence',
        leg_id: leg.leg_id,
        window: legWindow(
          result.divergent_hours[0]!.valid_time,
          result.divergent_hours[result.divergent_hours.length - 1]!.valid_time,
        ),
        refs: [e.evidence_id],
      });
    }
    if (result.insufficient) insufficientConfidence = true;
  }

  if (exceededWindows.length > 0) {
    events.push({
      kind: 'limit_exceeded',
      leg_id: leg.leg_id,
      window: legWindow(exceededWindows[0]!, exceededWindows[exceededWindows.length - 1]!),
      refs: evidence.filter((e) => e.leg_id === leg.leg_id).map((e) => e.evidence_id),
    });
  }

  const finding: LegFinding = {
    leg_id: leg.leg_id,
    name: `${leg.from.name ?? leg.from.id} → ${leg.to.name ?? leg.to.id}`,
    distance_nm: leg.distance_nm,
    bearing_deg_true: leg.bearing_deg_true,
    eta_range: { slow: schedule.exit.slow, nominal: schedule.exit.nominal, fast: schedule.exit.fast },
    enter_range: { slow: schedule.enter.slow, nominal: schedule.enter.nominal, fast: schedule.enter.fast },
    sog_kt: schedule.sog_kt,
    hours,
    sample_point: { lat: midpoint.lat, lon: midpoint.lon },
    sample_points: points.map((p) => ({
      point_id: p.point_id, lat: p.lat, lon: p.lon,
      from_nm: round2(leg.distance_nm * p.from_fraction), to_nm: round2(leg.distance_nm * p.to_fraction),
    })),
    ...(divergentHours ? { divergent_hours: divergentHours } : {}),
  };
  return {
    finding, evidence, events, verdictCandidates,
    anyExceeded, anyApproaching, scenarioFractionAboveFloor, insufficientConfidence,
  };
}

/** The evidence field naming the sample point a value was read at, when there is one. */
function samplePoint(id: string | undefined): { sample_point_id?: string } {
  return id ? { sample_point_id: id } : {};
}

/**
 * The reading at the boat's expected position, for a leg read at more than
 * one point: each hour row gets `expected`, the values at the one sample point
 * the boat is in on the nominal timing at that hour (clamped to the leg;
 * auditSampling.expectedPointIndex), judged as the rows are. Whatever reads the
 * expected timing (the route summary, the expected hours over a limit, the
 * route timeline) uses it, so it does not take the worst of the stretch the
 * boat can be in. The verdict, evidence and arrival-range figures never read
 * it.
 */
function attachExpected(
  rows: LegHour[], options: AssembleOptions, leg: Leg, schedule: LegSchedule,
  points: readonly AuditSamplePoint[], pointOffset: number, ratio: number,
): void {
  const nominal = { enterMs: parseUtc(schedule.enter.nominal), exitMs: parseUtc(schedule.exit.nominal) };
  const at = rows.map((row) => expectedPointIndex(points.length, nominal, parseUtc(row.valid_time)));
  const hourPoints = at.map((k) => [pointOffset + k]);
  const hoursUtc = rows.map((row) => row.valid_time);
  const { profile } = options;
  const wind = evaluateWind(hoursUtc, hourPoints, options.pointForecasts, leg.bearing_deg_true, profile, ratio);
  const sea = evaluateSeaState(wind.hours, hourPoints, options.pointMarine ?? null, wind.pointWinds, profile, ratio);
  const model = options.requestMeta[0]?.model ?? null;
  const hazards = evaluateHazards(sea.hours, hourPoints, wind.pointWinds, options.multiModel, model, profile);
  rows.forEach((row, i) => {
    const e = hazards.hours[i]!;
    row.expected = {
      sample_point_id: points[at[i]!]!.point_id,
      wind_kt: e.wind_kt,
      gust_kt: e.gust_kt,
      wind_dir_deg: e.wind_dir_deg,
      twa_deg: e.twa_deg,
      point_of_sail: e.point_of_sail,
      limit_status: e.limit_status,
      ...(e.waves !== undefined ? { waves: e.waves } : {}),
    };
  });
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Occupancy hours are whole UTC hours (floor(enter.fast) .. ceil(exit.slow)), so a
 * grid hour can precede the leg (or the departure) by up to 59 minutes, or follow
 * its slow exit. Event windows describe when the boat meets the condition, so
 * they are clamped to [max(enter.fast, departure), exit.slow]. Evidence keeps the
 * forecast sample time it was read from (`valid_time`).
 */
export function occupancyWindowClamp(schedule: LegSchedule, departureUtc: string) {
  const start = Math.max(parseUtc(schedule.enter.fast), parseUtc(departureUtc));
  const end = Math.max(start, parseUtc(schedule.exit.slow));
  const clamp = (iso: string) => toIso(Math.min(end, Math.max(start, parseUtc(iso))));
  return (from: string, to: string) => ({ from: clamp(from), to: clamp(to) });
}
