import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUtc } from '../src/eta.js';
import {
  cycleHourLabel,
  describeEcmwfRuns,
  newestRunAt,
  newestRunCovering,
  runSpan,
  type RunSpan,
} from '../src/forecast/modelRuns.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { runAnalysis } from '../src/index.js';
import type { LimitsProfile, Route } from '../src/types.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/:00\.000Z$/, 'Z');
const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
/** ECMWF's axes: 00Z/12Z to 240 h, 06Z/18Z to 144 h (forecast-tiles ecmwf_open.py) */
const FULL_AXIS = [...range(0, 144, 3), ...range(150, 240, 6)];
const SHORT_AXIS = range(0, 144, 3);

/** One ECMWF layer: a uniform westerly of `windKt` everywhere, at every step. */
function ecmwfSpec(layer: string, cycle: string, offsets: number[], windKt: number): FixtureLayerSpec {
  return {
    layer,
    model: 'ecmwf_ifs_0p25',
    cycle,
    resolution_deg: 2.5,
    pointsPerSide: 4,
    time_axes: { steps: { base: cycle, offsets_h: offsets } },
    variables: [
      { name: 'wind_u_kt', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => windKt },
      { name: 'wind_v_kt', axis: 'steps', dtype: 'i16', scale: 0.01, value: () => 0 },
    ],
    tiles: [[40, -10], [50, -10]],
  };
}

function gfsSpec(cycle: string, windKt: number): FixtureLayerSpec {
  return { ...ecmwfSpec('weather', cycle, range(0, 240, 3), windKt), model: 'gfs_0p25' };
}

function span(layer: string, cycle: string, hours: number): RunSpan {
  const cycleMs = parseUtc(cycle);
  return { layer, run_id: `${layer}-x`, cycleMs, startMs: cycleMs, endMs: cycleMs + hours * HOUR };
}

describe('newest run per forecast time', () => {
  const full = span('weather-ecmwf', '2026-10-01T00:00Z', 240);
  const short = span('weather-ecmwf-short', '2026-10-01T06:00Z', 144);
  const at = (isoTime: string) => parseUtc(isoTime);

  it('takes the 06Z run to its +144 h, the 00Z run before its cycle and after its end', () => {
    expect(newestRunAt([full, short], at('2026-10-01T05:00Z'))).toBe(0);
    expect(newestRunAt([full, short], at('2026-10-01T06:00Z'))).toBe(1);
    expect(newestRunAt([full, short], at('2026-10-07T06:00Z'))).toBe(1); // 06Z + 144 h
    expect(newestRunAt([full, short], at('2026-10-07T07:00Z'))).toBe(0);
    expect(newestRunAt([full, short], at('2026-10-11T00:00Z'))).toBe(0); // 00Z + 240 h
    expect(newestRunAt([full, short], at('2026-10-11T01:00Z'))).toBe(-1);
    expect(newestRunAt([full, short], at('2026-09-30T23:00Z'))).toBe(-1);
  });

  it('takes a newer 240 h run everywhere it reaches', () => {
    const twelve = span('weather-ecmwf', '2026-10-01T12:00Z', 240);
    expect(newestRunAt([twelve, short], at('2026-10-01T11:00Z'))).toBe(1);
    expect(newestRunAt([twelve, short], at('2026-10-01T12:00Z'))).toBe(0);
    expect(newestRunAt([twelve, short], at('2026-10-03T00:00Z'))).toBe(0);
  });

  it('skips a missing layer and prefers the longer horizon for one cycle', () => {
    expect(newestRunAt([null, short], at('2026-10-02T00:00Z'))).toBe(1);
    const sameCycle = span('weather-ecmwf-short', '2026-10-01T00:00Z', 144);
    expect(newestRunAt([sameCycle, full], at('2026-10-02T00:00Z'))).toBe(1);
  });

  it('picks the newest run covering a whole period for a GRIB file', () => {
    expect(newestRunCovering([full, short], at('2026-10-01T14:00Z'), at('2026-10-04T14:00Z'))).toBe(1);
    expect(newestRunCovering([full, short], at('2026-10-01T14:00Z'), at('2026-10-07T06:00Z'))).toBe(1);
    expect(newestRunCovering([full, short], at('2026-10-01T14:00Z'), at('2026-10-07T07:00Z'))).toBe(0);
    expect(newestRunCovering([full, short], at('2026-10-01T14:00Z'), at('2026-10-12T00:00Z'))).toBe(-1);
  });

  it('reads a span from the manifest axis of the variable', () => {
    const transport = buildFixtureRun([ecmwfSpec('weather-ecmwf-short', '2026-10-01T06:00Z', SHORT_AXIS, 10)]);
    const manifest = transport.manifests.get('weather-ecmwf-short-20261001T06Z')!;
    expect(runSpan(manifest, 'wind_u_kt')).toEqual({
      layer: 'weather-ecmwf-short',
      run_id: 'weather-ecmwf-short-20261001T06Z',
      cycleMs: parseUtc('2026-10-01T06:00Z'),
      startMs: parseUtc('2026-10-01T06:00Z'),
      endMs: parseUtc('2026-10-07T06:00Z'),
    });
    expect(runSpan(manifest, 'gust_kt')).toBeNull();
  });
});

describe('ECMWF run labels', () => {
  const input = (layer: string, cycle: string, served?: Array<[string, string]>) => ({
    layer, cycle, run_id: `${layer}-x`,
    ...(served ? { served: served.map(([from, to]) => ({ from, to })) } : {}),
  });

  it('names the cycle per time range from the newest cycle on', () => {
    expect(describeEcmwfRuns([
      input('weather', '2026-10-01T06:00Z'),
      input('weather-ecmwf', '2026-10-01T00:00Z', [
        ['2026-10-01T00:00Z', '2026-10-01T05:00Z'], ['2026-10-07T07:00Z', '2026-10-09T00:00Z'],
      ]),
      input('weather-ecmwf-short', '2026-10-01T06:00Z', [['2026-10-01T06:00Z', '2026-10-07T06:00Z']]),
    ])).toBe('ECMWF 06Z to +144 h, then 00Z');
  });

  it('names one run when the newest serves every later time', () => {
    expect(describeEcmwfRuns([
      input('weather-ecmwf', '2026-10-01T12:00Z', [['2026-10-01T12:00Z', '2026-10-04T00:00Z']]),
      input('weather-ecmwf-short', '2026-10-01T06:00Z', [['2026-10-01T06:00Z', '2026-10-01T11:00Z']]),
    ])).toBe('ECMWF 12Z');
  });

  it('has no label for a single-run read or an older briefing', () => {
    expect(describeEcmwfRuns([input('weather-ecmwf', '2026-10-01T00:00Z')])).toBeNull();
    expect(describeEcmwfRuns([])).toBeNull();
  });

  it('formats a cycle hour', () => {
    expect(cycleHourLabel('2026-09-30T18:00Z')).toBe('18Z');
  });
});

describe('TileForecastStore hazard reads across ECMWF layers', () => {
  const POINT = { lat: 45, lon: -5 };
  const store = (specs: FixtureLayerSpec[]) => new TileForecastStore({ transport: buildFixtureRun(specs) });

  it('takes the 06Z run to +144 h and the 00Z run around it, and records what each served', async () => {
    const s = store([
      gfsSpec('2026-07-20T00:00Z', 10),
      ecmwfSpec('weather-ecmwf', '2026-07-20T00:00Z', FULL_AXIS, 12),
      ecmwfSpec('weather-ecmwf-short', '2026-07-20T06:00Z', SHORT_AXIS, 20),
    ]);
    // the 144 h seam: 06Z + 144 h = 26 Jul 06:00
    const result = (await s.getHazardForecasts([POINT], parseUtc('2026-07-20T00:00Z'), parseUtc('2026-07-26T12:00Z')))!;
    expect(Object.keys(result.byModel)).toEqual(['gfs_0p25', 'ecmwf_ifs_0p25']);
    const ecmwf = result.byModel.ecmwf_ifs_0p25![0]!;
    const windAt = (time: string) => ecmwf.wind_kt[ecmwf.times.indexOf(time)];
    expect(ecmwf.times[0]).toBe('2026-07-20T00:00:00Z');
    expect(windAt('2026-07-20T05:00:00Z')).toBe(12);
    expect(windAt('2026-07-20T06:00:00Z')).toBe(20);
    expect(windAt('2026-07-26T06:00:00Z')).toBe(20);
    expect(windAt('2026-07-26T07:00:00Z')).toBe(12);
    expect(windAt('2026-07-26T12:00:00Z')).toBe(12);
    expect(ecmwf.wind_dir_deg[ecmwf.times.indexOf('2026-07-26T07:00:00Z')]).toBe(270);

    expect(result.meta.map((m) => [m.layer, m.run_id, m.served])).toEqual([
      ['weather', 'weather-20260720T00Z', undefined],
      ['weather-ecmwf', 'weather-ecmwf-20260720T00Z', [
        { from: '2026-07-20T00:00:00Z', to: '2026-07-20T05:00:00Z' },
        { from: '2026-07-26T07:00:00Z', to: '2026-07-26T12:00:00Z' },
      ]],
      ['weather-ecmwf-short', 'weather-ecmwf-short-20260720T06Z', [
        { from: '2026-07-20T06:00:00Z', to: '2026-07-26T06:00:00Z' },
      ]],
    ]);
    expect(describeEcmwfRuns(result.meta as unknown as Array<Record<string, unknown>>))
      .toBe('ECMWF 06Z to +144 h, then 00Z');
  });

  it('takes a newer 240 h run from its cycle on and the older 06Z run only before it', async () => {
    const s = store([
      gfsSpec('2026-07-20T12:00Z', 10),
      ecmwfSpec('weather-ecmwf', '2026-07-20T12:00Z', FULL_AXIS, 12),
      ecmwfSpec('weather-ecmwf-short', '2026-07-20T06:00Z', SHORT_AXIS, 20),
    ]);
    const result = (await s.getHazardForecasts([POINT], parseUtc('2026-07-20T00:00Z'), parseUtc('2026-07-23T00:00Z')))!;
    const ecmwf = result.byModel.ecmwf_ifs_0p25![0]!;
    expect(ecmwf.wind_kt.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(ecmwf.wind_kt[6]).toBe(20); // 06:00, before the 12Z cycle
    expect(ecmwf.wind_kt[11]).toBe(20);
    expect(ecmwf.wind_kt.slice(12).every((v) => v === 12)).toBe(true);
    expect(result.meta.find((m) => m.layer === 'weather-ecmwf-short')!.served).toEqual([
      { from: '2026-07-20T06:00:00Z', to: '2026-07-20T11:00:00Z' },
    ]);
    expect(describeEcmwfRuns(result.meta as unknown as Array<Record<string, unknown>>)).toBe('ECMWF 12Z');
  });

  it('does not read a run that serves no hour of the window', async () => {
    const transport = buildFixtureRun([
      gfsSpec('2026-07-20T12:00Z', 10),
      ecmwfSpec('weather-ecmwf', '2026-07-20T12:00Z', FULL_AXIS, 12),
      ecmwfSpec('weather-ecmwf-short', '2026-07-20T06:00Z', SHORT_AXIS, 20),
    ]);
    const fetched: string[] = [];
    const fetchTile = transport.fetchTile.bind(transport);
    transport.fetchTile = async (runId, path, options) => {
      fetched.push(runId);
      return fetchTile(runId, path, options);
    };
    const s = new TileForecastStore({ transport });
    const result = (await s.getHazardForecasts([POINT], parseUtc('2026-07-21T00:00Z'), parseUtc('2026-07-22T00:00Z')))!;
    expect(fetched).not.toContain('weather-ecmwf-short-20260720T06Z');
    expect(result.meta.map((m) => m.layer)).toEqual(['weather', 'weather-ecmwf']);
    expect(result.meta[1]!.served).toEqual([{ from: '2026-07-21T00:00:00Z', to: '2026-07-22T00:00:00Z' }]);
  });

  it('reads the short layer alone, as a single run, when the 240 h layer is missing', async () => {
    const s = store([
      gfsSpec('2026-07-20T06:00Z', 10),
      ecmwfSpec('weather-ecmwf-short', '2026-07-20T06:00Z', SHORT_AXIS, 20),
    ]);
    const result = (await s.getHazardForecasts([POINT], parseUtc('2026-07-20T06:00Z'), parseUtc('2026-07-21T00:00Z')))!;
    expect(result.byModel.ecmwf_ifs_0p25![0]!.wind_kt.every((v) => v === 20)).toBe(true);
    expect(result.meta[1]).toMatchObject({ layer: 'weather-ecmwf-short' });
    expect(result.meta[1]).not.toHaveProperty('served');
  });
});

describe('analysis with ECMWF 06Z/18Z runs', () => {
  const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const options = {
    route: read('../../config/routes/cherbourg-plymouth.json') as Route,
    profile: read('../../config/profiles/default-limits.json') as LimitsProfile,
    departureUtc: '2026-07-20T08:00:00Z',
    now: () => Date.parse('2026-07-20T07:00:00Z'),
  };
  const analyse = (specs: FixtureLayerSpec[]) =>
    runAnalysis({ ...options, store: new TileForecastStore({ transport: buildFixtureRun(specs) }) });

  it('compares models on the newest ECMWF run and records each run with its share', async () => {
    const base = [gfsSpec('2026-07-20T00:00Z', 10), ecmwfSpec('weather-ecmwf', '2026-07-20T00:00Z', FULL_AXIS, 11)];
    const agreeing = await analyse(base);
    expect(agreeing.findings.legs.some((leg) => leg.divergent_hours?.length)).toBe(false);

    // the 06Z run, 20 kt stronger than GFS, serves every hour on the passage
    const { findings } = await analyse([...base, ecmwfSpec('weather-ecmwf-short', '2026-07-20T06:00Z', SHORT_AXIS, 30)]);
    const divergent = findings.legs.flatMap((leg) => leg.divergent_hours ?? []);
    expect(divergent.length).toBeGreaterThan(0);
    expect(divergent.every((hour) => hour.values.ecmwf_ifs_0p25 === 30 && hour.spread_kt === 20)).toBe(true);
    expect(findings.events.some((event) => event.kind === 'model_divergence')).toBe(true);

    const ecmwfInputs = findings.inputs.forecast_tiles.filter((m) => String(m.layer).startsWith('weather-ecmwf'));
    expect(ecmwfInputs.map((m) => [m.layer, m.run_id])).toEqual([
      ['weather-ecmwf', 'weather-ecmwf-20260720T00Z'],
      ['weather-ecmwf-short', 'weather-ecmwf-short-20260720T06Z'],
    ]);
    expect(ecmwfInputs[0]!.served).toEqual([{ from: '2026-07-20T00:00:00Z', to: '2026-07-20T05:00:00Z' }]);
    expect(describeEcmwfRuns(findings.inputs.forecast_tiles)).toBe('ECMWF 06Z');
    expect(findings.snapshot_id).not.toBe(agreeing.findings.snapshot_id);
  });
});

it('keeps the ECMWF axes in step with forecast-tiles', () => {
  expect(FULL_AXIS).toHaveLength(65);
  expect(SHORT_AXIS).toEqual(FULL_AXIS.slice(0, 49));
  expect(iso(parseUtc('2026-07-20T06:00Z') + 144 * HOUR)).toBe('2026-07-26T06:00Z');
});
