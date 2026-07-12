import { describe, expect, it } from 'vitest';
import { eventKeyForSystem, matchSystems } from '../src/events.js';
import type { SynopticFeatures } from '../src/types.js';

const run = (id: string, timeShiftH: number, pressureDelta: number): SynopticFeatures => ({
  run_id: id,
  systems: [{ system_id: 'L1', kind: 'low', deepening_hpa_per_24h: -18, track: [
    { valid_time: new Date(Date.parse('2026-07-20T06:00:00Z') + timeShiftH * 3600_000).toISOString(), lat: 48.8, lon: -6.8, center_hpa: 1002 + pressureDelta },
    { valid_time: new Date(Date.parse('2026-07-20T12:00:00Z') + timeShiftH * 3600_000).toISOString(), lat: 49.9, lon: -3.2, center_hpa: 996 + pressureDelta },
  ] }],
  regimes: [],
});

describe('stable causal event identity', () => {
  it('matches the demo low across a six-hour and four-hPa run change', () => {
    const previous = run('previous', 6, 4), latest = run('latest', 0, 0);
    expect(eventKeyForSystem(previous.systems[0]!)).toBe(eventKeyForSystem(latest.systems[0]!));
    expect(matchSystems(previous, latest)).toEqual([{ latest_system_id: 'L1', previous_system_id: 'L1', distance_nm: 0, trend_delta: 0 }]);
  });
});
