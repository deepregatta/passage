import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { tileIdFor, edgeNeighbourProbes } from '../src/forecast/tileMath.js';
import { decodeTile } from '../src/forecast/tileCodec.js';
import { planGribExport } from '../src/export/exportPlan.js';
import { runGribExport, gribExportSourceFromStore } from '../src/export/exportGrib.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';
import { readGrib2 } from './helpers/grib2Reader.js';
import { concat } from './helpers/gribFixtures.js';

const cycle = '2026-07-20T00:00Z', start = Date.parse(cycle), end = start + 3600_000;
function fixture(hole = false) {
  const base: FixtureLayerSpec = {layer: 'weather', model: 'gfs_0p25', cycle, resolution_deg: 0.5,
    time_axes: {hourly: {base: cycle, offsets_h: [0, 1]}}, tiles: [[40, -10]], pointsPerSide: 20,
    variables: [{name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 10},
      {name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 0},
      {name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: () => 20}]};
  const transport = buildFixtureRun([base, {...base, layer: 'weather-ukv', model: 'ukv',
    tiles: [[48,-6],[48,-3],[51,-6],[51,-3]], pointsPerSide: 6,
    variables: base.variables.map(v => v.name === 'wind_u_kt' ? {...v, value: (_m,_t,i,j,g) =>
      hole && g.lat0 === 51 && g.lon0 === -3 && i === 0 && j === 0 ? NaN : 30} : v)}]);
  const entry = transport.latest.layers['weather-ukv']!;
  delete transport.latest.layers['weather-ukv'];
  const manifest = transport.manifests.get(entry.run_id)!;
  manifest.tiling.tile_deg = 3;
  manifest.coverage = {minLat: 48, maxLat: 53.5, minLon: -6, maxLon: -0.5};
  manifest.served_grid = {lat0: 48, lon0: -6, dlat: 0.5, dlon: 0.5, nlat: 12, nlon: 12};
  manifest.capabilities = ['wind','gust'];
  manifest.attribution = 'British Crown copyright, Met Office UKV via Open-Meteo; CC BY-SA 4.0';
  for (const [id, tile] of Object.entries(manifest.tiles)) {
    const bytes = transport.tiles.get(`${entry.run_id}/${manifest.tiling.path_template.replace('{tile_id}', id)}`)!;
    const data = gunzipSync(bytes);
    tile.uncompressed_bytes = data.length;
    tile.decoded_bytes = Object.values(decodeTile(data).arrays).reduce((n, values) => n + values.byteLength, 0);
  }
  return {transport: Object.assign(transport, {fetchRegionalLatest: async () =>
    ({schema_version: 1, updated_at: cycle, layers: {'weather-ukv': entry}})}), manifest};
}

describe('opt-in UKV 3 degree delivery', () => {
  it('uses integer corner ids and reads across three-degree boundaries', async () => {
    expect(tileIdFor(50.99, -3.01, 3)).toBe('N48W006');
    expect(tileIdFor(51, -3, 3)).toBe('N51W003');
    expect(edgeNeighbourProbes(null, 50.99, -3.01, 0.025, 3).map(p => p.tileId)).toContain('N51W003');
    const {transport} = fixture();
    const store = new TileForecastStore({transport, regionalLayers: ['weather-ukv']});
    const bbox = {minLat: 50.5, maxLat: 51, minLon: -3.5, maxLon: -3};
    const grid = await store.getRegionalWindGrid('weather-ukv', bbox, cycle, 1);
    expect(grid.u_kt.every(v => v === 30)).toBe(true);
    const read = await store.getHazardForecasts([{lat: 49, lon: -4}], start, end);
    expect(read!.byModel.ukv![0]!.gust_kt).toEqual([20,20]);
    expect((await store.getPointForecasts([{lat: 49, lon: -4}], start, end)).forecasts[0]!.wind_kt[0]).toBe(10);
  });
  it('rejects masked corner cells rather than using the root wind', async () => {
    const {transport} = fixture(true);
    const store = new TileForecastStore({transport, regionalLayers: ['weather-ukv']});
    await expect(store.getRegionalWindGrid('weather-ukv',
      {minLat: 50.5, maxLat: 51, minLon: -3.5, maxLon: -3}, cycle, 1)).rejects.toThrow();
  });
  it('exports initial gust at 10m with template 4.0 and centre 74', async () => {
    const {transport, manifest} = fixture();
    const store = new TileForecastStore({transport, regionalLayers: ['weather-ukv']});
    const plan = planGribExport({'weather-ukv': manifest}, {
      bbox: {minLat: 49, maxLat: 49.5, minLon: -4, maxLon: -3.5}, datasetIds: ['wind-ukv'],
      startIso: cycle, endIso: '2026-07-20T01:00Z', step: 'all', lonConvention: '0-360'});
    const files = await runGribExport(gribExportSourceFromStore(store), plan);
    const messages = readGrib2(concat(files[0]!.parts));
    const gust = messages.filter(m => m.product.number === 22);
    expect(gust.map(m => m.product.forecastTime)).toEqual([0,1]);
    expect(gust.every(m => m.centre === 74 && m.product.template === 0 &&
      m.product.levelType === 103 && m.product.levelValue === 10 && !m.product.statistic)).toBe(true);
    expect(gust.every(m => [...m.values].every(v => Number.isFinite(v)))).toBe(true);
  });
});
