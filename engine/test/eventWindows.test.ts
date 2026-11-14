import { describe, expect, it } from 'vitest';
import { assembleFindings, type AssembleOptions } from '../src/findings.js';
import type { HazardPointForecast } from '../src/forecast/types.js';
import type { RegionGrid } from '../src/grids.js';
import type { Route } from '../src/types.js';
import { alongEachLeg } from './helpers/samplePoints.js';

// Live case (Finding C): departure 19:32 UTC, the leg of interest starts at
// 19:38 UTC, and the strongest opposing current sits on the 19:00 grid hour
// that the occupancy grid floors to. No event window may start before the leg.
const HOURS = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00'].map(h => `2026-11-10T${h}:00Z`);
const DEPARTURE = '2026-11-10T19:32:00Z';
const LEG2_ENTRY = '2026-11-10T19:38:00Z';

function grid(): RegionGrid {
  const nlat = 5;
  const nlon = 3;
  // Current flows north (set 000°) straight into a northerly wind: worst at 19:00.
  const speeds = [3, 3, 1.5, 1.5, 1.5, 1.5];
  return {
    schema_version: 1, kind: 'surface_current', run_id: 'currents-test', generated_at: HOURS[0]!,
    lat0: 49.9, lon0: -2.1, dlat: 0.1, dlon: 0.1, nlat, nlon, time_axis: HOURS,
    u_kt: speeds.flatMap(() => Array<number>(nlat * nlon).fill(0)),
    v_kt: speeds.flatMap(s => Array<number>(nlat * nlon).fill(s)),
    source: { mode: 'fixture', dataset_id: 'test-currents' },
  };
}

function inputs(): AssembleOptions {
  const point = { lat: 50.05, lon: -2, times: HOURS };
  const n = HOURS.length;
  const det = { ...point, wind_kt: Array(n).fill(25), gust_kt: Array(n).fill(30), wind_dir_deg: Array(n).fill(0) };
  const hazard: HazardPointForecast = {
    ...det, visibility_m: Array(n).fill(20000), cape_jkg: Array(n).fill(700),
    temp_c: Array(n).fill(15), dew_point_c: Array(n).fill(10), precip_mm: Array(n).fill(0),
  };
  const marine = { ...point, hs_m: Array(n).fill(3), period_s: Array(n).fill(5), dir_deg: Array(n).fill(180),
    wind_wave_h_m: Array(n).fill(1), wind_wave_period_s: Array(n).fill(5), wind_wave_dir_deg: Array(n).fill(90),
    swell_h_m: Array(n).fill(2), swell_period_s: Array(n).fill(8), swell_dir_deg: Array(n).fill(180) };
  // Computed (speed-over-ground) basis keeps the schedule independent of the current grid.
  const route = { schema_version: 1, route_id: 'late-start', name: 'Late start', mode: 'computed',
      waypoints: [
        { id: 'a', lat: 50, lon: -2 },
        { id: 'b', lat: 50 + 0.5 / 60, lon: -2 }, // 0.5 nm at 5 kt: 6 minutes
        { id: 'c', lat: 50 + 10.5 / 60, lon: -2 },
      ],
      speeds_kt: { slow: 5, nominal: 5, fast: 5 } } as Route;
  return {
    route,
    profile: { schema_version: 1, profile_id: 'test', label: 'Test', declared: true,
      max_sustained_kt: { default: 22, upwind: 18 }, max_gust_kt: 28,
      max_wave_height_m: 2.5, max_steepness: 0.045, cross_sea_flag: true, min_visibility_nm: 2 },
    departureUtc: DEPARTURE, nowMs: Date.parse(DEPARTURE), engineVersion: 'test',
    pointForecasts: alongEachLeg(route, [det, det]), requestMeta: [],
    pointMarine: alongEachLeg(route, [marine, marine]),
    multiModel: { byModel: { gfs_0p25: alongEachLeg(route, [hazard, hazard]), icon_eu: alongEachLeg(route, [{ ...hazard, wind_kt: Array(n).fill(10) }, { ...hazard, wind_kt: Array(n).fill(10) }]) }, meta: [] },
    currentGrid: grid(),
  };
}

describe('event windows stay inside the leg occupancy interval', () => {
  const findings = assembleFindings(inputs());

  it('reproduces the 19:00 worst-current hour on the second leg', () => {
    const leg2 = findings.legs[1]!;
    expect(leg2.enter_range.fast).toBe(LEG2_ENTRY);
    expect(leg2.hours[0]!.valid_time).toBe('2026-11-10T19:00:00Z');
    expect(leg2.hours[0]!.current?.wind_against_current).toBe(true);
  });

  it('clamps wind-against-current to leg entry (19:38), never the 19:00 grid hour', () => {
    const wac = findings.events.find(e => e.kind === 'wind_against_current' && e.leg_id === 'L2')!;
    expect(Date.parse(wac.window!.from)).toBeGreaterThanOrEqual(Date.parse(LEG2_ENTRY));
    expect(wac.window!.from).toBe(LEG2_ENTRY);
    const op = findings.causal_events!.find(e => e.event_key === 'wind-against-current:L2')!;
    expect(op.route_intersection!.window_start).toBe(LEG2_ENTRY);
  });

  it('never places any grid-hour event before departure or outside its leg', () => {
    const legEvents = findings.events.filter(e => e.leg_id && e.window);
    expect(legEvents.map(e => e.kind)).toEqual(expect.arrayContaining([
      'wind_against_current', 'cross_sea', 'wind_against_swell', 'squall_potential',
      'model_divergence', 'limit_exceeded',
    ]));
    for (const event of legEvents) {
      const leg = findings.legs.find(l => l.leg_id === event.leg_id)!;
      const from = Date.parse(event.window!.from);
      const to = Date.parse(event.window!.to);
      expect(from, `${event.kind} ${event.leg_id}`).toBeGreaterThanOrEqual(Date.parse(DEPARTURE));
      expect(from, `${event.kind} ${event.leg_id}`).toBeGreaterThanOrEqual(Date.parse(leg.enter_range.fast));
      expect(to, `${event.kind} ${event.leg_id}`).toBeLessThanOrEqual(Date.parse(leg.eta_range.slow));
      expect(from).toBeLessThanOrEqual(to);
    }
  });

  it('keeps evidence on the forecast sample time it was read from', () => {
    const wacEvidence = findings.evidence.find(e => e.rule_id === 'T-WAC-01' && e.leg_id === 'L2');
    expect(wacEvidence?.valid_time).toBe('2026-11-10T19:00:00Z');
  });
});
