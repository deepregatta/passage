import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { planGribExport, type GribExportRequest } from '../src/export/exportPlan.js';
import { gribExportSourceFromStore, runGribExport, type GribExportFile } from '../src/export/exportGrib.js';
import { buildFixtureRun } from './helpers/fixtureRun.js';
import { readGrib2 } from './helpers/grib2Reader.js';

const repo = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'passage-cli-grib-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const CYCLE = '2026-07-20T00:00Z';
const transport = buildFixtureRun([{
  layer: 'weather',
  model: 'gfs_0p25',
  cycle: CYCLE,
  resolution_deg: 0.25,
  time_axes: { hourly: { base: CYCLE, offsets_h: [0, 1, 2, 3] } },
  variables: [
    { name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: (_m, t, i, j) => 8 + i * 0.1 - j * 0.05 + t },
    { name: 'wind_v_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: (_m, t, i) => -2 + i * 0.02 - t },
    { name: 'gust_kt', axis: 'hourly', dtype: 'i16', scale: 0.1, value: (_m, t) => 14 + t },
  ],
  tiles: [[40, -10], [40, 0]],
}]);

// Lay the run out like the R2 bucket for FsTileTransport.
const tilesDir = join(temp, 'tiles');
mkdirSync(tilesDir, { recursive: true });
writeFileSync(join(tilesDir, 'latest.json'), JSON.stringify(transport.latest));
for (const [runId, manifest] of transport.manifests) {
  mkdirSync(join(tilesDir, 'forecast-runs', runId), { recursive: true });
  writeFileSync(join(tilesDir, 'forecast-runs', runId, 'manifest.json'), JSON.stringify(manifest));
}
for (const [key, bytes] of transport.tiles) {
  const path = join(tilesDir, 'forecast-runs', key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

it('CLI grib writes the same files the engine produces in process, plus summary.json', async () => {
  const out = join(temp, 'out');
  const stdout = execFileSync(process.execPath, [
    '--import', 'tsx', join(repo, 'engine/src/cli.ts'), 'grib',
    '--bbox', '45,46,-1,1', '--datasets', 'wind-gfs,waves-gfs',
    '--from', '2026-07-20T00:30Z', '--to', '2026-07-20T02:00Z', '--step', 'all',
    '--tiles-dir', tilesDir, '--out', out, '--check', '45.4,-0.6;45.9,0.9',
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const name = 'passage-fixture_wind-gfs_20260720T00Z_N45W001_N46E001.grb2';
  expect(readdirSync(out).sort()).toEqual([name, 'summary.json']);
  expect(stdout).toContain(name);

  const request: GribExportRequest = {
    bbox: { minLat: 45, maxLat: 46, minLon: -1, maxLon: 1 },
    datasetIds: ['wind-gfs', 'waves-gfs'],
    startIso: '2026-07-20T00:30Z',
    endIso: '2026-07-20T02:00Z',
    step: 'all',
    lonConvention: '0-360',
    checkpoints: [{ lat: 45.4, lon: -0.6 }, { lat: 45.9, lon: 0.9 }],
    fixture: true,
  };
  const store = new TileForecastStore({ transport });
  await store.init();
  const [expected] = await runGribExport(
    gribExportSourceFromStore(store),
    planGribExport((layer) => store.manifestFor(layer), request),
  );

  const bytes = new Uint8Array(readFileSync(join(out, name)));
  expect(bytes.byteLength).toBe(expected!.bytes);
  const messages = readGrib2(bytes);
  expect(messages.map((m) => m.product.forecastTime)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  expect(messages[0]!.grid).toMatchObject({ la1: 46e6, la2: 45e6, lo1: 359e6, lo2: 1e6 });

  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  expect(summary.source).toEqual({ tiles_dir: tilesDir });
  expect(summary.datasets.map((d: { datasetId: string; availability: string }) => [d.datasetId, d.availability]))
    .toEqual([['wind-gfs', 'ok'], ['waves-gfs', 'no-layer']]);
  const { parts: _parts, ...withoutBytes } = expected as GribExportFile;
  expect(summary.files).toEqual([withoutBytes]);
  expect(summary.files[0].fnv64).toBe(expected!.fnv64);
});

it('CLI grib rejects a malformed request with its usage line', () => {
  expect(() => execFileSync(process.execPath, [
    '--import', 'tsx', join(repo, 'engine/src/cli.ts'), 'grib', '--bbox', '45,46,-1', '--from', CYCLE, '--to', CYCLE,
    '--tiles-dir', tilesDir,
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/Usage: cli grib --bbox/);
});
