/**
 * Findings assembler: route + schedules + point forecasts + declared limits
 * -> evidence-bearing findings JSON (contracts/findings.schema.json).
 *
 * Every number a user sees must be traceable: evidence entries carry
 * rule id, model, run, leg, hour, value, limit, source kind.
 */

import { computeSchedules, parseUtc } from './eta.js';
import { GridSampler } from './grids.js';
import { contentHash } from './hash.js';
import { assessGates } from './hazards/tides.js';
import { approachingRatio } from './limits.js';
import { deriveLegs, legMidpoints } from './route.js';
import { decideVerdict, worstEvidence } from './verdict.js';
import { assignEventKeys } from './events.js';
import type { Evidence, Findings, FindingsEvent, LegFinding } from './types.js';
import { assembleLeg } from './findings/leg.js';
import { deriveCoverage } from './findings/coverage.js';
import { deriveCausalEvents, deriveOperationalEvents } from './findings/events.js';
import { createEvidenceCollector } from './findings/evidence.js';
import { RULES } from './findings/rules.js';
import type { AssembleOptions } from './findings/options.js';

export { RULES } from './findings/rules.js';
export { evidenceLimitRatio } from './findings/evidence.js';
export type { AssembleOptions } from './findings/options.js';

const DEFAULT_SCENARIO_FLOOR = 0.3;

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
    throw new Error(`Route ${route.route_id} has no speeds_kt. Provide speeds for the slow, nominal and fast scenarios before running the passage audit.`);
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

  const { evidence, nextEvidence } = createEvidenceCollector();
  const events: FindingsEvent[] = [];
  const verdictCandidates: Array<{ evidence: Evidence; ratio: number }> = [];
  let anyExceeded = false;
  let anyApproaching = false;
  let scenarioFractionAboveFloor = false;
  let insufficientConfidence = false;

  const legFindings: LegFinding[] = legs.map((leg, i) => {
    const result = assembleLeg({
      options, leg, schedule: schedules[i]!, midpoint: midpoints[i]!, index: i,
      gridSampler, ratio, scenarioFloor, evidenceOffset: evidence.length,
    });
    evidence.push(...result.evidence);
    events.push(...result.events);
    verdictCandidates.push(...result.verdictCandidates);
    anyExceeded ||= result.anyExceeded;
    anyApproaching ||= result.anyApproaching;
    scenarioFractionAboveFloor ||= result.scenarioFractionAboveFloor;
    insufficientConfidence ||= result.insufficientConfidence;
    return result.finding;
  });

  // ---- tidal gates: transit timing vs favorable windows ----
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

  // ---- official warnings: authority override ----
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
        value: `${bulletin.kind}: ${bulletin.zone_name ?? bulletin.zone_id}`,
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
  if (multiModel) allMeta.push(...multiModel.meta.map((m) => ({ ...m })));
  if (grid) {
    allMeta.push({
      source: 'region-grid',
      layer: 'currents',
      model: grid.source.dataset_id ?? 'cmems',
      run_id: grid.run_id,
      mode: grid.source.mode,
      fetched_at: grid.source.fetched_at ?? grid.generated_at,
      resolution_deg: grid.source.resolution_deg ?? null,
    });
  }
  const inputs = {
    prepared_run_id: options.synoptic?.run_id ?? grid?.run_id ?? null,
    synoptic_run_id: options.synoptic?.run_id ?? null,
    forecast_tiles: allMeta,
    warnings_ref: options.warnings?.ref ?? null,
    route_hash: routeHash,
    profile_hash: profileHash,
  };

  const departureCompact = departureUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const snapshotId = `${departureCompact}_${routeHash.slice(0, 8)}_${contentHash({
    routeHash,
    profileHash,
    departureUtc,
    // exact immutable run ids; two analyses over the same runs share a snapshot id
    digests: [
      ...requestMeta.map((m) => `${m.layer}:${m.run_id}`),
      ...(ensembleMeta ? [`${ensembleMeta.layer}:${ensembleMeta.run_id}`] : []),
      ...(marineMeta ? [`${marineMeta.layer}:${marineMeta.run_id}`] : []),
      ...(multiModel ? multiModel.meta.map((m) => `${m.layer}:${m.run_id}`) : []),
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
    deterministicModelCount: multiModel ? Object.keys(multiModel.byModel).length : 0,
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
