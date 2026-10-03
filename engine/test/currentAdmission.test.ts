import { expect, it, vi } from 'vitest';
import { runAnalysis, GridSampler, scanDepartures } from '../src/index.js';
import type { RegionGrid, Route, LimitsProfile } from '../src/index.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { readFileSync } from 'node:fs';

const departureUtc = '2026-07-20T06:00:00Z';
const profile: LimitsProfile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
const route: Route = { schema_version: 1, route_id: 'med', name: 'Med', mode: 'user',
  waypoints: [{ id: 'a', lat: 40, lon: 3 }, { id: 'b', lat: 40, lon: 3.1 }],
  speeds_kt: { slow: 4, nominal: 5, fast: 6 } };
const grid = (extra: Partial<RegionGrid> = {}): RegionGrid => ({
  schema_version: 1, kind: 'surface_current', run_id: 'tile-current', generated_at: departureUtc,
  lat0: 39, lon0: 2, dlat: 1, dlon: 1, nlat: 3, nlon: 3,
  time_axis: ['2026-07-20T00:00:00Z', '2026-07-30T00:00:00Z'],
  u_kt: Array(18).fill(0), v_kt: Array(18).fill(0), source: { mode: 'live', dataset_id: 'tile-cmems' }, ...extra,
});
function store(current: RegionGrid | null = grid()) {
  const times = Array.from({ length: 241 }, (_, h) => new Date(Date.parse('2026-07-20T00:00Z') + h * 3600_000).toISOString());
  const store = new ScenarioBundleStore({ loadBundle: async name => name === 'forecast' ? { hourly: {
    time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90),
  } } : null });
  vi.spyOn(store, 'getCurrentGrid').mockResolvedValue(current);
  return store;
}
const coverage = (findings: Awaited<ReturnType<typeof runAnalysis>>['findings']) => findings.coverage!.find(x => x.capability === 'tidal_currents')!;

it.each([
  ['outside Channel', { lat0: 49, lon0: -5 }],
  ['expired', { time_axis: ['2026-07-18T00:00Z', '2026-07-19T00:00Z'] }],
  ['all missing', { u_kt: Array(18).fill(null) }],
  ['nonfinite', { u_kt: Array(18).fill(NaN) }],
  ['partly missing', { time_axis: ['2026-07-20T06:00Z', '2026-07-20T07:00Z'] }],
] as Array<[string, Partial<RegionGrid>]>)('replaces %s prepared currents for the whole check', async (_, extra) => {
  const tiles = store();
  const result = await runAnalysis({ route, profile, departureUtc, store: tiles, currentGrid: grid({ run_id: 'prepared', ...extra }) });
  expect(tiles.getCurrentGrid).toHaveBeenCalledOnce();
  expect(result.findings.legs.flatMap(l => l.hours).every(h => h.current !== null)).toBe(true);
  expect(result.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')?.run_id).toBe('tile-current');
});

it('never claims assessment for a zero-sample tile grid', async () => {
  const result = await runAnalysis({ route, profile, departureUtc, store: store(grid({ u_kt: Array(18).fill(null) })) });
  expect(coverage(result.findings).status).toBe('not_assessed');
});
it('reports partial coverage from actual hours without an under-resolution note', async () => {
  const result = await runAnalysis({ route, profile, departureUtc, store: store(grid({ time_axis: ['2026-07-20T06:00Z', '2026-07-20T07:00Z'] })) });
  expect(coverage(result.findings).status).toBe('partially_assessed');
});
it('does not extrapolate a wet boundary cell outside the grid', () => {
  const sample = new GridSampler(grid());
  expect(sample.sample(38.9, 3, Date.parse(departureUtc))).toBeNull();
  expect(sample.sample(40, 1.9, Date.parse(departureUtc))).toBeNull();
  expect(sample.sample(40, 3, Date.parse(departureUtc))).toEqual({ u_kt: 0, v_kt: 0 });
});
it('chooses tile currents once for every scan candidate if any candidate lacks prepared coverage', async () => {
  const tiles = store();
  const scan = await scanDepartures({ route, profile, store: tiles,
    currentGrid: grid({ run_id: 'prepared', time_axis: ['2026-07-20T00:00Z', '2026-07-20T12:00Z'] }),
  }, [departureUtc, '2026-07-21T06:00:00Z']);
  expect(tiles.getCurrentGrid).toHaveBeenCalledOnce();
  expect(scan.input_records?.find(x => x.layer === 'currents')).toMatchObject({ run_id: 'tile-current', current_source: 'tiles' });
});
