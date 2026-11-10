/**
 * One governing reason for the verdict, as structured data (no prose, no
 * formatted times). The viewer turns it into ONE verdict sentence, so the
 * header chip, sentence and headline stop quoting unrelated numbers from
 * different legs, hours and statistics.
 *
 * Read-only over saved findings (old snapshots included); the verdict itself
 * is never recomputed: `state` is `findings.verdict.state`.
 *
 * Selection rules (documented, tested):
 * - exceeds: `earliest_exceedance`. Among limit results whose deterministic
 *   value crosses the limit, the one whose (clamped) window starts first:
 *   the first limit the boat meets beyond its declared value. Ties: the larger
 *   scenario share at the statistic's hour, then the larger value/limit ratio,
 *   then evidence order.
 * - approaching: `closest_margin`, the largest deterministic value/limit ratio
 *   (visibility inverted). When no deterministic value approaches a limit,
 *   `largest_scenario_share` among scenario-only exceedances. When neither
 *   exists (approaching from wind against current or a tidal gate), `result`
 *   is null and `other` names that cause.
 * - within: `closest_margin` over every occupied hour. Findings store no limits
 *   for hours without evidence, so this needs the profile the check used
 *   (verified against findings.inputs.profile_hash). Without it, a scenario-only
 *   result (some members beyond a limit, below the floor) if any, else null.
 * - warning_active and insufficient: the warning or the disagreement, PLUS the
 *   strongest limit result by the first applicable rule above.
 */

import { parseUtc, toIso } from './eta.js';
import { contentHash } from './hash.js';
import { evidenceLimitRatio } from './findings/evidence.js';
import { RULES } from './findings/rules.js';
import { modelRunAt, type ModelRunRef } from './forecast/modelRuns.js';
import { sustainedLimitKt } from './limits.js';
import { modelDisplayName } from './nextRun.js';
import type { Evidence, Findings, LegFinding, LegHour, LimitsProfile, VerdictState } from './types.js';

export type LimitKind = 'wind' | 'gust' | 'wave' | 'steepness' | 'visibility';

export interface GoverningLeg {
  leg_id: string;
  /** 0-based position in findings.legs */
  index: number;
  /** full leg name, "From → To" */
  name: string;
  /** destination before its first comma, as the route labels use it ("near <place>"); raw, apply placeLabel */
  place: string;
}

export interface LimitResult {
  /** which documented rule chose this result */
  selection: 'earliest_exceedance' | 'closest_margin' | 'largest_scenario_share';
  /** exceeded/approaching: deterministic value vs limit; scenarios: only scenario members exceed; within: margin */
  status: 'exceeded' | 'approaching' | 'scenarios' | 'within';
  /** the user's declared limit; `bound: 'min'` for visibility (a minimum), else a maximum */
  limit: { kind: LimitKind; value: number; unit: 'kt' | 'm' | 'H/L' | 'nm'; bound: 'max' | 'min' };
  statistic: {
    value: number;
    /** limit unit, or 'fraction' (0-1) for scenario_share */
    unit: 'kt' | 'm' | 'H/L' | 'nm' | 'fraction';
    /**
     * deterministic_hourly_max: highest hourly value of one deterministic model over the leg's
     * occupied forecast hours (deterministic_hourly_min for visibility); scenario_share: share of
     * ensemble members beyond the limit at their worst hour on the leg.
     */
    statistic: 'deterministic_hourly_max' | 'deterministic_hourly_min' | 'scenario_share';
    model: string | null;
    model_name: string | null;
    run: string | null;
    /** forecast grid hour the value was read at (UTC); may sit up to 59 min outside `window` */
    valid_time: string;
  };
  /** statistic / limit (limit / statistic for visibility); >1 is beyond the limit; null for scenario_share */
  ratio: number | null;
  /** ensemble members beyond the same limit at the statistic's hour; null without ensemble data */
  scenarios: {
    exceeding: number;
    total: number;
    valid_time: string;
    model: string | null;
    model_name: string | null;
    run: string | null;
  } | null;
  leg: GoverningLeg;
  /** when the boat meets it: first..last matching hour, clamped to [max(leg entry, departure), slow leg exit] */
  window: { from: string; to: string };
  /** the evidence claim this rests on; null for a `within` margin (no claim is emitted) */
  evidence_id: string | null;
}

export interface GoverningWarning {
  evidence_id: string;
  /** bulletin type, e.g. "BMS-large" */
  kind: string;
  /** zone name as recorded, e.g. "Casquets" */
  area: string;
  zone_ids: string[];
  /** feed/issuer name, e.g. "Météo-France BMS" */
  issuer: string;
  /** when the warnings feed was read (bulletin_ref.issued_at records the feed fetch time) */
  feed_fetched_at: string;
  valid_from: string;
  valid_to: string;
  /** active warnings on the route (this one is the verdict's bulletin_ref) */
  active_count: number;
}

export interface GoverningDisagreement {
  evidence_id: string;
  leg: GoverningLeg;
  /** forecast grid hour of the compared values (UTC) */
  valid_time: string;
  /** divergence window on that leg, clamped like LimitResult.window */
  window: { from: string; to: string };
  models: Array<ModelRunRef & { model_name: string; value_kt: number }>;
  spread_kt: number;
  /** newest minus oldest compared cycle, hours; absent when all runs share one init time or are unknown */
  run_age_gap_hours?: number;
}

export interface GoverningOther {
  kind: 'gate_conflict' | 'gate_marginal' | 'wind_against_current';
  leg: GoverningLeg;
  window: { from: string; to: string };
  evidence_id: string | null;
}

export interface GoverningReason {
  state: VerdictState;
  /** the limit result the state rests on; for warning_active/insufficient the strongest one alongside */
  result: LimitResult | null;
  warning: GoverningWarning | null;
  disagreement: GoverningDisagreement | null;
  /** approaching without a limit result */
  other: GoverningOther | null;
  /** findings.verdict.driver_evidence_id, for cross-reference (it ranks by a different, ratio-only rule) */
  verdict_driver_evidence_id: string | null;
}

const KINDS: Array<{
  kind: LimitKind; status: keyof LegHour['limit_status']; det: string; ens?: string;
  unit: 'kt' | 'm' | 'H/L' | 'nm';
}> = [
  { kind: 'wind', status: 'sustained', det: RULES.SUSTAINED, ens: RULES.SUSTAINED_ENSEMBLE, unit: 'kt' },
  { kind: 'gust', status: 'gust', det: RULES.GUST, ens: RULES.GUST_ENSEMBLE, unit: 'kt' },
  { kind: 'wave', status: 'wave', det: RULES.WAVE_HEIGHT, unit: 'm' },
  { kind: 'steepness', status: 'steepness', det: RULES.STEEPNESS, unit: 'H/L' },
  { kind: 'visibility', status: 'visibility', det: RULES.VISIBILITY, unit: 'nm' },
];

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** "gfs_0p25 ensemble" → GEFS-style display names; strips the engine's marine/ensemble decorations. */
function displayModel(model: string | null): string | null {
  if (!model) return null;
  const base = model.replace(/^marine /, '').replace(/ ensemble$/, '');
  return modelDisplayName(base);
}

function legRef(findings: Findings, leg: LegFinding): GoverningLeg {
  const destination = leg.name.split('→')[1]?.trim().split(',')[0] ?? leg.name.slice(0, 24);
  return { leg_id: leg.leg_id, index: findings.legs.indexOf(leg), name: leg.name, place: destination };
}

/** Clamp grid hours to when the boat is on the leg (same rule as findings event windows). */
function legWindow(findings: Findings, leg: LegFinding, from: string, to: string): { from: string; to: string } {
  const start = Math.max(parseUtc(leg.enter_range.fast), parseUtc(findings.departure_utc));
  const end = Math.max(start, parseUtc(leg.eta_range.slow));
  const clamp = (iso: string) => toIso(Math.min(end, Math.max(start, parseUtc(iso))));
  return { from: clamp(from), to: clamp(to) };
}

function hoursWindow(findings: Findings, leg: LegFinding, match: (hour: LegHour) => boolean, fallback: string) {
  const hits = leg.hours.filter(match);
  return legWindow(findings, leg, hits[0]?.valid_time ?? fallback, hits[hits.length - 1]?.valid_time ?? fallback);
}

function ensembleRun(findings: Findings, evidence?: Evidence) {
  const meta = findings.inputs.forecast_tiles.find((m) => m.layer === 'ensemble');
  const model = evidence?.model ?? (typeof meta?.model === 'string' ? `${meta.model} ensemble` : null);
  const run = evidence?.run ?? (typeof meta?.cycle === 'string' ? meta.cycle : null);
  return { model, model_name: displayModel(model), run };
}

function scenariosAt(
  findings: Findings, leg: LegFinding, statusKey: 'sustained' | 'gust', validTime: string, evidence?: Evidence,
): LimitResult['scenarios'] {
  const count = leg.hours.find((h) => h.valid_time === validTime)?.exceedance?.[statusKey];
  if (!count) return null;
  return { exceeding: count.exceed, total: count.total, valid_time: validTime, ...ensembleRun(findings, evidence) };
}

/** Every limit result carried by evidence: one per leg and limit kind. */
function limitResults(findings: Findings): LimitResult[] {
  const out: LimitResult[] = [];
  for (const leg of findings.legs) {
    const legEvidence = findings.evidence.filter((e) => e.leg_id === leg.leg_id);
    for (const spec of KINDS) {
      const det = legEvidence.find((e) => e.rule_id === spec.det);
      const ens = spec.ens ? legEvidence.find((e) => e.rule_id === spec.ens) : undefined;
      const statusKey = spec.status as 'sustained' | 'gust';
      const bound = spec.kind === 'visibility' ? 'min' as const : 'max' as const;
      if (det && typeof det.value === 'number' && typeof det.limit === 'number' && det.valid_time) {
        const exceeded = leg.hours.some((h) => h.limit_status[spec.status] === 'exceeded');
        const statuses = exceeded ? ['exceeded'] : ['exceeded', 'approaching'];
        out.push({
          selection: 'closest_margin',
          status: exceeded ? 'exceeded' : 'approaching',
          limit: { kind: spec.kind, value: det.limit, unit: spec.unit, bound },
          statistic: {
            value: det.value, unit: spec.unit,
            statistic: bound === 'min' ? 'deterministic_hourly_min' : 'deterministic_hourly_max',
            model: det.model, model_name: displayModel(det.model), run: det.run, valid_time: det.valid_time,
          },
          ratio: round(evidenceLimitRatio(det) ?? 0, 3),
          scenarios: spec.ens ? scenariosAt(findings, leg, statusKey, det.valid_time, ens) : null,
          leg: legRef(findings, leg),
          window: hoursWindow(findings, leg,
            (h) => statuses.includes(h.limit_status[spec.status] ?? ''), det.valid_time),
          evidence_id: det.evidence_id,
        });
      } else if (ens?.member_fraction && ens.valid_time && typeof ens.limit === 'number') {
        const { exceed, total } = ens.member_fraction;
        out.push({
          selection: 'largest_scenario_share',
          status: 'scenarios',
          limit: { kind: spec.kind, value: ens.limit, unit: spec.unit, bound },
          statistic: {
            value: round(exceed / total, 4), unit: 'fraction', statistic: 'scenario_share',
            model: ens.model, model_name: displayModel(ens.model), run: ens.run, valid_time: ens.valid_time,
          },
          ratio: null,
          scenarios: { exceeding: exceed, total, valid_time: ens.valid_time, ...ensembleRun(findings, ens) },
          leg: legRef(findings, leg),
          window: hoursWindow(findings, leg, (h) => (h.exceedance?.[statusKey]?.exceed ?? 0) > 0, ens.valid_time),
          evidence_id: ens.evidence_id,
        });
      }
    }
  }
  return out;
}

const share = (r: LimitResult) => (r.scenarios ? r.scenarios.exceeding / r.scenarios.total : -1);

function earliestExceedance(results: LimitResult[]): LimitResult | null {
  const exceeded = results.filter((r) => r.status === 'exceeded');
  exceeded.sort((a, b) =>
    parseUtc(a.window.from) - parseUtc(b.window.from) ||
    share(b) - share(a) ||
    (b.ratio ?? 0) - (a.ratio ?? 0));
  return exceeded[0] ? { ...exceeded[0], selection: 'earliest_exceedance' } : null;
}

function closestMargin(results: LimitResult[]): LimitResult | null {
  const approaching = results.filter((r) => r.status === 'approaching');
  if (approaching.length) {
    const best = approaching.reduce((a, b) => ((b.ratio ?? 0) > (a.ratio ?? 0) ? b : a));
    return { ...best, selection: 'closest_margin' };
  }
  const scenarios = results.filter((r) => r.status === 'scenarios');
  if (!scenarios.length) return null;
  const best = scenarios.reduce((a, b) => (b.statistic.value > a.statistic.value ? b : a));
  return { ...best, selection: 'largest_scenario_share' };
}

/** within: the smallest margin over all occupied hours, from the profile the check used. */
function withinMargin(findings: Findings, profile: LimitsProfile | undefined): LimitResult | null {
  if (!profile || contentHash(profile) !== findings.inputs.profile_hash) return null;
  const weather = findings.inputs.forecast_tiles.find((m) => m.layer === 'weather');
  const waves = findings.inputs.forecast_tiles.find((m) => m.layer === 'waves');
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  let best: LimitResult | null = null;
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      const candidates: Array<{ spec: typeof KINDS[number]; value: number | null | undefined; limit: number | null | undefined }> = [
        { spec: KINDS[0]!, value: hour.wind_kt, limit: sustainedLimitKt(profile, hour.point_of_sail ?? 'reach') },
        { spec: KINDS[1]!, value: hour.gust_kt, limit: profile.max_gust_kt },
        { spec: KINDS[2]!, value: hour.waves?.hs_m, limit: profile.max_wave_height_m },
        { spec: KINDS[3]!, value: hour.waves?.steepness, limit: profile.max_steepness },
        { spec: KINDS[4]!, value: hour.visibility_nm, limit: profile.min_visibility_nm },
      ];
      if (hour.point_of_sail === null) candidates[0]!.limit = profile.max_sustained_kt.default;
      for (const { spec, value, limit } of candidates) {
        if (typeof value !== 'number' || typeof limit !== 'number' || limit <= 0 || value <= 0) continue;
        const ratio = spec.kind === 'visibility' ? limit / value : value / limit;
        if (best && ratio <= (best.ratio ?? 0)) continue;
        const meta = spec.kind === 'wave' || spec.kind === 'steepness' ? waves : weather;
        const model = str(meta?.model);
        best = {
          selection: 'closest_margin',
          status: 'within',
          limit: { kind: spec.kind, value: limit, unit: spec.unit, bound: spec.kind === 'visibility' ? 'min' : 'max' },
          statistic: {
            value, unit: spec.unit, statistic: spec.kind === 'visibility' ? 'deterministic_hourly_min' : 'deterministic_hourly_max',
            model, model_name: displayModel(model), run: str(meta?.cycle), valid_time: hour.valid_time,
          },
          ratio: round(ratio, 3),
          scenarios: spec.kind === 'wind' || spec.kind === 'gust'
            ? scenariosAt(findings, leg, spec.status as 'sustained' | 'gust', hour.valid_time)
            : null,
          leg: legRef(findings, leg),
          window: legWindow(findings, leg, hour.valid_time, hour.valid_time),
          evidence_id: null,
        };
      }
    }
  }
  return best;
}

function strongest(findings: Findings, results: LimitResult[], profile?: LimitsProfile): LimitResult | null {
  return earliestExceedance(results) ?? closestMargin(results) ?? withinMargin(findings, profile);
}

function governingWarning(findings: Findings): GoverningWarning | null {
  const warnings = findings.evidence.filter((e) => e.rule_id === RULES.AUTHORITY && e.bulletin_ref);
  if (!warnings.length) return null;
  const ref = findings.verdict.warning_override.bulletin_ref;
  const keyOf = (e: Evidence) => {
    const kind = String(e.value).split(': ')[0];
    return `${e.bulletin_ref!.zone_ids[0]}:${kind}:${e.bulletin_ref!.valid_from}`;
  };
  const chosen = warnings.find((e) => keyOf(e) === ref) ?? warnings[0]!;
  const text = String(chosen.value);
  const split = text.indexOf(': ');
  return {
    evidence_id: chosen.evidence_id,
    kind: split >= 0 ? text.slice(0, split) : text,
    area: split >= 0 ? text.slice(split + 2) : chosen.bulletin_ref!.zone_ids.join(' / '),
    zone_ids: chosen.bulletin_ref!.zone_ids,
    issuer: chosen.bulletin_ref!.source,
    feed_fetched_at: chosen.bulletin_ref!.issued_at,
    valid_from: chosen.bulletin_ref!.valid_from,
    valid_to: chosen.bulletin_ref!.valid_to,
    active_count: warnings.length,
  };
}

/**
 * The disagreement that matters most to the limits: the divergence claim whose
 * strongest model is highest (insufficient means a divergent model nears the
 * limit), then the larger spread, then evidence order.
 */
function governingDisagreement(findings: Findings): GoverningDisagreement | null {
  const claims = findings.evidence.filter((e) =>
    e.rule_id === RULES.DIVERGENCE && e.valid_time && e.leg_id && e.value && typeof e.value === 'object');
  const values = (e: Evidence) => Object.values(e.value as Record<string, number>).filter(Number.isFinite);
  const spreadOf = (e: Evidence) => Math.max(...values(e)) - Math.min(...values(e));
  const best = claims.filter((e) => values(e).length >= 2).reduce<Evidence | null>((a, b) => {
    if (!a) return b;
    const d = Math.max(...values(b)) - Math.max(...values(a)) || spreadOf(b) - spreadOf(a);
    return d > 0 ? b : a;
  }, null);
  if (!best) return null;
  const leg = findings.legs.find((l) => l.leg_id === best.leg_id);
  if (!leg) return null;
  const byModel = best.value as Record<string, number>;
  const runs = best.model_runs ?? Object.keys(byModel)
    .map((model) => modelRunAt(findings.inputs.forecast_tiles, model, best.valid_time!));
  const models = Object.entries(byModel).map(([model, value]) => ({
    ...(runs.find((r) => r.model === model) ?? { model, layer: null, run_id: null, cycle: null }),
    model_name: modelDisplayName(model),
    value_kt: value,
  }));
  const cycles = [...new Set(models.flatMap((m) => {
    if (!m.cycle) return [];
    const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(m.cycle) ? m.cycle : `${m.cycle}Z`);
    return Number.isFinite(ms) ? [ms] : [];
  }))];
  const event = findings.events.find((e) => e.kind === 'model_divergence' && e.leg_id === leg.leg_id && e.window);
  const gap = cycles.length >= 2 ? round((Math.max(...cycles) - Math.min(...cycles)) / 3_600_000, 1) : 0;
  return {
    evidence_id: best.evidence_id,
    leg: legRef(findings, leg),
    valid_time: best.valid_time!,
    window: legWindow(findings, leg, event?.window?.from ?? best.valid_time!, event?.window?.to ?? best.valid_time!),
    models,
    spread_kt: round(spreadOf(best), 1),
    ...(gap > 0 ? { run_age_gap_hours: gap } : {}),
  };
}

function governingOther(findings: Findings): GoverningOther | null {
  for (const kind of ['gate_conflict', 'gate_marginal', 'wind_against_current'] as const) {
    const events = findings.events
      .filter((e) => e.kind === kind && e.leg_id && e.window)
      .sort((a, b) => parseUtc(a.window!.from) - parseUtc(b.window!.from));
    const event = events[0];
    const leg = event && findings.legs.find((l) => l.leg_id === event.leg_id);
    if (event && leg) {
      return {
        kind, leg: legRef(findings, leg),
        window: legWindow(findings, leg, event.window!.from, event.window!.to),
        evidence_id: event.refs[0] ?? null,
      };
    }
  }
  return null;
}

/**
 * The one reason behind `findings.verdict.state`. Pass the limits profile the
 * check used to get a `within` margin; it is ignored unless its content hash
 * matches findings.inputs.profile_hash.
 */
export function governingReason(findings: Findings, options: { profile?: LimitsProfile } = {}): GoverningReason {
  const state = findings.verdict.state;
  const results = limitResults(findings);
  const base: GoverningReason = {
    state, result: null, warning: null, disagreement: null, other: null,
    verdict_driver_evidence_id: findings.verdict.driver_evidence_id,
  };
  switch (state) {
    case 'warning_active':
      return { ...base, warning: governingWarning(findings), result: strongest(findings, results, options.profile) };
    case 'insufficient':
      return { ...base, disagreement: governingDisagreement(findings), result: strongest(findings, results, options.profile) };
    case 'exceeds':
      return { ...base, result: earliestExceedance(results) ?? closestMargin(results) };
    case 'approaching': {
      const result = closestMargin(results);
      return { ...base, result, other: result ? null : governingOther(findings) };
    }
    default:
      return { ...base, result: withinMargin(findings, options.profile) ?? closestMargin(results) };
  }
}
