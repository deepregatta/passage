import { describe, expect, it } from 'vitest';
import { renderBriefing } from '../src/briefing.js';
import { assembleFindings, RULES, type AssembleOptions } from '../src/findings.js';
import type { HazardPointForecast } from '../src/forecast/types.js';

// Short synthetic northbound leg with three occupied forecast hours.
const times = ['2026-07-20T06:00:00Z', '2026-07-20T07:00:00Z', '2026-07-20T08:00:00Z'];
function inputs(): AssembleOptions {
  const point = { lat: 50.05, lon: -2, times };
  const det = { ...point, wind_kt: [25, 25, 25], gust_kt: [35, 35, 35], wind_dir_deg: [0, 0, 0] };
  const hazard: HazardPointForecast = {
    ...det, visibility_m: [1852, 1852, 1852], cape_jkg: [500, 700, 500],
    temp_c: [15, 15, 15], dew_point_c: [14, 14, 14], precip_mm: [0, 0, 0],
  };
  return {
    route: { schema_version: 1, route_id: 'synthetic', name: 'Synthetic', mode: 'fixed',
      waypoints: [{ id: 'a', lat: 50, lon: -2 }, { id: 'b', lat: 50.1, lon: -2 }],
      speeds_kt: { slow: 5, nominal: 5, fast: 5 } },
    profile: { schema_version: 1, profile_id: 'test', label: 'Test', declared: true,
      max_sustained_kt: { default: 22, upwind: 18 }, max_gust_kt: 28,
      max_wave_height_m: 2.5, max_steepness: 0.045, cross_sea_flag: true, min_visibility_nm: 2 },
    departureUtc: times[0]!, nowMs: Date.parse(times[0]!), engineVersion: 'test',
    legForecasts: [det], requestMeta: [],
    legEnsembles: [{ ...point, wind_kt_members: [[25, 25, 25], [10, 10, 10]],
      gust_kt_members: [[35, 35, 35], [10, 10, 10]] }],
    legMarine: [{ ...point, hs_m: [3, 3, 3], period_s: [5, 5, 5], dir_deg: [180, 180, 180],
      wind_wave_h_m: [1, 1, 1], wind_wave_period_s: [5, 5, 5], wind_wave_dir_deg: [90, 90, 90],
      swell_h_m: [2, 2, 2], swell_period_s: [8, 8, 8], swell_dir_deg: [180, 180, 180] }],
    multiModel: { byModel: { gfs_0p25: [hazard], icon_eu: [{ ...hazard, wind_kt: [10, 10, 10] }] }, meta: [] },
  };
}

function evidenceFor(options: AssembleOptions, rule: string) {
  return assembleFindings(options).evidence.find(e => e.rule_id === rule);
}

describe('findings assembly compatibility', () => {
  it('keeps evidence order, first-hour ties and same-leg event references', () => {
    const findings = assembleFindings(inputs());
    expect(findings.legs[0]!.hours.map(h => h.valid_time)).toEqual(times);
    expect(findings.evidence.map(e => e.rule_id)).toEqual([
      RULES.SUSTAINED, RULES.GUST, RULES.GUST_ENSEMBLE, RULES.SUSTAINED_ENSEMBLE,
      RULES.WAVE_HEIGHT, RULES.STEEPNESS, RULES.CROSS_SEA, RULES.WIND_AGAINST_SWELL,
      RULES.SQUALL, RULES.VISIBILITY, RULES.DIVERGENCE,
    ]);
    expect(findings.evidence.map(e => e.evidence_id)).toEqual(findings.evidence.map((_, i) => `E${i + 1}`));
    expect(findings.evidence.every(e => e.valid_time === times[0])).toBe(true);
    expect(findings.events.find(e => e.kind === 'limit_exceeded')).toEqual({
      kind: 'limit_exceeded', leg_id: 'L1', window: { from: times[0], to: times[2] },
      refs: findings.evidence.map(e => e.evidence_id),
    });
  });

  it('selects the first elevated CAPE hour until a high hour takes precedence', () => {
    const options = inputs();
    expect(evidenceFor(options, RULES.SQUALL)?.value).toBe(500);
    options.multiModel!.byModel.gfs_0p25![0]!.cape_jkg = [700, 1500, 1500];
    expect(evidenceFor(options, RULES.SQUALL)).toMatchObject({ value: 1500, valid_time: times[1] });
  });

  it('uses legacy visibility sources only when the preferred source has no value', () => {
    const options = inputs();
    options.multiModel!.byModel.gfs_0p25![0]!.visibility_m = [null, 3 * 1852, null];
    options.multiModel!.byModel.icon_eu![0]!.visibility_m = [1852, 0, 926];
    const findings = assembleFindings(options);
    expect(findings.legs[0]!.hours.map(h => h.visibility_nm)).toEqual([1, 3, 0.5]);
    expect(findings.evidence.find(e => e.rule_id === RULES.VISIBILITY))
      .toMatchObject({ value: 0.5, valid_time: times[2], model: 'gfs_0p25/icon_eu/gfs_global' });
  });

  it('retains missing optional fields and unknown wind when timestamps are absent', () => {
    const options = inputs();
    options.legForecasts[0]!.times = [];
    options.legMarine![0]!.times = [];
    options.legEnsembles![0]!.times = [];
    delete options.multiModel;
    const findings = assembleFindings(options);
    expect(findings.evidence).toEqual([]);
    for (const hour of findings.legs[0]!.hours) {
      expect(hour).toEqual({ valid_time: hour.valid_time, wind_kt: null, gust_kt: null,
        wind_dir_deg: null, twa_deg: null, point_of_sail: null,
        limit_status: { sustained: 'unknown', gust: 'unknown' } });
    }
  });

  it('counts only available ensemble members and retains an all-null hour', () => {
    const options = inputs();
    options.legEnsembles![0]!.gust_kt_members = [[35, null, 35], [null, null, 10]];
    const findings = assembleFindings(options);
    expect(findings.legs[0]!.hours.map(h => h.exceedance?.gust)).toEqual([
      { exceed: 1, total: 1 }, null, { exceed: 1, total: 2 },
    ]);
    expect(findings.evidence.find(e => e.rule_id === RULES.GUST_ENSEMBLE))
      .toMatchObject({ valid_time: times[0], member_fraction: { exceed: 1, total: 1 } });
  });

  it('ranks steepness before rounding its displayed value', () => {
    const options = inputs();
    options.legMarine![0]!.hs_m = [3, 3.0001, 3];
    const findings = assembleFindings(options);
    expect(findings.legs[0]!.hours[0]!.waves!.steepness).toBe(findings.legs[0]!.hours[1]!.waves!.steepness);
    expect(findings.evidence.find(e => e.rule_id === RULES.STEEPNESS)?.valid_time).toBe(times[1]);
  });

  it('does not mutate inputs or share accumulators between runs', () => {
    const options = inputs();
    const before = structuredClone(options);
    const first = assembleFindings(options);
    expect(assembleFindings(options)).toEqual(first);
    expect(options).toEqual(before);
    first.evidence[0]!.value = -1;
    expect(assembleFindings(options).evidence[0]!.value).toBe(25);
  });

  it('continues evidence IDs across legs and passage-wide warnings', () => {
    const options = inputs();
    options.route.waypoints.push({ id: 'c', lat: 50.2, lon: -2 });
    options.legForecasts.push(structuredClone(options.legForecasts[0]!));
    options.legMarine!.push(structuredClone(options.legMarine![0]!));
    options.legEnsembles!.push(structuredClone(options.legEnsembles![0]!));
    for (const forecasts of Object.values(options.multiModel!.byModel)) {
      forecasts.push(structuredClone(forecasts[0]!));
    }
    options.warnings = {
      ref: 'synthetic', routeZoneIds: ['test-zone'],
      doc: {
        schema_version: 1, fetched_at: times[0]!, source: { mode: 'synthetic' }, feed_status: 'ok',
        bulletins: [{ zone_id: 'test-zone', kind: 'gale', severity: 'gale',
          valid_from: times[0]!, valid_to: '2026-07-21T00:00:00Z', raw_text: 'Synthetic test warning' }],
      },
    };
    const findings = assembleFindings(options);
    expect(findings.evidence.map(e => e.evidence_id)).toEqual(findings.evidence.map((_, i) => `E${i + 1}`));
    expect(findings.evidence.filter(e => e.leg_id === 'L1')).toHaveLength(11);
    expect(findings.evidence.filter(e => e.leg_id === 'L2')).toHaveLength(11);
    expect(findings.evidence.at(-1)).toMatchObject({ evidence_id: 'E23', rule_id: RULES.AUTHORITY, leg_id: null });
    for (const event of findings.events.filter(e => e.kind === 'limit_exceeded')) {
      expect(event.refs).toEqual(findings.evidence.filter(e => e.leg_id === event.leg_id).map(e => e.evidence_id));
    }
    expect(findings.events.at(-1)?.refs).toEqual(['E23']);
  });
});

it.each([
  ['Channel', 50, -2],
  ['Mediterranean', 43, 7],
  ['US', 40, -70],
])('discloses fixed prepared-run coverage for a %s route', (_region, lat, lon) => {
  const options = inputs();
  options.route.waypoints = [{ id: 'a', lat, lon }, { id: 'b', lat: lat + 0.1, lon }];
  options.synoptic = { run_id: 'ecmwf-ifs025-20260916T00Z', systems: [], regimes: [] };
  const findings = assembleFindings(options);
  expect(findings.coverage?.find(item => item.capability === 'synoptic_attribution'))
    .toMatchObject({ status: 'partially_assessed', detail: expect.stringContaining('Channel-only prepared run') });
  expect(findings.coverage?.find(item => item.capability === 'sustained_wind')?.status).toBe('assessed');
  expect(renderBriefing(findings).sections.find(section => section.id === 'unsupported')?.register_pro)
    .toContain('Channel-only prepared run');
});

it('does not label an absent run or a synthetic scenario as Channel-only preparation', () => {
  const options = inputs();
  expect(assembleFindings(options).coverage?.find(item => item.capability === 'synoptic_attribution'))
    .toMatchObject({ status: 'not_assessed', detail: 'causal synoptic attribution (no prepared synoptic run)' });
  options.synoptic = { run_id: 'synthetic-reference-demo', systems: [], regimes: [] };
  expect(assembleFindings(options).coverage?.find(item => item.capability === 'synoptic_attribution'))
    .toMatchObject({ status: 'assessed', detail: 'system tracks assessed against the route ETA envelope' });
});
