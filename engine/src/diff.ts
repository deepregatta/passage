/**
 * Change ledger (mockup 3): what changed between the previous analysis and this
 * one, with evidence pairs; never a vague "forecast updated". Honest diffing:
 * timing shifts, value deltas, events appearing/vanishing, verdict transitions.
 */

import { fmtTime, type Briefing } from './briefing.js';
import type { Evidence, Findings } from './types.js';

export interface ChangeEntry {
  kind:
    | 'event_shifted'
    | 'value_changed'
    | 'event_new'
    | 'event_gone'
    | 'verdict_changed'
    | 'source_updated';
  description: string;
  previous?: unknown;
  latest?: unknown;
  evidence_pair?: string[];
  rule_id?: string;
  leg_id?: string | null;
  zone_ids?: string[];
}

export interface Changes {
  schema_version: number;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  verdict_transition: { from: string | null; to: string };
  entries: ChangeEntry[];
  story?: {
    headline_plain: string;
    headline_pro: string;
    material: Array<{
      change_ref: number;
      before: unknown;
      after: unknown;
      why_it_matters: string;
      evidence_ids: string[];
    }>;
    next_run?: Briefing['next_run'];
  };
}

const VALUE_DELTA_MIN = 1.5; // kt; below this, wind deltas are noise, not news

export function diffFindings(previous: Findings | null, latest: Findings, nextRun?: Briefing['next_run']): Changes {
  const entries: ChangeEntry[] = [];

  if (!previous) {
    return {
      schema_version: 1,
      snapshot_id: latest.snapshot_id,
      previous_snapshot_id: null,
      verdict_transition: { from: null, to: latest.verdict.state },
      entries,
    };
  }

  // verdict transition
  if (previous.verdict.state !== latest.verdict.state) {
    entries.push({
      kind: 'verdict_changed',
      description: `Assessment changed: ${verdictLabel(previous.verdict.state)} → ${verdictLabel(latest.verdict.state)}.`,
      previous: previous.verdict.state,
      latest: latest.verdict.state,
    });
  }

  // evidence pairs matched by (rule, leg): timing shifts + value deltas
  const key = (e: Evidence) => `${e.rule_id}:${e.leg_id}`;
  const prevByKey = new Map(previous.evidence.map((e) => [key(e), e]));
  const seen = new Set<string>();
  for (const e of latest.evidence) {
    const k = key(e);
    seen.add(k);
    const p = prevByKey.get(k);
    if (!p) {
      entries.push({
        kind: 'event_new',
        description: `New signal: ${ruleLabel(e.rule_id)} ${subject(e, latest)}${e.valid_time ? ` around ${fmtTime(e.valid_time)} UTC` : ''}.`,
        latest: e.value,
        evidence_pair: [e.evidence_id],
        rule_id: e.rule_id,
        leg_id: e.leg_id,
        zone_ids: e.bulletin_ref?.zone_ids,
      });
      continue;
    }
    if (p.valid_time && e.valid_time && p.valid_time !== e.valid_time) {
      const deltaH = Math.round((Date.parse(e.valid_time) - Date.parse(p.valid_time)) / 3600_000);
      if (deltaH !== 0) {
        entries.push({
          kind: 'event_shifted',
          description: `${ruleLabel(e.rule_id)} ${subject(e, latest)}: ${fmtTime(p.valid_time)} → ${fmtTime(e.valid_time)} UTC (${deltaH > 0 ? `${deltaH} h later` : `${-deltaH} h earlier`}).`,
          previous: p.valid_time,
          latest: e.valid_time,
          evidence_pair: [p.evidence_id, e.evidence_id],
          rule_id: e.rule_id,
          leg_id: e.leg_id,
          zone_ids: e.bulletin_ref?.zone_ids,
        });
      }
    }
    if (typeof p.value === 'number' && typeof e.value === 'number') {
      const delta = e.value - p.value;
      if (Math.abs(delta) >= VALUE_DELTA_MIN) {
        entries.push({
          kind: 'value_changed',
          description: `${ruleLabel(e.rule_id)} ${subject(e, latest)}: ${Math.round(p.value)} → ${Math.round(e.value)} ${e.units ?? ''} (${delta > 0 ? 'up' : 'down'} ${Math.abs(Math.round(delta))}).`,
          previous: p.value,
          latest: e.value,
          evidence_pair: [p.evidence_id, e.evidence_id],
          rule_id: e.rule_id,
          leg_id: e.leg_id,
        });
      }
    } else if (p.member_fraction && e.member_fraction) {
      const deltaMembers = e.member_fraction.exceed - p.member_fraction.exceed;
      if (Math.abs(deltaMembers) >= 5) {
        entries.push({
          kind: 'value_changed',
          description: `${ruleLabel(e.rule_id)} ${subject(e, latest)}: ${p.member_fraction.exceed} of ${p.member_fraction.total} → ${e.member_fraction.exceed} of ${e.member_fraction.total} scenarios exceed.`,
          previous: p.member_fraction,
          latest: e.member_fraction,
          evidence_pair: [p.evidence_id, e.evidence_id],
          rule_id: e.rule_id,
          leg_id: e.leg_id,
        });
      }
    }
  }
  for (const [k, p] of prevByKey) {
    if (!seen.has(k)) {
      entries.push({
        kind: 'event_gone',
        description: `${ruleLabel(p.rule_id)} ${subject(p, previous)} no longer flagged.`,
        previous: p.value,
        evidence_pair: [p.evidence_id],
        rule_id: p.rule_id,
        leg_id: p.leg_id,
        zone_ids: p.bulletin_ref?.zone_ids,
      });
    }
  }

  // Stable causal identity: promote system timing changes even when rule ids stay unchanged.
  for (const event of latest.causal_events ?? []) {
    const prior = previous.causal_events?.find((item) => item.event_key && item.event_key === event.event_key);
    if (!prior?.route_intersection || !event.route_intersection) continue;
    const deltaH = Math.round((Date.parse(event.route_intersection.window_start) - Date.parse(prior.route_intersection.window_start)) / 3600_000);
    if (deltaH === 0) continue;
    entries.push({
      kind: 'event_shifted',
      description: `${event.name} is the same system as in the previous briefing. It now reaches the route ${Math.abs(deltaH)} h ${deltaH < 0 ? 'earlier' : 'later'}.`,
      previous: prior.route_intersection.window_start,
      latest: event.route_intersection.window_start,
      evidence_pair: [...prior.consequence.evidence_ids.slice(0, 1), ...event.consequence.evidence_ids.slice(0, 1)],
      leg_id: event.route_intersection.leg_id,
    });
  }

  // source updates (model runs)
  const runOf = (f: Findings) =>
    (f.inputs.forecast_tiles.find((m) => m.layer === 'weather')?.cycle as string) ?? null;
  if (runOf(previous) !== runOf(latest)) {
    entries.push({
      kind: 'source_updated',
      description: `Model run updated: ${runOf(previous) ?? 'n/a'} → ${runOf(latest) ?? 'n/a'}.`,
      previous: runOf(previous),
      latest: runOf(latest),
    });
  }

  const transition = { from: previous.verdict.state, to: latest.verdict.state };
  return {
    schema_version: 1,
    snapshot_id: latest.snapshot_id,
    previous_snapshot_id: previous.snapshot_id,
    verdict_transition: transition,
    entries,
    story: buildStory(latest, entries, transition, nextRun),
  };
}

/** sailor-readable names for rule ids; the raw id stays available on the entry */
const RULE_LABEL: Record<string, string> = {
  'W-SUST-01': 'sustained wind vs your limit',
  'W-GUST-01': 'gusts vs your limit',
  'W-SUST-03': 'wind scenarios over your limit',
  'W-GUST-03': 'gust scenarios over your limit',
  'S-WAVE-01': 'wave height vs your limit',
  'S-CROSS-01': 'cross-sea',
  'S-STEEP-01': 'steep waves',
  'S-WAS-01': 'wind against swell',
  'T-WAC-01': 'wind against current',
  'T-GATE-01': 'tidal gate fit',
  'A-WARN-01': 'official marine warning',
  'D-DIVERGE-01': 'model disagreement',
  'C-CAPE-01': 'thunderstorm potential',
  'V-VIS-01': 'visibility',
};
const ruleLabel = (id: string | undefined) => (id && RULE_LABEL[id]) ?? id ?? 'signal';

/** machine waypoint ids (wp1, wp2…) read badly in prose */
const placeText = (raw: string) => raw.replace(/\bwp(\d+)\b/gi, 'waypoint $1');

function subject(evidence: Evidence, findings: Findings): string {
  if (evidence.leg_id) {
    const leg = findings.legs.find((item) => item.leg_id === evidence.leg_id);
    const place = leg?.name.split('→')[1]?.trim().split(',')[0];
    return place ? `near ${placeText(place)}` : `on leg ${evidence.leg_id}`;
  }
  const zones = evidence.bulletin_ref?.zone_ids;
  if (zones?.length) return `for zone ${zones.join(', ')}`;
  return 'for the route';
}

function buildStory(
  latest: Findings,
  entries: ChangeEntry[],
  transition: { from: string; to: string },
  nextRun: Briefing['next_run'],
): NonNullable<Changes['story']> {
  const driver = latest.evidence.find((item) => item.evidence_id === latest.verdict.driver_evidence_id);
  const scored = entries.map((entry, index) => {
    let score = entry.kind === 'verdict_changed' ? 100 : 0;
    if (driver && entry.rule_id === driver.rule_id && entry.leg_id === driver.leg_id) score = Math.max(score, 80);
    if (entry.kind === 'value_changed' && entry.rule_id?.startsWith('W-')) score = Math.max(score, 60);
    if (entry.rule_id === 'A-WARN-01') score = Math.max(score, 40);
    return { entry, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
  const changed = transition.from !== transition.to;
  const headlinePlain = changed
    ? `The verdict changed from “${verdictLabel(transition.from)}” to “${verdictLabel(transition.to)}”.`
    : scored.length
      ? `The verdict is still “${verdictLabel(transition.to)}”, but the timing or strength changed.`
      : `The new run keeps the same verdict: ${verdictLabel(transition.to)}.`;
  return {
    headline_plain: headlinePlain,
    headline_pro: `${entries.length} ledger entries ranked deterministically; ${scored.length} material changes promoted.`,
    material: scored.map(({ entry, index }) => ({
      change_ref: index,
      before: entry.previous ?? null,
      after: entry.latest ?? null,
      why_it_matters: humanizeChange(entry, latest),
      evidence_ids: entry.evidence_pair ?? [],
    })),
    ...(nextRun ? { next_run: nextRun } : {}),
  };
}

function verdictLabel(state: string) {
  return ({ within: 'within your limits', approaching: 'close to your limits', exceeds: 'beyond your limits', insufficient: 'too uncertain to assess', warning_active: 'official warning active' } as Record<string, string>)[state] ?? state.replaceAll('_', ' ');
}

function humanizeChange(entry: ChangeEntry, latest: Findings): string {
  if (entry.kind === 'verdict_changed') return 'The action threshold changed; reassess the departure.';
  if (entry.rule_id === 'A-WARN-01') return 'Authority coverage changed for a crossed marine zone.';
  if (entry.rule_id === latest.evidence.find((item) => item.evidence_id === latest.verdict.driver_evidence_id)?.rule_id) {
    return 'This is the rule currently driving the personal-limit assessment.';
  }
  if (entry.kind === 'event_shifted') return 'The hazardous interval moved relative to the route ETA envelope.';
  return 'This remains in the full ledger because it may matter to passage margins.';
}
