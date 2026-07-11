import { describe, expect, it } from 'vitest';
import { assessGates, type GateDef, type TidesDoc } from '../src/hazards/tides.js';
import { computeSchedules } from '../src/eta.js';
import type { Leg } from '../src/types.js';

// one leg passing right through the gate position
const legs: Leg[] = [
  {
    leg_id: 'L1',
    from: { id: 'a', lat: 49.7, lon: -2.3 },
    to: { id: 'b', lat: 49.7, lon: -1.9 },
    distance_nm: 15.5,
    bearing_deg_true: 90,
    dist_end_nm: 15.5,
  },
];
const speeds = { slow: 4, nominal: 5, fast: 6 };

const gate: GateDef = {
  gate_id: 'test-race',
  name: 'Test Race',
  lat: 49.7,
  lon: -2.1, // mid-leg
  reference_port: 'ref',
  favorable_sw_going: { from_hw_h: -1, to_hw_h: 5 },
  verified: false,
};

function tidesWithHw(hwIso: string): TidesDoc {
  return {
    schema_version: 1,
    generated_at: '2026-07-20T00:00:00Z',
    source: { mode: 'synthetic' },
    ports: [
      {
        port_id: 'ref',
        name: 'Ref Port',
        events: [
          { kind: 'HW', time: hwIso, height_m: 6 },
          { kind: 'LW', time: '2026-07-20T09:00:00Z', height_m: 1 },
        ],
      },
    ],
  };
}

describe('tidal gates', () => {
  const schedules = computeSchedules(legs, speeds, '2026-07-20T06:00:00Z');
  // transit at mid-leg: fast 6kt -> ~07:17, slow 4kt -> ~07:56

  it('transit inside the favorable window -> ok', () => {
    const [g] = assessGates([gate], tidesWithHw('2026-07-20T07:00:00Z'), legs, schedules);
    // favorable 06:00–12:00 covers transit fully
    expect(g!.status).toBe('ok');
    expect(g!.leg_id).toBe('L1');
    expect(g!.rule_text).toContain('unverified');
  });

  it('transit entirely outside the favorable window -> conflict', () => {
    const [g] = assessGates([gate], tidesWithHw('2026-07-20T20:00:00Z'), legs, schedules);
    // favorable 19:00–01:00; transit ~07:17–07:56 -> no overlap
    expect(g!.status).toBe('conflict');
  });

  it('slack-style gate: ±45 min around HW+offset', () => {
    const slackGate: GateDef = {
      ...gate,
      gate_id: 'slack',
      favorable_sw_going: undefined,
      slack_offset_h: -0.5,
    };
    const [g] = assessGates([slackGate], tidesWithHw('2026-07-20T08:00:00Z'), legs, schedules);
    // slack center 07:30 ±45min = 06:45–08:15 covers transit 07:17–07:56 -> ok
    expect(g!.status).toBe('ok');
    expect(g!.rule_text).toContain('slack');
  });

  it('distant gates are ignored', () => {
    const far: GateDef = { ...gate, gate_id: 'far', lat: 48.0, lon: -4.7 };
    expect(assessGates([far], tidesWithHw('2026-07-20T07:00:00Z'), legs, schedules)).toHaveLength(0);
  });
});
