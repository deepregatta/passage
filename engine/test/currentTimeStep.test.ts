/**
 * The current grid's time step a check records on its `currents` input record
 * (`time_step_h`), read from the time axis of the frozen grid the audit sampled,
 * never from the dataset id; and what recording it does not change: the decision
 * inputs and every identity derived from them.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleAudit, assembleFindings, type AssembleOptions } from '../src/findings.js';
import { gridTimeStepHours, type RegionGrid } from '../src/grids.js';
import { contentHash } from '../src/hash.js';
import { decisionInputs } from '../src/identity.js';
import { runAnalysis } from '../src/analyze.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import type { Findings, LimitsProfile, Route } from '../src/types.js';

const read = <T>(path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const HOUR = 3_600_000;
const DEPARTURE = '2026-07-20T06:00:00Z';
const IBI_PT1H = 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m';

const axis = (start: string, hours: number[]) => hours.map((h) => new Date(Date.parse(start) + h * HOUR).toISOString());

function grid(time_axis: string[], dataset_id: string | null = IBI_PT1H, mode: RegionGrid['source']['mode'] = 'live'): RegionGrid {
  const nlat = 3, nlon = 4;
  const size = nlat * nlon * time_axis.length;
  return {
    schema_version: 1, kind: 'surface_current', run_id: 'cmems-ibi-20260719T19Z', generated_at: '2026-07-19T19:30:00Z',
    lat0: 49.5, lon0: -2.2, dlat: 0.2, dlon: 0.2, nlat, nlon, time_axis,
    u_kt: Array.from({ length: size }, (_, i) => Math.round(Math.sin(i / 9) * 100) / 100),
    v_kt: Array.from({ length: size }, () => 0.3),
    source: { mode, dataset_id, resolution_deg: 0.2, fetched_at: '2026-07-19T19:20:00Z' },
  };
}

/** A one-leg check off Cap de la Hague on the given current grid, as a prepared artifact. */
function options(currentGrid: RegionGrid, provenance: Record<string, unknown> = {}): AssembleOptions {
  const route = read<Route>('../../config/routes/cherbourg-plymouth.json');
  route.waypoints = route.waypoints.slice(1, 3);
  const profile = read<LimitsProfile>('../../config/profiles/default-limits.json');
  const times = axis('2026-07-20T05:00:00Z', [0, 1, 2, 3, 4]);
  return {
    route, profile, departureUtc: DEPARTURE, nowMs: 1, engineVersion: 'test', requestMeta: [],
    legForecasts: [{ lat: 49.75, lon: -1.94, times, wind_kt: times.map(() => 12), gust_kt: times.map(() => 16), wind_dir_deg: times.map(() => 250) }],
    currentGrid,
    currentProvenance: { source: 'prepared-artifact', layer: 'currents', model: currentGrid.source.dataset_id, run_id: currentGrid.run_id,
      current_source: 'prepared', content_digest: contentHash(currentGrid), digest_algorithm: 'fnv1a64', ...provenance },
  };
}

const currentsRecord = (findings: Findings) => findings.inputs.forecast_tiles.find((item) => item.layer === 'currents')!;

describe('gridTimeStepHours: the largest interval of the whole axis', () => {
  it('reads hourly, 3-hourly, 6-hourly and sub-hourly axes', () => {
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 1, 2, 3]) })).toBe(1);
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 3, 6, 9]) })).toBe(3);
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 6, 12]) })).toBe(6);
    expect(gridTimeStepHours({ time_axis: ['2026-07-20T06:00:00Z', '2026-07-20T06:15:00Z', '2026-07-20T06:30:00Z'] })).toBe(0.25);
  });

  it('an irregular axis records its largest interval, wherever it lies', () => {
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 1, 2, 5, 6]) })).toBe(3);
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18]) })).toBe(6);
  });

  it('is null when no step can be determined', () => {
    expect(gridTimeStepHours({ time_axis: [DEPARTURE] })).toBeNull();
    expect(gridTimeStepHours({ time_axis: [] })).toBeNull();
    expect(gridTimeStepHours({ time_axis: [DEPARTURE, 'not a time'] })).toBeNull();
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 1, 1, 2]) })).toBeNull();
    expect(gridTimeStepHours({ time_axis: axis(DEPARTURE, [0, 2, 1]) })).toBeNull();
    expect(gridTimeStepHours({} as RegionGrid)).toBeNull();
  });
});

describe('a check records the time step of the grid it sampled', () => {
  it('an hourly prepared grid: 1', () => {
    expect(currentsRecord(assembleFindings(options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8]))))).time_step_h).toBe(1);
  });

  it('a 3-hourly grid that keeps its hourly-sounding dataset id (the factory thins large areas): 3, not 1', () => {
    const thinned = grid(axis('2026-07-20T03:00:00Z', [0, 3, 6, 9]));
    const record = currentsRecord(assembleFindings(options(thinned)));
    expect(record.model).toBe(IBI_PT1H);
    expect(record.time_step_h).toBe(3);
  });

  it('an irregular axis: its largest interval', () => {
    expect(currentsRecord(assembleFindings(options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 6, 7, 8]))))).time_step_h).toBe(3);
  });

  it('a single-time grid: null, recorded explicitly', () => {
    const record = currentsRecord(assembleFindings(options(grid([DEPARTURE]))));
    expect(record).toHaveProperty('time_step_h', null);
  });

  it('comes from the grid only: a provenance carrying its own step cannot set it', () => {
    const findings = assembleFindings(options(grid(axis('2026-07-20T03:00:00Z', [0, 3, 6, 9])), { time_step_h: 1 }));
    expect(currentsRecord(findings).time_step_h).toBe(3);
  });

  it('the 6-hourly tile mosaic an action reads when no prepared grid covers it: 6', async () => {
    const departureUtc = '2026-07-20T00:00:00Z';
    const tileGrid: RegionGrid = { ...grid(axis(departureUtc, [0, 6, 12, 18, 24, 30, 36, 42, 48]), 'cmems_glo12 tiles (currents-20260720T00Z)'),
      lat0: 48, lon0: -6, dlat: 0.5, dlon: 0.5, nlat: 8, nlon: 12 };
    tileGrid.u_kt = Array(8 * 12 * 9).fill(0.4);
    tileGrid.v_kt = Array(8 * 12 * 9).fill(0.1);
    const times = Array.from({ length: 97 }, (_, h) => new Date(Date.parse(departureUtc) + h * HOUR).toISOString().slice(0, 16));
    const store = new ScenarioBundleStore({ loadBundle: async (name) => name === 'forecast' ? {
      hourly: { time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90) },
    } : null });
    store.getCurrentGrid = async () => tileGrid;
    const route = read<Route>('../../config/routes/cherbourg-plymouth.json');
    route.waypoints = route.waypoints.slice(0, 3);
    const { findings } = await runAnalysis({ route, profile: read<LimitsProfile>('../../config/profiles/default-limits.json'), departureUtc, store });
    const record = currentsRecord(findings);
    expect(record.current_source).toBe('tiles');
    expect(record.time_step_h).toBe(6);
  });

  it('a check without a current grid records no step', () => {
    const opts = options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2])));
    delete opts.currentGrid;
    opts.currentProvenance = { source: 'tiles', current_source: 'tiles' };
    const record = currentsRecord(assembleFindings(opts));
    expect(record.available).toBe(false);
    expect(record).not.toHaveProperty('time_step_h');
  });
});

describe('recording the step changes no identity', () => {
  it('the decision inputs and their hash do not contain or depend on the recorded step', () => {
    const opts = options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8])));
    const { findings, decisionInputs: inputs } = assembleAudit(opts, { savedIdentity: true });
    expect(JSON.stringify(inputs)).not.toContain('time_step_h');
    expect(findings.decision_hash).toBe(contentHash(decisionInputs(opts)));
    expect(findings.snapshot_id).toBe(`snapshot_v2_${findings.decision_hash}`);
  });

  it('two checks of the same inputs produce the same identity and the same record', () => {
    const a = assembleFindings(options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8]))));
    const b = assembleFindings({ ...options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8]))), nowMs: 99_999 });
    expect(b.snapshot_id).toBe(a.snapshot_id);
    expect(b.decision_hash).toBe(a.decision_hash);
    expect(b.route_revision).toBe(a.route_revision);
    expect(currentsRecord(b)).toEqual(currentsRecord(a));
  });

  it('a grid with another time axis is another decision (it already was, through the frozen grid)', () => {
    const hourly = assembleFindings(options(grid(axis('2026-07-20T03:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))));
    const thinned = assembleFindings(options(grid(axis('2026-07-20T03:00:00Z', [0, 3, 6, 9]))));
    expect(thinned.snapshot_id).not.toBe(hourly.snapshot_id);
  });
});

describe('findings schema: the step is optional and additive', () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(read('../../contracts/findings.schema.json'));
  const findings = assembleFindings(options(grid(axis('2026-07-20T04:00:00Z', [0, 1, 2, 3, 4, 5, 6, 7, 8]))));

  it('validates a new record, a record without the step (older checks) and a null step', () => {
    expect(validate(findings), JSON.stringify(validate.errors)).toBe(true);
    const older = structuredClone(findings);
    delete currentsRecord(older).time_step_h;
    expect(validate(older), JSON.stringify(validate.errors)).toBe(true);
    const unknown = structuredClone(findings);
    currentsRecord(unknown).time_step_h = null;
    expect(validate(unknown), JSON.stringify(validate.errors)).toBe(true);
  });

  it('refuses a step that is not a positive number', () => {
    for (const bad of [0, -1, '1']) {
      const broken = structuredClone(findings);
      currentsRecord(broken).time_step_h = bad;
      expect(validate(broken), String(bad)).toBe(false);
    }
  });
});
