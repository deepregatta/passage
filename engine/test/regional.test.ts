import { describe, it, expect, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { gunzip } from '../src/forecast/httpTransport.js';
import { decodeTile } from '../src/forecast/tileCodec.js';
import { tileIdFor, tilesForBbox, edgeNeighbourProbes } from '../src/forecast/tileMath.js';
import { regionalAdmission, regionalTileBudget } from '../src/forecast/regional.js';
import { nextForecastRuns } from '../src/briefing.js';
import { planGribExport } from '../src/export/exportPlan.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';

const cycle = '2026-07-20T00:00Z', start = Date.parse(cycle), end = start + 3_600_000;
function fixture() {
  const spec: FixtureLayerSpec = {layer: 'weather', model: 'gfs_0p25', cycle, resolution_deg: 2.5,
    time_axes: {hourly: {base: cycle, offsets_h: [0,1,2]}}, tiles: [[40,-10],[45,-10],[40,-5],[45,-5]], pointsPerSide: 2,
    variables: [{name:'wind_u_kt',axis:'hourly',dtype:'i16',scale:0.01,value:()=>10},
      {name:'wind_v_kt',axis:'hourly',dtype:'i16',scale:0.01,value:()=>0},
      {name:'gust_kt',axis:'hourly',dtype:'i16',scale:0.1,statistic:{kind:'max',window_h:[null,1,1]},value:(_m,t)=>t===0?NaN:20}]};
  const transport = buildFixtureRun([spec,{...spec,layer:'weather-arome',model:'arome',variables:spec.variables.map(v=>v.name==='wind_u_kt'?{...v,value:()=>30}:v)}]);
  const entry = transport.latest.layers['weather-arome']!;
  delete transport.latest.layers['weather-arome'];
  const regional = {schema_version:1,updated_at:cycle,layers:{'weather-arome':entry}};
  const fetchRegionalLatest = vi.fn(async()=>regional);
  const combined = Object.assign(transport,{fetchRegionalLatest});
  const manifest = transport.manifests.get(entry.run_id)!;
  manifest.tiling.tile_deg=5;
  manifest.coverage={minLat:40,maxLat:47.5,minLon:-10,maxLon:-2.5};
  manifest.served_grid={lat0:40,lon0:-10,dlat:2.5,dlon:2.5,nlat:4,nlon:4};
  manifest.capabilities=['wind','gust']; manifest.attribution='Météo-France AROME via Open-Meteo';
  for (const [id,tile] of Object.entries(manifest.tiles)) {
    const data=gunzipSync(transport.tiles.get(`${entry.run_id}/${manifest.tiling.path_template.replace('{tile_id}',id)}`)!);
    tile.uncompressed_bytes=data.length; tile.decoded_bytes=Object.values(decodeTile(data).arrays).reduce((n,v)=>n+v.byteLength,0);
  }
  return {transport:combined,manifest,regional};
}

describe('regional geometry and catalogues',()=>{
  it('looks up 5/10 degree boundaries independently',()=>{
    expect(tileIdFor(47,-2,5)).toBe('N45W005'); expect(tileIdFor(47,-2)).toBe('N40W010');
    expect(tilesForBbox({minLat:44,maxLat:46,minLon:-6,maxLon:-4},5)).toEqual(['N40W010','N40W005','N45W010','N45W005']);
    expect(edgeNeighbourProbes(null,44.99,-5.01,0.025,5).map(p=>p.tileId)).toContain('N45W005');
  });
  it('does no regional I/O without explicit opt-in; GFS stays the point source',async()=>{
    const {transport}=fixture(); const store=new TileForecastStore({transport}); await store.init();
    expect(transport.fetchRegionalLatest).not.toHaveBeenCalled(); expect(store.describe()['weather-arome']).toBeUndefined();
    const read=await store.getPointForecasts([{lat:40,lon:-10}],start,end); expect(read.forecasts[0]!.wind_kt[0]).toBe(10);
  });
  it('serves regional comparisons, preserves unavailable hazards and reuses decoded tiles',async()=>{
    const {transport}=fixture(); const fetch=vi.spyOn(transport,'fetchTile');
    const store=new TileForecastStore({transport,regionalLayers:['weather-arome']});
    const first=await store.getHazardForecasts([{lat:45,lon:-5}],start,end);
    expect(first!.byModel.arome![0]!.wind_kt).toEqual([30,30]);
    expect(first!.byModel.arome![0]!.visibility_m).toEqual([]);
    const count=fetch.mock.calls.length; await store.getHazardForecasts([{lat:45,lon:-5}],start,end);
    expect(fetch.mock.calls).toHaveLength(count);
    expect(nextForecastRuns({'weather-arome':{...store.describe()['weather-arome']!,cadence_hours:6}},cycle)).toEqual([]);
  });
  it('shares the 20 MiB transfer allowance across all selected models before loading', async () => {
    const {transport, manifest, regional} = fixture();
    const other = structuredClone(manifest);
    other.run_id = manifest.run_id.replace('weather-arome', 'weather-icon-eu');
    other.layer = 'weather-icon-eu'; other.model = 'icon';
    transport.manifests.set(other.run_id, other);
    Object.assign(regional.layers, {'weather-icon-eu': {...regional.layers['weather-arome'], run_id: other.run_id}});
    for (const m of [manifest, other]) for (const tile of Object.values(m.tiles)) tile.bytes = 6 * 1024 * 1024;
    const fetch = vi.spyOn(transport, 'fetchTile');
    const store = new TileForecastStore({transport, regionalLayers: ['weather-arome', 'weather-icon-eu']});
    // The two near-edge tiles fit individually (12 MiB), but together exceed 20 MiB.
    await store.getHazardForecasts([{lat: 44.9, lon: -10}], start, end);
    expect(fetch.mock.calls.some(([id]) => id.startsWith('weather-icon-eu-'))).toBe(false);
    expect(fetch.mock.calls.some(([id]) => id.startsWith('weather-arome-'))).toBe(true);
  });
  it.each([{name: 'retained', cache: 45, arome: 10, icon: 10, inflated: 0},
    {name: 'transient', cache: 64, arome: 6, icon: 8, inflated: 24}])('keeps combined automatic comparisons within $name capacity before downloads', async ({cache, arome, icon, inflated}) => {
    const {transport, manifest, regional} = fixture();
    const other = structuredClone(manifest);
    other.run_id = manifest.run_id.replace('weather-arome', 'weather-icon-eu');
    other.layer = 'weather-icon-eu'; other.model = 'icon';
    transport.manifests.set(other.run_id, other);
    Object.assign(regional.layers, {'weather-icon-eu': {...regional.layers['weather-arome'], run_id: other.run_id}});
    for (const [key, bytes] of [...transport.tiles]) if (key.startsWith(manifest.run_id + '/')) {
      transport.tiles.set(key.replace(manifest.run_id, other.run_id), bytes);
    }
    // Each model fits alone; their retained or transient combination does not.
    for (const m of [manifest, other]) for (const tile of Object.values(m.tiles)) {
      tile.decoded_bytes = (m === manifest ? arome : icon) * 1024 * 1024;
      if (m === other && inflated) tile.uncompressed_bytes = inflated * 1024 * 1024;
    }
    const fetch = vi.spyOn(transport, 'fetchTile');
    const store = new TileForecastStore({transport, regionalLayers: ['weather-arome', 'weather-icon-eu'], maxDecodedBytes: cache * 1024 * 1024});
    const first = await store.getHazardForecasts([{lat: 42.5, lon: -7.5}], start, end);
    expect(first!.byModel.arome).toBeDefined();
    expect(fetch.mock.calls.some(([id]) => id.startsWith('weather-icon-eu-'))).toBe(false);
    const count = fetch.mock.calls.length;
    await store.getHazardForecasts([{lat: 42.5, lon: -7.5}], start, end);
    expect(fetch.mock.calls).toHaveLength(count);
    expect(first!.byModel.gfs_0p25![0]!.wind_kt).toEqual([10, 10]);
  });
  it('regional outages and disable remove regional selection while root stays usable',async()=>{
    const {transport,regional}=fixture(); const store=new TileForecastStore({transport,regionalLayers:['weather-arome']});
    await store.init(); expect(store.manifestFor('weather-arome')).not.toBeNull();
    regional.layers={} as typeof regional.layers; await store.refresh();
    expect(store.manifestFor('weather-arome')).toBeNull(); expect(store.manifestFor('weather')).not.toBeNull();
    transport.fetchRegionalLatest.mockRejectedValue(new Error('outage')); await store.refresh();
    expect(store.describe().weather).toBeDefined();
  });
  it('named wind mosaics cross 5 degree lines and never fall back outside coverage',async()=>{
    const {transport}=fixture(); const store=new TileForecastStore({transport,regionalLayers:['weather-arome']});
    const grid=await store.getRegionalWindGrid('weather-arome',{minLat:42.5,maxLat:45,minLon:-7.5,maxLon:-5},cycle,1);
    expect(grid.run_id).toContain('weather-arome'); expect(grid.u_kt.every(v=>v===30)).toBe(true);
    await expect(store.getRegionalWindGrid('weather-arome',{minLat:30,maxLat:31,minLon:-7,maxLon:-6},cycle,1)).rejects.toThrow('cover');
  });
});

describe('regional admission and export',()=>{
  it.each(['weather-arome', 'weather-icon-eu', 'weather-ukv'])('exports %s to its own horizon for Full forecast', (layer) => {
    const manifest = structuredClone(fixture().manifest);
    manifest.layer = layer;
    const datasetId = layer.replace('weather-', 'wind-');
    const request = {
      bbox: {minLat: 42.5, maxLat: 45, minLon: -7.5, maxLon: -5},
      datasetIds: [datasetId], startIso: cycle, endIso: '2026-07-20T06:00Z',
      step: 'all' as const, lonConvention: '0-360' as const,
    };
    const plan = (overrides = {}) => planGribExport({[layer]: manifest}, {...request, ...overrides}).datasets[0]!;
    expect(plan().availability).toBe('outside-horizon');
    const full = plan({extent: 'full'});
    expect(full.availability).toBe('ok');
    expect(full.steps.map(step => step.forecastHours)).toEqual([0, 1, 2]);
    expect(plan({extent: 'full', startIso: '2026-07-20T03:00Z'}).availability).toBe('outside-horizon');
    expect(plan({extent: 'full', bbox: {...request.bbox, minLat: 30}}).availability).toBe('no-tiles');
    for (const tile of Object.values(manifest.tiles)) tile.bytes = 9 * 1024 * 1024;
    expect(plan({extent: 'full'}).availability).toBe('too-large');
  });

  it('refuses excessive tile/transfer budgets before downloading and outside horizons',()=>{
    const {manifest}=fixture(), tile=Object.values(manifest.tiles)[0]!;
    tile.bytes=9*1024*1024; expect(()=>regionalTileBudget(tile)).toThrow('budget');
    for(const value of Object.values(manifest.tiles)) value.bytes=6*1024*1024;
    expect(()=>regionalAdmission(manifest,[{lat:40,lon:-10},{lat:45,lon:-10},{lat:40,lon:-5},{lat:45,lon:-5}],start,end)).toThrow('20 MiB');
    expect(()=>regionalAdmission(manifest,[],start,end+10*3_600_000)).toThrow('period');
  });
  it('bounds inflate and decoded allocations',async()=>{
    const bytes=new Uint8Array(gzipSync(new Uint8Array(10000)));
    await expect(gunzip(bytes,100)).rejects.toThrow('decompression budget');
    const {transport,manifest}=fixture(), id=Object.keys(manifest.tiles)[0]!;
    const raw=gunzipSync(transport.tiles.get(`${manifest.run_id}/${manifest.tiling.path_template.replace('{tile_id}',id)}`)!);
    expect(()=>decodeTile(raw,10)).toThrow('decoded budget');
  });
  it('plans regional GRIB tiles at 5 degrees and keeps one-hour gust windows',()=>{
    const {manifest}=fixture();
    const plan=planGribExport({'weather-arome':manifest},{bbox:{minLat:42.5,maxLat:45,minLon:-7.5,maxLon:-5},datasetIds:['wind-arome'],startIso:cycle,endIso:'2026-07-20T01:00Z',step:'all',lonConvention:'0-360'});
    expect(plan.datasets[0]!.tiles.filter(t=>t.present).map(t=>t.id)).toHaveLength(4);
    expect(plan.datasets[0]!.windowsH[2]).toEqual([null,1]);
    expect(plan.datasets[0]!.spec.attribution).toContain('Météo-France');
  });
});

it('keeps root GRIB planning usable when an optional regional model exceeds memory or tile budgets', () => {
  const {transport, manifest} = fixture();
  manifest.resolution_deg = 0.01;
  const request = {bbox: {minLat: 40, maxLat: 47.5, minLon: -10, maxLon: -2.5},
    datasetIds: ['wind-gfs', 'wind-arome'] as const, startIso: cycle,
    endIso: '2026-07-20T01:00Z', step: 'all' as const, lonConvention: '0-360' as const};
  const plan = planGribExport({weather: transport.manifests.get(transport.latest.layers.weather!.run_id)!,
    'weather-arome': manifest}, {...request, datasetIds: [...request.datasetIds]});
  expect(plan.datasets.find(d => d.datasetId === 'wind-gfs')!.availability).toBe('ok');
  expect(plan.datasets.find(d => d.datasetId === 'wind-arome')!.availability).toBe('too-large');
});
