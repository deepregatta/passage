import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleFindings, type AssembleOptions } from '../src/findings.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { governingReason, runAnalysis } from '../src/index.js';
import type { Findings, LimitsProfile, Route } from '../src/types.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// The committed reference demo (read-only): warning_active, emulated scenario runs.
const DEMO = '../../viewer/test/fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
const demo = () => read(DEMO) as Findings;

describe('governingReason on the reference demo (warning_active)', () => {
  const reason = governingReason(demo());

  it('names the warning that sets the state', () => {
    expect(reason.state).toBe('warning_active');
    expect(reason.warning).toEqual({
      evidence_id: 'E23', kind: 'BMS-large', area: 'Casquets', zone_ids: ['casquets'],
      issuer: 'Météo-France BMS (synthetic)', feed_fetched_at: '2026-07-20T06:00:00Z',
      valid_from: '2026-07-20T12:00:00Z', valid_to: '2026-07-21T12:00:00Z', active_count: 1,
    });
    expect(reason.verdict_driver_evidence_id).toBe('E9');
  });

  it('gives the first limit the boat meets beyond its value, with one hour and one place', () => {
    // L3's only exceeded hour is its 18:00 ceiling grid hour; the boat leaves L3 at 17:03.
    expect(reason.result).toEqual({
      selection: 'earliest_exceedance',
      status: 'exceeded',
      limit: { kind: 'wind', value: 18, unit: 'kt', bound: 'max' },
      statistic: {
        value: 18.27, unit: 'kt', statistic: 'deterministic_hourly_max',
        model: 'scenario', model_name: 'scenario', run: 'scenario', valid_time: '2026-07-20T18:00:00Z',
      },
      ratio: 1.015,
      scenarios: {
        exceeding: 24, total: 51, valid_time: '2026-07-20T18:00:00Z',
        model: 'scenario ensemble', model_name: 'scenario', run: 'scenario',
      },
      leg: { leg_id: 'L3', index: 2, name: 'NW of Cap de la Hague → Casquets TSS crossing', place: 'Casquets TSS crossing' },
      window: { from: '2026-07-20T17:03:36Z', to: '2026-07-20T17:03:36Z' },
      evidence_id: 'E3',
    });
  });
});

describe('governingReason: exceeds', () => {
  const exceeds = () => {
    const f = demo();
    f.verdict = { ...f.verdict, state: 'exceeds', warning_override: { active: false, bulletin_ref: null } };
    f.evidence = f.evidence.filter((e) => e.rule_id !== 'A-WARN-01');
    return f;
  };

  it('takes the earliest exceedance window', () => {
    const reason = governingReason(exceeds());
    expect(reason).toMatchObject({ state: 'exceeds', warning: null, disagreement: null, other: null });
    expect(reason.result).toMatchObject({ selection: 'earliest_exceedance', evidence_id: 'E3', leg: { leg_id: 'L3' } });
  });

  it('breaks a window tie by scenario share, then by value/limit ratio', () => {
    const f = exceeds();
    f.evidence = f.evidence.filter((e) => e.leg_id !== 'L3');
    // L4 and L5 wind both cross 18 kt from 19:00 with 51/51 scenarios at their
    // statistic hour; L5's 28.4 kt is further beyond the limit than L4's 22.4 kt.
    const result = governingReason(f).result!;
    expect(result).toMatchObject({
      leg: { leg_id: 'L5', place: 'Plymouth approach (E of Eddystone)' },
      limit: { kind: 'wind', value: 18 }, statistic: { value: 28.38, valid_time: '2026-07-21T05:00:00Z' },
      scenarios: { exceeding: 51, total: 51, valid_time: '2026-07-21T05:00:00Z' },
      window: { from: '2026-07-20T19:00:00Z', to: '2026-07-21T04:04:56Z' },
      evidence_id: 'E10',
    });
    // a larger scenario share wins the same tie before the ratio does
    const l4 = f.legs.find((l) => l.leg_id === 'L4')!;
    l4.hours.find((h) => h.valid_time === '2026-07-20T23:00:00Z')!.exceedance!.sustained = { exceed: 51, total: 51 };
    f.legs.find((l) => l.leg_id === 'L5')!.hours
      .find((h) => h.valid_time === '2026-07-21T05:00:00Z')!.exceedance!.sustained = { exceed: 50, total: 51 };
    expect(governingReason(f).result).toMatchObject({ leg: { leg_id: 'L4' }, evidence_id: 'E6' });
  });
});

// Short synthetic leg for approaching/within, built through the real assembler.
const PROFILE = read('../../config/profiles/default-limits.json') as LimitsProfile;
const times = ['2026-07-20T06:00:00Z', '2026-07-20T07:00:00Z', '2026-07-20T08:00:00Z'];
function assemble(windKt: number[], gustKt: number[]): Findings {
  const det = { lat: 50.05, lon: -2, times, wind_kt: windKt, gust_kt: gustKt, wind_dir_deg: [0, 0, 0] };
  const options: AssembleOptions = {
    route: { schema_version: 1, route_id: 'synthetic', name: 'Synthetic', mode: 'fixed',
      waypoints: [{ id: 'a', name: 'Start', lat: 50, lon: -2 }, { id: 'b', name: 'Finish, north', lat: 50.1, lon: -2 }],
      speeds_kt: { slow: 5, nominal: 5, fast: 5 } },
    profile: PROFILE, departureUtc: '2026-07-20T06:30:00Z', nowMs: Date.parse(times[0]!), engineVersion: 'test',
    pointForecasts: [det], requestMeta: [{ source: 'tiles', layer: 'weather', model: 'gfs_0p25', run_id: 'weather-20260720T00Z',
      cycle: '2026-07-20T00:00Z', resolution_deg: 0.25, tiles: [], fetched_at: times[0]!, cached_tiles: 0, points: 1 }],
  };
  return assembleFindings(options);
}

describe('governingReason: approaching and within', () => {
  const upwind = PROFILE.max_sustained_kt.upwind ?? PROFILE.max_sustained_kt.default;

  it('approaching: the closest margin, clamped to departure', () => {
    const f = assemble([upwind - 3, upwind - 1, upwind - 2], [10, 10, 10]);
    expect(f.verdict.state).toBe('approaching');
    expect(governingReason(f).result).toMatchObject({
      selection: 'closest_margin', status: 'approaching',
      limit: { kind: 'wind', value: upwind, unit: 'kt' },
      statistic: { value: upwind - 1, model: 'gfs_0p25', model_name: 'GFS', run: '2026-07-20T00:00Z', valid_time: times[1] },
      scenarios: null,
      leg: { leg_id: 'L1', index: 0, place: 'Finish' },
      // the 06:00 grid hour approaches too, but the boat leaves at 06:30
      window: { from: '2026-07-20T06:30:00Z' },
    });
  });

  it('approaching without a limit result names the other cause', () => {
    const f = assemble([5, 5, 5], [8, 8, 8]);
    f.verdict.state = 'approaching';
    f.events.push({ kind: 'wind_against_current', leg_id: 'L1', window: { from: times[0]!, to: times[0]! }, refs: ['E9'] });
    expect(governingReason(f)).toMatchObject({
      result: null,
      other: { kind: 'wind_against_current', leg: { leg_id: 'L1' }, window: { from: '2026-07-20T06:30:00Z' }, evidence_id: 'E9' },
    });
  });

  it('within: the smallest margin needs the profile the check used', () => {
    const f = assemble([5, 6, 5], [8, 8, 12]);
    expect(f.verdict.state).toBe('within');
    expect(governingReason(f).result).toBeNull();
    expect(governingReason(f, { profile: { ...PROFILE, max_gust_kt: 99 } }).result).toBeNull();
    const result = governingReason(f, { profile: PROFILE }).result!;
    const windRatio = 6 / upwind;
    const gustRatio = 12 / PROFILE.max_gust_kt;
    expect(result).toMatchObject({
      selection: 'closest_margin', status: 'within', evidence_id: null,
      ...(windRatio >= gustRatio
        ? { limit: { kind: 'wind', value: upwind }, statistic: { value: 6, valid_time: times[1] } }
        : { limit: { kind: 'gust', value: PROFILE.max_gust_kt }, statistic: { value: 12, valid_time: times[2] } }),
    });
  });
});

// Insufficient: GFS 00Z against ECMWF's 06Z run (the live page compared GFS 12Z with ECMWF 06Z).
const HOUR_RANGE = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
function windSpec(layer: string, model: string, cycle: string, offsets: number[], windKt: number): FixtureLayerSpec {
  return {
    layer, model, cycle, resolution_deg: 2.5, pointsPerSide: 4,
    time_axes: { steps: { base: cycle, offsets_h: offsets } },
    variables: [
      { name: 'wind_u_kt', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => windKt },
      { name: 'wind_v_kt', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => 0 },
    ],
    tiles: [[40, -10], [50, -10]],
  };
}

describe('governingReason: insufficient with mismatched run ages', async () => {
  const { findings } = await runAnalysis({
    route: read('../../config/routes/cherbourg-plymouth.json') as Route,
    profile: PROFILE,
    departureUtc: '2026-07-20T08:00:00Z',
    now: () => Date.parse('2026-07-20T07:00:00Z'),
    store: new TileForecastStore({ transport: buildFixtureRun([
      windSpec('weather', 'gfs_0p25', '2026-07-20T00:00Z', HOUR_RANGE(0, 240, 3), 10),
      windSpec('weather-ecmwf', 'ecmwf_ifs_0p25', '2026-07-20T00:00Z', [...HOUR_RANGE(0, 144, 3), ...HOUR_RANGE(150, 240, 6)], 11),
      windSpec('weather-ecmwf-short', 'ecmwf_ifs_0p25', '2026-07-20T06:00Z', HOUR_RANGE(0, 144, 3), 30),
    ]) }),
  });

  it('names each model with its own run, value, spread and the run age gap', () => {
    expect(findings.verdict.state).toBe('insufficient');
    const reason = governingReason(findings, { profile: PROFILE });
    expect(reason.disagreement).toMatchObject({
      evidence_id: expect.stringMatching(/^E\d+$/),
      leg: { leg_id: expect.stringMatching(/^L\d$/) },
      models: [
        { model: 'gfs_0p25', model_name: 'GFS', value_kt: 10, layer: 'weather', run_id: 'weather-20260720T00Z', cycle: '2026-07-20T00:00Z' },
        { model: 'ecmwf_ifs_0p25', model_name: 'ECMWF', value_kt: 30, layer: 'weather-ecmwf-short',
          run_id: 'weather-ecmwf-short-20260720T06Z', cycle: '2026-07-20T06:00Z' },
      ],
      spread_kt: 20,
      run_age_gap_hours: 6,
    });
    const leg = findings.legs.find((l) => l.leg_id === reason.disagreement!.leg.leg_id)!;
    expect(Date.parse(reason.disagreement!.window.from)).toBeGreaterThanOrEqual(Date.parse(leg.enter_range.fast));
    // These wind-only fixture tiles give the point read no wind/gust pair, so no
    // limit result exists; the limits part is covered with the demo below.
    expect(reason.result).toBeNull();
  });

  it('adds the strongest limit result next to the disagreement', () => {
    const f = demo();
    f.verdict = { ...f.verdict, state: 'insufficient', warning_override: { active: false, bulletin_ref: null } };
    f.evidence.push({
      evidence_id: 'E99', rule_id: 'D-DIVERGE-01', model: 'gfs_0p25,ecmwf_ifs_0p25', run: '2026-07-20T12:00Z,2026-07-20T06:00Z',
      leg_id: 'L4', valid_time: '2026-07-20T20:00:00Z', value: { gfs_0p25: 19.5, ecmwf_ifs_0p25: 9.5 }, limit: null,
      units: 'kt spread', source_kind: 'deterministic',
      model_runs: [
        { model: 'gfs_0p25', layer: 'weather', run_id: 'weather-20260720T12Z', cycle: '2026-07-20T12:00Z' },
        { model: 'ecmwf_ifs_0p25', layer: 'weather-ecmwf-short', run_id: 'weather-ecmwf-short-20260720T06Z', cycle: '2026-07-20T06:00Z' },
      ],
    });
    const reason = governingReason(f);
    expect(reason.disagreement).toMatchObject({
      evidence_id: 'E99', leg: { leg_id: 'L4', place: 'Mid-Channel' }, valid_time: '2026-07-20T20:00:00Z',
      window: { from: '2026-07-20T20:00:00Z', to: '2026-07-20T20:00:00Z' }, spread_kt: 10, run_age_gap_hours: 6,
    });
    expect(reason.result).toMatchObject({ selection: 'earliest_exceedance', evidence_id: 'E3' });
  });

  it('recovers per-model runs from forecast_tiles for divergence evidence saved before model_runs', () => {
    const legacy = structuredClone(findings);
    for (const e of legacy.evidence) {
      if (e.rule_id !== 'D-DIVERGE-01') continue;
      delete e.model_runs;
      e.run = '2026-07-20T00:00Z';
    }
    const disagreement = governingReason(legacy).disagreement!;
    expect(disagreement.models.map((m) => m.cycle)).toEqual(['2026-07-20T00:00Z', '2026-07-20T06:00Z']);
    expect(disagreement.run_age_gap_hours).toBe(6);
  });

  it('omits run_age_gap_hours when the compared runs share an init time', () => {
    const same = structuredClone(findings);
    for (const e of same.evidence) {
      for (const run of e.model_runs ?? []) run.cycle = '2026-07-20T00:00Z';
    }
    expect(governingReason(same).disagreement).not.toHaveProperty('run_age_gap_hours');
  });
});
