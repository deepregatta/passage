import { describe, expect, it } from 'vitest';
import { diffFindings } from '../src/diff.js';
import type { Evidence, Findings } from '../src/types.js';

function fakeFindings(partial: {
  snapshot_id: string;
  verdict: string;
  evidence: Array<Partial<Evidence> & { rule_id: string; leg_id: string | null }>;
  run?: string;
}): Findings {
  return {
    schema_version: 1,
    snapshot_id: partial.snapshot_id,
    route_id: 'r',
    profile_id: 'p',
    departure_utc: '2026-07-20T06:00:00Z',
    engine_version: '0.1.0',
    generated_at: '2026-07-19T18:00:00Z',
    inputs: {
      prepared_run_id: null,
      forecast_tiles: [{ layer: 'weather', cycle: partial.run ?? 'runA' }],
      warnings_ref: null,
      route_hash: 'x',
      profile_hash: 'y',
    },
    legs: [],
    events: [],
    verdict: {
      state: partial.verdict as Findings['verdict']['state'],
      driver_evidence_id: null,
      warning_override: { active: false, bulletin_ref: null },
    },
    evidence: partial.evidence.map((e, i) => ({
      evidence_id: `E${i + 1}`,
      model: 'm',
      run: 'runA',
      valid_time: '2026-07-20T12:00:00Z',
      value: 20,
      limit: 28,
      units: 'kt',
      source_kind: 'deterministic',
      ...e,
    })) as Evidence[],
    unsupported_hazards: [],
  };
}

describe('change ledger', () => {
  it('first analysis: no previous, empty ledger, transition from null', () => {
    const changes = diffFindings(null, fakeFindings({ snapshot_id: 'b', verdict: 'within', evidence: [] }));
    expect(changes.previous_snapshot_id).toBeNull();
    expect(changes.verdict_transition).toEqual({ from: null, to: 'within' });
    expect(changes.entries).toHaveLength(0);
  });

  it('detects verdict change, timing shift, value delta, new/gone events, run update', () => {
    const previous = fakeFindings({
      snapshot_id: 'a',
      verdict: 'approaching',
      run: 'runA',
      evidence: [
        { rule_id: 'W-GUST-01', leg_id: 'L3', valid_time: '2026-07-20T19:00:00Z', value: 26 },
        { rule_id: 'S-WAVE-01', leg_id: 'L4', value: 2.1, limit: 2.5 },
      ],
    });
    const latest = fakeFindings({
      snapshot_id: 'b',
      verdict: 'exceeds',
      run: 'runB',
      evidence: [
        { rule_id: 'W-GUST-01', leg_id: 'L3', valid_time: '2026-07-20T16:00:00Z', value: 32 },
        { rule_id: 'T-WAC-01', leg_id: 'L2', value: 'current vs wind' },
      ],
    });

    const changes = diffFindings(previous, latest);
    const kinds = changes.entries.map((e) => e.kind);
    expect(changes.verdict_transition).toEqual({ from: 'approaching', to: 'exceeds' });
    expect(kinds).toContain('verdict_changed');
    expect(kinds).toContain('event_shifted'); // 19:00 -> 16:00, 3 h earlier
    expect(kinds).toContain('value_changed'); // 26 -> 32 kt
    expect(kinds).toContain('event_new'); // T-WAC-01 appeared
    expect(kinds).toContain('event_gone'); // S-WAVE-01 vanished
    expect(kinds).toContain('source_updated'); // runA -> runB

    const shift = changes.entries.find((e) => e.kind === 'event_shifted')!;
    expect(shift.description).toContain('3 h earlier');
    expect(shift.evidence_pair).toHaveLength(2);
    expect(changes.story?.material.length).toBeLessThanOrEqual(3);
    expect(changes.story?.headline_plain).toContain('changed');
  });

  it('ignores noise: sub-threshold value deltas produce no entry', () => {
    const previous = fakeFindings({
      snapshot_id: 'a',
      verdict: 'within',
      evidence: [{ rule_id: 'W-SUST-01', leg_id: 'L1', value: 20.0 }],
    });
    const latest = fakeFindings({
      snapshot_id: 'b',
      verdict: 'within',
      evidence: [{ rule_id: 'W-SUST-01', leg_id: 'L1', value: 21.0 }],
    });
    const changes = diffFindings(previous, latest);
    expect(changes.entries.filter((e) => e.kind === 'value_changed')).toHaveLength(0);
  });

  it('phrases warning changes by zone and never leaks a null leg', () => {
    const previous = fakeFindings({ snapshot_id: 'a', verdict: 'within', evidence: [] });
    const latest = fakeFindings({
      snapshot_id: 'b',
      verdict: 'warning_active',
      evidence: [{
        rule_id: 'A-WARN-01',
        leg_id: null,
        source_kind: 'emulated',
        bulletin_ref: { source: 'fixture', issued_at: '2026-07-20T06:00:00Z', valid_from: '2026-07-20T12:00:00Z', valid_to: '2026-07-21T12:00:00Z', zone_ids: ['casquets'] },
      }],
    });
    const changes = diffFindings(previous, latest);
    expect(changes.entries.map((entry) => entry.description).join(' ')).toContain('zone casquets');
    expect(JSON.stringify(changes)).not.toContain('on null');
  });
});
