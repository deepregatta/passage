/**
 * Two-register briefing renderer (brief §8): plain language anyone can act on,
 * plus the professional reasoning; generated from the SAME facts (findings JSON).
 * Bounded vocabulary, every sentence traceable via evidence_ids. This seam is
 * where an optional LLM writer could later swap in; all numbers stay deterministic.
 *
 * Wording rules (safety-critical, brief §6/§7):
 *  - never "GO", never "probability"/"confidence %" for raw scenario fractions
 *  - scenario fractions phrased as "N of M forecast scenarios exceed ..."
 *  - an active official warning always renders first and overrides the summary
 */

import { fraction, phraseExceedance } from './exceedance.js';
import { plainValueVsLimit } from './plainLanguage.js';
import type { Evidence, Findings, SynopticFeatures } from './types.js';

export interface BriefingSection {
  id:
    | 'warnings'
    | 'synoptic_story'
    | 'route_impact'
    | 'decision'
    | 'what_could_change'
    | 'unsupported'
    | 'emulated_disclosure';
  title: string;
  register_plain: string;
  register_pro: string;
  evidence_ids: string[];
  per_leg?: Array<{ leg_id: string; register_plain: string; register_pro: string; evidence_ids: string[] }>;
  glossary_terms?: string[];
  availability?: { status: 'available' | 'unavailable'; reason?: string };
}

export interface Briefing {
  schema_version: number;
  snapshot_id: string;
  sections: BriefingSection[];
  next_runs: Array<{ model: string; expected_at: string }>;
  next_run?: { model: string; expected_at: string };
}

const VERDICT_LABEL: Record<string, { plain: string; pro: string }> = {
  within: {
    plain: 'Forecast conditions stay inside the limits you declared for this departure.',
    pro: 'All evaluated condition-hours remain below declared thresholds.',
  },
  approaching: {
    plain: 'Forecast conditions come close to the limits you declared. Look at what is driving this before deciding.',
    pro: 'One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor.',
  },
  exceeds: {
    plain: 'Forecast conditions go beyond the limits you declared for this departure.',
    pro: 'At least one condition-hour exceeds a declared threshold in the deterministic run.',
  },
  insufficient: {
    plain: 'The forecasts disagree too much to assess this passage against your limits. Reassess after the next model run.',
    pro: 'Deterministic model divergence exceeds assessment tolerance within the passage window.',
  },
  warning_active: {
    plain: 'An official marine warning covers part of your route. That takes precedence over everything below.',
    pro: 'Authority override active: an official bulletin covers route zones during the passage window.',
  },
};

export function renderBriefing(findings: Findings, synoptic?: SynopticFeatures): Briefing {
  const sections: BriefingSection[] = [];
  const evidenceById = new Map(findings.evidence.map((e) => [e.evidence_id, e]));

  // synoptic story (route-independent facts from the prepared run)
  if (synoptic && synoptic.systems.length > 0) {
    const lows = synoptic.systems.filter((s) => s.kind === 'low').slice(0, 2);
    const highs = synoptic.systems.filter((s) => s.kind === 'high').slice(0, 1);
    const describe = (s: SynopticFeatures['systems'][number]) => {
      const first = s.track[0]!;
      const trend =
        s.deepening_hpa_per_24h == null
          ? ''
          : s.deepening_hpa_per_24h < -1
            ? `, deepening ${Math.abs(Math.round(s.deepening_hpa_per_24h))} hPa/24h`
            : s.deepening_hpa_per_24h > 1
              ? `, filling ${Math.round(s.deepening_hpa_per_24h)} hPa/24h`
              : ', steady';
      const motion = s.motion ? `, moving ${compass(s.motion.dir_deg)} ${Math.round(s.motion.speed_kt)} kt` : '';
      return `${s.system_id} (${Math.round(first.center_hpa)} hPa near ${Math.abs(first.lat).toFixed(0)}°${first.lat >= 0 ? 'N' : 'S'} ${Math.abs(first.lon).toFixed(0)}°${first.lon >= 0 ? 'E' : 'W'})${trend}${motion}`;
    };
    const plainLow = lows[0];
    sections.push({
      id: 'synoptic_story',
      title: 'The weather system driving this',
      register_plain: plainLow
        ? `A ${plainLow.deepening_hpa_per_24h != null && plainLow.deepening_hpa_per_24h < -1 ? 'strengthening ' : ''}low-pressure system sits ${positionPhrase(plainLow.track[0]!)}. It sets the wind pattern over your route. The charts track it over the next few days.`
        : 'High pressure dominates the picture. Expect the pattern to change slowly.',
      register_pro: `Detected systems (${synoptic.run_id}): lows ${lows.map(describe).join('; ') || 'none'}; highs ${highs.map(describe).join('; ') || 'none'}.${synoptic.regimes.length ? ` Named regime active: ${synoptic.regimes.map((r) => r.regime_id).join(', ')}.` : ''} Front-type labels withheld pending corroboration (§4.1).`,
      evidence_ids: [],
      glossary_terms: ['model run'],
      availability: { status: 'available' },
    });
  } else {
    const reason = synoptic
      ? 'the prepared synoptic run contains no tracked systems'
      : 'no prepared synoptic run was supplied';
    sections.push({
      id: 'synoptic_story',
      title: 'The weather system driving this',
      register_plain: `This run has no causal attribution. Reason: ${reason}.`,
      register_pro: `Synoptic availability: unavailable (${reason}). Route conditions and limit checks remain available, but this run does not attribute them to a weather system.`,
      evidence_ids: [],
      glossary_terms: ['model run'],
      availability: { status: 'unavailable', reason },
    });
  }

  // 1. warnings; always first when active (authority state)
  if (findings.verdict.warning_override.active) {
    sections.push({
      id: 'warnings',
      title: 'Official warning active',
      register_plain:
        'The national weather service has an active marine warning for part of your route. Read the official bulletin first.',
      register_pro: `Authority override: bulletin ${findings.verdict.warning_override.bulletin_ref ?? '(ref pending)'} active during the passage window. This state overrides the personal-limit summary and does not assert a numeric limit exceedance.`,
      evidence_ids: findings.evidence
        .filter((e) => e.rule_id === 'A-WARN-01')
        .map((e) => e.evidence_id),
    });
  }

  // 2. route impact, leg by leg
  const perLeg = findings.legs.map((leg) => {
    const legEvidence = findings.evidence.filter((e) => e.leg_id === leg.leg_id);
    const worstDet = pickWorst(legEvidence, 'deterministic');
    const worstEns = pickWorst(legEvidence, 'ensemble');

    const windRange = numericRange(leg.hours.map((h) => h.wind_kt));
    const gustMax = numericMax(leg.hours.map((h) => h.gust_kt));
    const window = `${fmtTime(leg.enter_range.fast)}–${fmtTime(leg.eta_range.slow)}`;

    let plain: string;
    let pro: string;
    if (windRange) {
      const strength = describeWind(windRange.max);
      plain = `${leg.name}: ${strength} while you are on this stretch (${window} UTC).`;
      const sustained = windRange.min === windRange.max ? `${windRange.max}` : `${windRange.min}–${windRange.max}`;
      pro = `${leg.leg_id} ${leg.name} (${leg.distance_nm} nm, ${leg.bearing_deg_true}°T): sustained ${sustained} kt${gustMax !== null ? `, gusts to ${gustMax} kt` : ''} across the ETA window ${window} UTC.`;
    } else {
      plain = `${leg.name}: no forecast data available for this stretch.`;
      pro = `${leg.leg_id}: no forecast samples within the occupancy window.`;
    }
    const hsMax = numericMax(leg.hours.map((h) => h.waves?.hs_m ?? null));
    if (hsMax !== null) {
      const hsMaxExact = Math.max(
        ...leg.hours.map((h) => h.waves?.hs_m ?? 0),
      );
      pro += ` Seas to ${hsMaxExact.toFixed(1)} m significant (deterministic wave model; no wave ensembles exist).`;
      if (leg.hours.some((h) => h.waves?.wind_against_swell)) {
        plain += ' Wind opposes the swell here, making the sea steeper and less comfortable.';
        pro += ' Wind-against-swell flagged.';
      }
    }
    if (leg.divergent_hours && leg.divergent_hours.length > 0) {
      pro += ` Models diverge on ${leg.divergent_hours.length} h of this leg (max spread ${Math.max(...leg.divergent_hours.map((d) => d.spread_kt))} kt); agreement is not proof, divergence says wait for the next run.`;
    }
    if (worstEns?.member_fraction) {
      const phrase = phraseExceedance(
        worstEns.member_fraction,
        `your ${worstEns.rule_id === 'W-GUST-03' ? `${worstEns.limit} kt gust` : `${worstEns.limit} kt wind`} limit`,
      );
      plain += ` ${capitalize(phrase)} around ${fmtTime(worstEns.valid_time!)} UTC.`;
      pro += ` Ensemble (${worstEns.model}): ${phrase} at ${worstEns.valid_time} (raw scenario fraction; not a calibrated probability).`;
    }

    return {
      leg_id: leg.leg_id,
      register_plain: plain,
      register_pro: pro,
      evidence_ids: legEvidence.map((e) => e.evidence_id),
    };
  });

  sections.push({
    id: 'route_impact',
    title: 'Route impact, leg by leg',
    register_plain: 'What the forecast means for each stretch of your passage:',
    register_pro:
      'Per-leg conditions evaluated hourly across each leg\'s ETA occupancy window (slow/nominal/fast scenarios), course-relative.',
    evidence_ids: [],
    per_leg: perLeg,
    glossary_terms: ['gust', 'ensemble', 'ETA window'],
  });

  // 3. decision
  const verdictText = VERDICT_LABEL[findings.verdict.state]!;
  const driver = findings.verdict.driver_evidence_id
    ? evidenceById.get(findings.verdict.driver_evidence_id)
    : undefined;
  let decisionPlain = verdictText.plain;
  let decisionPro = verdictText.pro;
  if (driver && findings.verdict.state !== 'within') {
    const legName = findings.legs.find((l) => l.leg_id === driver.leg_id)?.name ?? driver.leg_id;
    if (driver.member_fraction) {
      decisionPlain += ` The main signal: ${phraseExceedance(driver.member_fraction, `your ${driver.limit} kt limit`)} on ${legName} around ${fmtTime(driver.valid_time!)} UTC.`;
      decisionPro += ` Driver: ${driver.rule_id} on ${driver.leg_id} at ${driver.valid_time}; ${driver.member_fraction.exceed}/${driver.member_fraction.total} members > ${driver.limit} ${driver.units}.`;
    } else if (typeof driver.value === 'number' && typeof driver.limit === 'number') {
      decisionPlain += ` The main signal: ${plainValueVsLimit(driver.rule_id, driver.value, driver.limit, driver.units)} on ${legName} around ${fmtTime(driver.valid_time!)} UTC.`;
      decisionPro += ` Driver: ${driver.rule_id} on ${driver.leg_id} at ${driver.valid_time}; ${driver.value} ${driver.units} vs declared ${driver.limit} ${driver.units}.`;
    }
  }
  // tidal gates shape the decision (M10)
  const gateEvidence = findings.evidence.filter((e) => e.rule_id === 'T-GATE-01');
  for (const gate of findings.gates ?? []) {
    const badge = gate.rule_text.includes('unverified') ? ' (timing rule unverified)' : '';
    if (gate.status === 'conflict') {
      decisionPlain += ` The ${gate.name} gate does not fit this departure: you would reach it ${fmtTime(gate.transit.from)}–${fmtTime(gate.transit.to)} UTC, outside the favorable stream (${gate.rule_text.split('; ')[0]}). Shifting departure may fix this.`;
      decisionPro += ` Gate ${gate.gate_id} on ${gate.leg_id}: transit window entirely outside favorable interval; ${gate.rule_text}${badge}.`;
    } else if (gate.status === 'marginal') {
      decisionPlain += ` The ${gate.name} gate only partly fits: aim for the ${gate.reference_port}-referenced window (${gate.rule_text.split('; ')[0]}).`;
      decisionPro += ` Gate ${gate.gate_id} on ${gate.leg_id}: partial overlap with favorable interval; ${gate.rule_text}${badge}.`;
    } else {
      decisionPro += ` Gate ${gate.gate_id} (${gate.name}) fits: transit inside ${gate.rule_text}${badge}.`;
    }
  }

  sections.push({
    id: 'decision',
    title: 'Against your declared limits',
    register_plain: decisionPlain,
    register_pro: decisionPro,
    evidence_ids: [...(driver ? [driver.evidence_id] : []), ...gateEvidence.map((e) => e.evidence_id)],
  });

  // 4. what could change
  const nextRun = nextEcmwfRun(findings.generated_at ?? findings.departure_utc);
  sections.push({
    id: 'what_could_change',
    title: 'What could change',
    register_plain: `The next model run is expected around ${fmtTime(nextRun.expected_at)} UTC. Check again then, especially if conditions are close to your limits.`,
    register_pro: `Next ${nextRun.model} cycle expected ~${nextRun.expected_at}. Model run ids in this analysis are inferred from publication schedules until the prepared-run pipeline provides authoritative cycles. Agreement between runs is not proof of accuracy.`,
    evidence_ids: [],
    glossary_terms: ['model run'],
  });

  // 5. unsupported hazards; computed from the capability matrix.
  const unassessed = findings.coverage?.filter((item) => item.status === 'not_assessed');
  const unsupported = unassessed?.map((item) => item.detail ?? item.capability.replaceAll('_', ' '))
    ?? findings.unsupported_hazards;
  const partial = findings.coverage?.filter((item) => item.status === 'partially_assessed') ?? [];
  sections.push({
    id: 'unsupported',
    title: 'Not assessed by this analysis',
    register_plain: `This briefing does NOT cover: ${unsupported.join(', ')}.${partial.length ? ` Partly assessed: ${partial.map((item) => item.capability.replaceAll('_', ' ')).join(', ')}.` : ''} No warning here does not mean no risk.`,
    register_pro: `Unassessed hazard classes: ${unsupported.join('; ')}.${partial.length ? ` Partial capability coverage: ${partial.map((item) => `${item.capability} (${item.detail ?? 'limited inputs'})`).join('; ')}.` : ''} Absence of a flag must not be read as absence of risk (brief §5).`,
    evidence_ids: unassessed?.flatMap((item) => item.evidence_ids ?? []) ?? [],
  });

  // 6. emulated-data disclosure; whenever any evidence is emulated
  const emulated = findings.evidence.filter((e) => e.source_kind === 'emulated');
  if (emulated.length > 0) {
    sections.push({
      id: 'emulated_disclosure',
      title: 'Emulated data in this analysis',
      register_plain:
        'Some values in this briefing come from EMULATED (synthetic) data sources, marked with a badge. Do not use them for a real passage decision.',
      register_pro: `Emulated evidence entries: ${emulated.map((e) => e.evidence_id).join(', ')}. Provider modes are recorded in the snapshot inputs.`,
      evidence_ids: emulated.map((e) => e.evidence_id),
    });
  }

  const sectionOrder: BriefingSection['id'][] = [
    'warnings',
    'synoptic_story',
    'route_impact',
    'decision',
    'what_could_change',
    'unsupported',
    'emulated_disclosure',
  ];
  sections.sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id));

  return {
    schema_version: 1,
    snapshot_id: findings.snapshot_id,
    sections,
    next_runs: [nextRun],
    next_run: nextRun,
  };
}

function pickWorst(evidence: Evidence[], kind: Evidence['source_kind']): Evidence | undefined {
  const candidates = evidence.filter((e) => e.source_kind === kind);
  if (kind === 'ensemble') {
    return candidates.sort(
      (a, b) => fraction(b.member_fraction!) - fraction(a.member_fraction!),
    )[0];
  }
  return candidates.sort(
    (a, b) => (b.value as number) / (b.limit as number) - (a.value as number) / (a.limit as number),
  )[0];
}

function describeWind(maxKt: number): string {
  if (maxKt < 11) return 'light winds';
  if (maxKt < 17) return 'moderate winds';
  if (maxKt < 22) return 'fresh winds';
  if (maxKt < 28) return 'strong winds';
  if (maxKt < 34) return 'near-gale winds';
  return 'gale-force winds';
}

function numericRange(values: Array<number | null>): { min: number; max: number } | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!nums.length) return null;
  return { min: Math.round(Math.min(...nums)), max: Math.round(Math.max(...nums)) };
}

function numericMax(values: Array<number | null>): number | null {
  const range = numericRange(values);
  return range ? range.max : null;
}

/** "Sun 12 Jul 18:00"; deterministic UTC formatting, no locale dependence. */
export function fmtTime(iso: string): string {
  const d = new Date(Date.parse(iso));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hh}:${mm}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function compass(deg: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]!;
}

function positionPhrase(p: { lat: number; lon: number }): string {
  const ns = p.lat >= 52 ? 'to the north' : p.lat <= 47 ? 'to the south' : 'at your latitude';
  const ew = p.lon <= -12 ? 'far out in the Atlantic' : p.lon <= -6 ? 'west of the approaches' : 'near your waters';
  return `${ew}, ${ns}`;
}

/** Next GFS cycle expected in the tile store (cycle cadence 6 h, ~4.5 h pipeline lag). */
function nextEcmwfRun(afterIso: string): { model: string; expected_at: string } {
  const t = Date.parse(afterIso);
  const HOUR = 3600_000;
  const LAG = 4.5 * HOUR;
  const lastCycle = Math.floor((t - LAG) / (6 * HOUR)) * 6 * HOUR;
  const nextAvailable = lastCycle + 6 * HOUR + LAG;
  return {
    model: 'gfs_0p25',
    expected_at: new Date(nextAvailable).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
