import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { runAnalysis, persistSnapshot } from '@deepweather/engine';
import { analyzeInBrowser } from '../src/lib/browserAnalysis.js';

vi.mock('@deepweather/engine', () => ({ runAnalysis: vi.fn(), persistSnapshot: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({}) }));
vi.mock('../src/lib/localSnapshots.js', () => ({ localSnapshots: {} }));
vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: async () => ({ doc: null }) }));

const registry = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/route-zones.json'), 'utf8'));
const expected = {
  'cherbourg-plymouth-v1': ['casquets', 'hague-barfleur', 'portland', 'plymouth'],
  'newport-newyork-v1': ['rhode-island-sound', 'block-island-sound', 'moriches-montauk', 'fire-island-moriches', 'sandy-hook-fire-island', 'new-york-harbor'],
  'palma-barcelona-v1': ['costa-sur-de-mallorca', 'costa-sierra-tramontana', 'costa-litoral-de-barcelona'],
  'brisbane-gladstone-v1': ['moreton-bay', 'sunshine-coast-waters', 'kgari-coast', 'capricornia-coast'],
};
const warnings = { bulletins: [{ zone_id: 'casquets' }, { zone_id: 'other-zone' }] };
let zones;
let tideIndex;
let tideFiles;
const gates = { gates: [{ gate_id: 'channel-gate', reference_port: 'cherbourg' }] };

beforeEach(() => {
  zones = structuredClone(registry);
  tideIndex = { schema_version: 1, routes: { 'cherbourg-plymouth-v1': 'channel.json' } };
  tideFiles = { 'channel.json': { source: { mode: 'synthetic' }, ports: [{ port_id: 'cherbourg' }] } };
  runAnalysis.mockReset().mockResolvedValue({});
  persistSnapshot.mockReset().mockResolvedValue('test-snapshot');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const doc = url === '/data/config/route-zones.json' ? zones
      : url === '/data/warnings/latest.json' ? warnings
      : url === '/data/tides/index.json' ? tideIndex
      : url === '/data/config/gates.json' ? gates
      : url.startsWith('/data/tides/') ? tideFiles[url.slice('/data/tides/'.length)] : undefined;
    return { ok: doc !== undefined, json: async () => doc };
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function analyze(route) {
  await analyzeInBrowser({ route, profile: {}, departureUtc: '2026-07-20T06:00:00Z' });
  return runAnalysis.mock.calls[0][0];
}

it('covers every registered route', () => {
  expect(Object.keys(expected).sort()).toEqual(Object.keys(registry.routes).sort());
});

for (const [route_id, ids] of Object.entries(expected)) {
  it(`${route_id} uses its own regional zones`, async () => {
    const input = await analyze({ route_id, mode: 'fixed' });
    expect(input.warnings.routeZoneIds).toEqual(ids);
  });
}

it.each(['fixed', 'computed'])('does not use all bulletins for an unmapped %s route', async (mode) => {
  const input = await analyze({ route_id: 'unmapped', mode });
  expect(input.warnings.routeZoneIds).toEqual([]);
});

it('keeps the conservative fallback for user-drawn routes', async () => {
  const input = await analyze({ route_id: 'my-passage-2wp', mode: 'user' });
  expect(input.warnings.routeZoneIds).toEqual(['casquets', 'other-zone']);
});

it('respects an explicitly empty mapping even for a user route', async () => {
  zones.routes['my-passage-2wp'] = { uk_zones: [] };
  const input = await analyze({ route_id: 'my-passage-2wp', mode: 'user' });
  expect(input.warnings.routeZoneIds).toEqual([]);
});

it('a missing zone registry does not turn a fixed route into a user route', async () => {
  zones = undefined;
  const input = await analyze({ route_id: 'newport-newyork-v1', mode: 'fixed' });
  expect(input.warnings.routeZoneIds).toEqual([]);
});

it.each(Object.keys(expected))('%s only requests its mapped tide artifact', async (route_id) => {
  const input = await analyze({ route_id, mode: 'fixed' });
  if (route_id === 'cherbourg-plymouth-v1') {
    expect(input.tides).toEqual(tideFiles['channel.json']);
    expect(input.gates).toEqual(gates.gates);
  } else {
    expect(fetch).not.toHaveBeenCalledWith('/data/tides/channel.json');
    expect(input.tides).toBeUndefined();
    expect(input.gates).toBeUndefined();
  }
});

it.each(['missing-index', 'missing-file'])('%s leaves tides unassessed', async (missing) => {
  if (missing === 'missing-index') tideIndex = undefined;
  else tideFiles = {};
  const input = await analyze({ route_id: 'cherbourg-plymouth-v1', mode: 'fixed' });
  expect(input.tides).toBeUndefined();
  expect(input.gates).toBeUndefined();
});

it('loads a published US tide artifact without Channel gate definitions', async () => {
  tideIndex.routes['newport-newyork-v1'] = 'newport-newyork.json';
  tideFiles['newport-newyork.json'] = { source: { mode: 'live' }, ports: [{ port_id: 'newport' }] };
  const input = await analyze({ route_id: 'newport-newyork-v1', mode: 'fixed' });
  expect(input.tides).toEqual(tideFiles['newport-newyork.json']);
  expect(input.gates).toBeUndefined();
  expect(fetch).not.toHaveBeenCalledWith('/data/tides/channel.json');
});

it('reports tidal_gates not_assessed in real findings when the route has no tide artifact', async () => {
  const { runAnalysis: realAnalysis, ScenarioBundleStore } = await vi.importActual('@deepweather/engine');
  const route = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/routes/newport-newyork.json'), 'utf8'));
  const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/profiles/default-limits.json'), 'utf8'));
  const store = new ScenarioBundleStore({
    loadBundle: async (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../engine/test/fixtures/scenarios/calm/${name}.json`), 'utf8')),
  });
  runAnalysis.mockImplementation((options) => realAnalysis({ ...options, warnings: undefined, store }));
  const { result } = await analyzeInBrowser({ route, profile, departureUtc: '2026-07-20T06:00:00Z' });
  expect(result.findings.coverage.find((item) => item.capability === 'tidal_gates').status).toBe('not_assessed');
  expect(result.snapshotInputs.tides).toBeUndefined();
});
