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

beforeEach(() => {
  zones = structuredClone(registry);
  runAnalysis.mockReset().mockResolvedValue({});
  persistSnapshot.mockReset().mockResolvedValue('test-snapshot');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const doc = url === '/data/config/route-zones.json' ? zones
      : url === '/data/warnings/latest.json' ? warnings : undefined;
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
