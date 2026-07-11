/**
 * Change ledger (mockup 3): what changed between the previous analysis and this
 * one, with evidence pairs — never a vague "forecast updated". Honest diffing:
 * timing shifts, value deltas, events appearing/vanishing, verdict transitions.
 */

import { fmtTime } from './briefing.js';
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
}

export interface Changes {
  schema_version: number;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  verdict_transition: { from: string | null; to: string };
  entries: ChangeEntry[];
}

const VALUE_DELTA_MIN = 1.5; // kt — below this, wind deltas are noise, not news

export function diffFindings(previous: Findings | null, latest: Findings): Changes {
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
      description: `Assessment changed: ${previous.verdict.state} → ${latest.verdict.state}.`,
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
        description: `New signal ${e.rule_id} on ${e.leg_id}${e.valid_time ? ` around ${fmtTime(e.valid_time)} UTC` : ''}.`,
        latest: e.value,
        evidence_pair: [e.evidence_id],
      });
      continue;
    }
    if (p.valid_time && e.valid_time && p.valid_time !== e.valid_time) {
      const deltaH = Math.round((Date.parse(e.valid_time) - Date.parse(p.valid_time)) / 3600_000);
      if (deltaH !== 0) {
        entries.push({
          kind: 'event_shifted',
          description: `${e.rule_id} on ${e.leg_id}: ${fmtTime(p.valid_time)} → ${fmtTime(e.valid_time)} UTC (${deltaH > 0 ? `${deltaH} h later` : `${-deltaH} h earlier`}).`,
          previous: p.valid_time,
          latest: e.valid_time,
          evidence_pair: [p.evidence_id, e.evidence_id],
        });
      }
    }
    if (typeof p.value === 'number' && typeof e.value === 'number') {
      const delta = e.value - p.value;
      if (Math.abs(delta) >= VALUE_DELTA_MIN) {
        entries.push({
          kind: 'value_changed',
          description: `${e.rule_id} on ${e.leg_id}: ${p.value} → ${e.value} ${e.units ?? ''} (${delta > 0 ? '+' : ''}${Math.round(delta * 10) / 10}).`,
          previous: p.value,
          latest: e.value,
          evidence_pair: [p.evidence_id, e.evidence_id],
        });
      }
    } else if (p.member_fraction && e.member_fraction) {
      const deltaMembers = e.member_fraction.exceed - p.member_fraction.exceed;
      if (Math.abs(deltaMembers) >= 5) {
        entries.push({
          kind: 'value_changed',
          description: `${e.rule_id} on ${e.leg_id}: ${p.member_fraction.exceed} of ${p.member_fraction.total} → ${e.member_fraction.exceed} of ${e.member_fraction.total} scenarios exceed.`,
          previous: p.member_fraction,
          latest: e.member_fraction,
          evidence_pair: [p.evidence_id, e.evidence_id],
        });
      }
    }
  }
  for (const [k, p] of prevByKey) {
    if (!seen.has(k)) {
      entries.push({
        kind: 'event_gone',
        description: `${p.rule_id} on ${p.leg_id} no longer flagged.`,
        previous: p.value,
        evidence_pair: [p.evidence_id],
      });
    }
  }

  // source updates (model runs)
  const runOf = (f: Findings) =>
    (f.inputs.openmeteo.find((m) => m.api === 'forecast')?.run_inferred as string) ?? null;
  if (runOf(previous) !== runOf(latest)) {
    entries.push({
      kind: 'source_updated',
      description: `Model run updated: ${runOf(previous) ?? '—'} → ${runOf(latest) ?? '—'}.`,
      previous: runOf(previous),
      latest: runOf(latest),
    });
  }

  return {
    schema_version: 1,
    snapshot_id: latest.snapshot_id,
    previous_snapshot_id: previous.snapshot_id,
    verdict_transition: { from: previous.verdict.state, to: latest.verdict.state },
    entries,
  };
}
