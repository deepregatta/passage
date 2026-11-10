import { useMemo } from 'react';
import { governingReason, modelDisplayName } from '@deepweather/engine';
import { fmtTextTime } from '../../lib/format.js';
import { isScenarioId } from '../../lib/sourceNames.js';
import { useApp } from '../../stores/appStore.js';
import { legLabel } from './routeLabels.jsx';

// The one answer at the top of the result page, built from the engine's
// governingReason. Each sentence is its own text node; French lives in
// FR_PATTERNS (i18n.js, "Verdict sentence" block), so keep both in step.

/**
 * governingReason for the open check. The limits profile the check used is
 * only needed for a `within` margin; the engine ignores a profile whose hash
 * differs from findings.inputs.profile_hash, so the current draft is safe to pass.
 * Old findings the engine cannot read give null (the page falls back to the chip).
 */
export function useGoverningReason(findings) {
  const limits = useApp((s) => s.limits);
  const defaults = useApp((s) => s.profileDefaults);
  return useMemo(() => {
    if (!findings) return null;
    try {
      return governingReason(findings, { profile: limits ?? defaults ?? undefined });
    } catch {
      return null;
    }
  }, [findings, limits, defaults]);
}

/** The ensemble claim the top sentence quotes (same leg, limit kind and hour), for the Evidence headline. */
export function governingClaim(findings, reason) {
  const result = reason?.result;
  if (!findings || !result || !['wind', 'gust'].includes(result.limit.kind)) return null;
  const family = result.limit.kind === 'gust' ? 'W-GUST' : 'W-SUST';
  const claims = findings.evidence.filter((e) => e.source_kind === 'ensemble' && e.member_fraction
    && e.leg_id === result.leg.leg_id && e.rule_id.startsWith(family));
  return claims.find((e) => e.evidence_id === result.evidence_id)
    ?? claims.find((e) => e.valid_time === result.scenarios?.valid_time)
    ?? claims[0] ?? null;
}

const NOUN = { wind: 'wind', gust: 'gust', wave: 'wave height', steepness: 'wave steepness', visibility: 'visibility' };

/** "emulated scenario" for the engine's synthetic runs, else the public model name ("GFS"). */
export function forecastName(model) {
  if (!model) return null;
  if (isScenarioId(model)) return 'emulated scenario';
  return modelDisplayName(String(model).replace(/^marine /, '').replace(/ ensemble$/, ''));
}

const ensembleName = (model) => (!model || isScenarioId(model) ? 'emulated' : forecastName(model));

function amount(value, unit) {
  if (unit === 'H/L') return value.toFixed(3);
  return `${unit === 'kt' ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
}

/** A value next to its limit never rounds onto the limit ("18.3 kt" against 18 kt, not "18 kt"). */
function valueText(value, limit, unit) {
  if (unit === 'kt' && Math.round(value) === limit && value !== limit) return `${value.toFixed(1)} kt`;
  return amount(value, unit);
}

const limitText = (limit) => (limit.unit === 'H/L' ? String(limit.value) : `${limit.value} ${limit.unit}`);

/**
 * The limit result as sentences: which limit, where, when (clamped window start,
 * header zone) and which statistic (one deterministic model's hourly extreme, or
 * a raw scenario count).
 */
export function limitSentences(findings, result) {
  if (!result) return [];
  const where = legLabel(findings, result.leg.leg_id);
  const when = fmtTextTime(result.window.from);
  const noun = NOUN[result.limit.kind] ?? result.limit.kind;
  const min = result.limit.bound === 'min';
  const word = min ? 'minimum' : 'limit';
  const L = limitText(result.limit);
  const { statistic, scenarios } = result;
  const count = scenarios ? `${scenarios.exceeding} of ${scenarios.total} ${ensembleName(scenarios.model)} forecast scenarios` : null;
  if (result.status === 'scenarios') {
    return [`${count ?? 'Some forecast scenarios'} exceed your ${L} ${noun} ${word} ${where} around ${when}.`];
  }
  const model = forecastName(statistic.model);
  const forecast = model ? `the ${model} forecast` : 'the forecast';
  const verb = min ? 'drops to' : 'reaches';
  const V = valueText(statistic.value, result.limit.value, statistic.unit);
  const out = [];
  if (result.status === 'exceeded') out.push(`Your ${L} ${noun} ${word} is ${min ? 'not met' : 'exceeded'} ${where} around ${when}: ${forecast} ${verb} ${V}.`);
  else if (result.status === 'approaching') out.push(`Close to your ${L} ${noun} ${word} ${where} around ${when}: ${forecast} ${verb} ${V}.`);
  else out.push(`Closest to your limits: ${noun} ${where} around ${when}, where ${forecast} ${verb} ${V} against your ${L} ${word}.`);
  if (count && scenarios.exceeding > 0) out.push(`${count[0].toUpperCase()}${count.slice(1)} exceed that limit.`);
  return out;
}

/** Plain name for a recorded bulletin kind ("BMS-large", "gale-warning", "nws-small-craft-advisory"). */
export function warningKindLabel(kind) {
  const k = String(kind ?? '').trim();
  if (/^BMS-large$/i.test(k)) return 'offshore marine bulletin (BMS)';
  if (/^BMS-c[oô]te$/i.test(k)) return 'coastal marine bulletin (BMS)';
  if (/^BMS-/i.test(k)) return 'marine bulletin (BMS)';
  if (k === 'gale-warning') return 'gale warning';
  const words = k.replace(/^(nws|bom|meteoalarm)-/, '').replace(/[-_]+/g, ' ').trim();
  return words || 'marine warning';
}

const runCycle = (cycle) => {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2})/.exec(cycle ?? '');
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[2])} ${months[Number(m[1]) - 1]} ${m[3]}Z`;
};

function modelRun(model) {
  const name = forecastName(model.model) ?? model.model_name;
  const cycle = runCycle(model.cycle);
  return cycle ? `${name} (${cycle} run)` : name;
}

/**
 * The verdict as 1–4 sentences (never invented numbers; empty when the saved
 * check has nothing structured to say, and the chip label stands alone).
 * @param {any} findings
 * @param {any} reason governingReason output
 * @param {{ emulatedWarning?: boolean }} [options]
 * @returns {string[]}
 */
export function verdictSentences(findings, reason, { emulatedWarning = false } = {}) {
  if (!findings || !reason) return [];
  const out = [];
  if (reason.state === 'warning_active' && reason.warning) {
    const w = reason.warning;
    const lead = emulatedWarning ? 'Synthetic warning scenario' : 'Official warning';
    // say each thing once: the lead already marks a synthetic scenario, an issuer named "… BMS" the bulletin type
    const issuer = emulatedWarning ? String(w.issuer).replace(/\s*\((?:synthetic|emulated)\)$/i, '') : w.issuer;
    const kind = /\bBMS\b/.test(issuer) ? warningKindLabel(w.kind).replace(/ \(BMS\)$/, '') : warningKindLabel(w.kind);
    out.push(`${lead} for ${w.area}: ${kind} from ${issuer}.`);
  }
  if (reason.state === 'insufficient' && reason.disagreement) {
    const d = reason.disagreement;
    const values = d.models.map((m) => `${modelRun(m)} ${Math.round(m.value_kt)} kt`).join(' vs ');
    out.push(`The models disagree about the wind ${legLabel(findings, d.leg.leg_id)} around ${fmtTextTime(d.window.from)}: ${values}.`);
    if (typeof d.run_age_gap_hours === 'number' && d.run_age_gap_hours > 0) {
      const gap = Math.round(d.run_age_gap_hours * 10) / 10;
      out.push(`These runs are ${gap} h apart in age, so part of the difference may come from that.`);
    }
  }
  if (reason.result) out.push(...limitSentences(findings, reason.result));
  else if (reason.other) {
    const o = reason.other;
    const where = legLabel(findings, o.leg.leg_id);
    const when = fmtTextTime(o.window.from);
    if (o.kind === 'wind_against_current') out.push(`Wind against the current ${where} around ${when} brings this passage close to your limits.`);
    else if (o.kind === 'gate_conflict') out.push(`The tidal gate ${where} does not fit this departure (around ${when}).`);
    else out.push(`The tidal gate ${where} only partly fits this departure (around ${when}).`);
  }
  return out;
}
