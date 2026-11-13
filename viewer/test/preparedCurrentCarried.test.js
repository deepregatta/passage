// A prepared pointer whose current grid was carried over from an earlier run
// (scripts/upload-prepared-run.py: the CMEMS step produced no grid, the live
// grid was still usable). Its `current_grid` belongs to another run than the
// pointer's own `run_id` and other artifacts. The viewer must load that grid,
// record the GRID's run id and digest, and admit it for routing and the Check
// exactly as it does for a pointer of today's shape.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as engine from '@deepweather/engine';
import { DEPARTURE as departureUtc, auditStore, routingInputs } from './fixtures/routingTiming.js';

const { cachedContentHash, computeRoute, contentHash, runAnalysis, selectRoutingCurrent } = engine;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const gridRun = 'cmems-ibi-20260719T05Z';
// The shared synthetic transport (constant 5 kt boat, 2 kt current along the
// route), with the prepared grid named as a real CMEMS run would be.
const inputs = routingInputs(2);
const grid = () => ({
  ...structuredClone(inputs.currentGrid), run_id: gridRun, generated_at: '2026-07-19T05:00:00Z',
  source: { mode: 'live', dataset_id: 'cmems_mod_ibi_phy_anfc', fetched_at: '2026-07-19T05:12:00Z' },
});
const gridRef = `runs/${gridRun}/current_grid.${'c'.repeat(64)}.json`;
const windRef = `runs/ecmwf-ifs025-20260719T18Z/wind_grid.${'a'.repeat(64)}.json`;
const pointers = {
  // today's shape: fetch-currents succeeded, so the pointer run_id is the CMEMS run
  today: { run_id: gridRun, artifacts: { wind_grid: windRef, current_grid: gridRef } },
  carried: {
    run_id: 'ecmwf-ifs025-20260719T18Z',
    artifacts: { wind_grid: windRef, current_grid: gridRef },
    current_grid_carried_over: { grid_run_id: gridRun, time_axis_end: '2026-07-30T00:00:00Z', reason: 'currents step failed' },
  },
};

const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/profiles/default-limits.json'), 'utf8'));

it.each(Object.keys(pointers))('loads, records and admits the prepared grid of a %s pointer', async (shape) => {
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_FORECAST_BASE_URL', 'https://forecast.test');
  const base = 'https://forecast.test/prepared/';
  const fetchMock = vi.fn(async (url) => {
    if (url === `${base}latest.json`) return new Response(JSON.stringify(pointers[shape]));
    if (url === `${base}${gridRef}`) return new Response(JSON.stringify(grid()));
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { preparedRun } = await import('../src/lib/preparedRun.js');
  const { loadPreparedCurrent } = await import('../src/lib/preparedCurrent.js');

  const { doc } = await preparedRun({ refresh: true });
  const { currentGrid, currentGridProvenance } = await loadPreparedCurrent(doc);
  expect(currentGrid).toEqual(grid());
  const digest = contentHash(grid());
  expect(cachedContentHash(currentGrid)).toBe(digest);
  // The grid's own run and digest, never the pointer's run_id.
  expect(currentGridProvenance).toEqual({
    source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc', run_id: gridRun,
    fetched_at: '2026-07-19T05:12:00Z', artifact_ref: gridRef, content_digest: digest, digest_algorithm: 'fnv1a64',
  });

  // Compute: routing admits the grid and stamps its digest on the route.
  const { start, finish, polar, windGrid, maxHours } = inputs;
  const route = (departure, current, strictCurrent, searchBounds) => computeRoute({
    start, finish, polar, windGrid, resolutionDeg: 0.1, maxHours,
    departureUtc: departure, ...(current ? { currentGrid: current } : {}), ...(strictCurrent ? { strictCurrent } : {}),
    ...(searchBounds ? { searchBounds } : {}),
  });
  const selection = selectRoutingCurrent({ departures: [departureUtc], route, tileGrid: null, prepared: currentGrid, preparedProvenance: currentGridProvenance });
  expect(selection.currentInput.provenance).toMatchObject({ run_id: gridRun, current_source: 'prepared', content_digest: digest });
  const computed = selection.results.get(departureUtc).result.route;
  expect(computed.provenance.routing_request).toMatchObject({ current_source: 'prepared', current_digest: digest });

  // Check: the audit admits the same grid without reading tile currents.
  const store = auditStore(engine, { ...grid(), run_id: 'tile-current', u_kt: Array(24).fill(1) });
  vi.spyOn(store, 'getCurrentGrid');
  const result = await runAnalysis({ route: computed, profile, departureUtc, store, currentGrid, currentGridProvenance });
  expect(store.getCurrentGrid).not.toHaveBeenCalled();
  expect(result.findings.inputs.forecast_tiles.find((x) => x.layer === 'currents')).toMatchObject({
    run_id: gridRun, current_source: 'prepared', content_digest: digest, artifact_ref: gridRef,
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${base}latest.json`, `${base}${gridRef}`]);
});
