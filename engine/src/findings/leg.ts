import { assessDisagreement } from '../disagreement.js';
import { fraction } from '../exceedance.js';
import { interpolatePosition } from '../geo.js';
import type { GridSampler } from '../grids.js';
import { CAPE_HIGH_JKG, CAPE_ELEVATED_JKG } from '../hazards/convective.js';
import { CROSS_SEA_ANGLE_DEG } from '../hazards/waves.js';
import type { LegSchedule } from '../eta.js';
import type { Evidence, FindingsEvent, Leg, LegFinding, SamplePoint } from '../types.js';
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
  index: number;
  gridSampler: GridSampler | null;
  ratio: number;
  scenarioFloor: number;
  evidenceOffset: number;
}

/** Domain evaluators return local accumulators; evidence is emitted in rule order. */
export function assembleLeg({
  options, leg, schedule, midpoint, index: i, gridSampler, ratio, scenarioFloor, evidenceOffset,
}: LegInputs) {
  const { profile, requestMeta, ensembleMeta, marineMeta } = options;
  const grid = options.currentGrid;
  const model = requestMeta[0]?.model ?? null;
  const run = requestMeta[0]?.cycle ?? null;
  const ensembleModel = ensembleMeta ? `${ensembleMeta.model} ensemble` : null;
  const ensembleRun = ensembleMeta?.cycle ?? null;
  const marineModel = marineMeta ? `marine ${marineMeta.model}` : null;
  // Each stage enriches fresh hour objects. This order preserves the serialized
  // field order; each accumulator retains the first hour on equal severity.
  const wind = evaluateWind(
    schedule.occupancy_hours, options.legForecasts[i]!, leg.bearing_deg_true, profile, ratio,
  );
  const current = evaluateCurrents(
    wind.hours, gridSampler, interpolatePosition(leg.from, leg.to, 0.5), leg.bearing_deg_true,
  );
  const sea = evaluateSeaState(current.hours, options.legMarine?.[i] ?? null, profile, ratio);
  const hazards = evaluateHazards(sea.hours, wind.sustainedLimits, options.multiModel, i, model, profile);
  const ensemble = evaluateEnsemble(
    hazards.hours, wind.sustainedLimits, options.legEnsembles?.[i] ?? null, profile, scenarioFloor,
  );
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
      window: { from: worstWac.hour.valid_time, to: worstWac.hour.valid_time },
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
      limit: CROSS_SEA_ANGLE_DEG,
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
      limit: maxCape.level === 'high' ? CAPE_HIGH_JKG : CAPE_ELEVATED_JKG,
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
      model: VIS_MODELS.join('/'),
      run,
      leg_id: leg.leg_id,
      valid_time: worstVisibility.hour.valid_time,
      value: worstVisibility.hour.visibility_nm ?? null,
      limit: profile.min_visibility_nm ?? null,
      units: 'nm (minimum)',
      source_kind: 'deterministic',
    });
  }

  // ---- model disagreement ----
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
    ...(divergentHours ? { divergent_hours: divergentHours } : {}),
  };
  return {
    finding, evidence, events, verdictCandidates,
    anyExceeded, anyApproaching, scenarioFractionAboveFloor, insufficientConfidence,
  };
}
