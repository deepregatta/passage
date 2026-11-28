// What Compute and the departure comparison get about each end's move to the water the route
// starts from (owner-approved 2026-11-28): the distance, on the real 0.05° outline served from
// public/; the 5 nm cap on the detailed coastline only, with the fine switch on in a test and
// never with it off; and the way-round message in place of the router's generic failure.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeRoute, EndTooFarFromWaterError, WayBeyondSearchError } from '@deepweather/engine';
import { clearLandMaskCacheForTests } from '../src/lib/landMask.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { routeOnOneCurrent } from '../src/lib/scanAction.js';

const switches = vi.hoisted(() => ({ fine: false }));
vi.mock('../src/lib/fineLandSwitch.js', () => ({
  get FINE_LAND_ENABLED() { return switches.fine; },
  FINE_LAND_INDEX: '/data/land/nweu-20260825T07Z',
}));
vi.mock('@deepweather/engine', async (original) => ({
  ...await original(),
  // routing is not what these tests are about: the polar is a stand-in
  polarFromRelease: () => ({ polar_id: 'test' }),
  computeRoute: vi.fn(),
}));

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const NOW = Date.parse('2026-07-20T04:00Z');
const DEPARTURE = '2026-07-20T08:00:00Z';
const store = { getWindGrid: async () => ({ kind: 'wind10m' }), getCurrentGrid: async () => null };
const load = (start, finish) => loadRoutingInputs({
  start: { ...start, name: 'Start' }, finish: { ...finish, name: 'Finish' }, polarId: 'test', departureIso: DEPARTURE, now: () => NOW, store,
});
// great-circle metres, on the engine's earth radius (3440.065 nm)
const metres = (a, b) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h)) * 1852;
};

const COWES = { lat: 50.766, lon: -1.298 };
const CHERBOURG = { lat: 49.645, lon: -1.62 };
const VANNES = { lat: 47.63, lon: -2.76 };
const BELLE_ILE = { lat: 47.30, lon: -3.20 };
const POOLE_WEST = { lat: 50.69, lon: -2.03 };

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
beforeEach(() => {
  switches.fine = false;
  clearLandMaskCacheForTests();
  globalThis.fetch = vi.fn(async (url) => (String(url).startsWith('/api/polars/')
    ? new Response(JSON.stringify({ format: 'deepregatta-polars/1', id: 'test' }))
    : new Response(new Uint8Array(await readFile(path.join(PUBLIC, String(url)))))));
});
afterAll(() => {
  vi.unstubAllGlobals();
  clearLandMaskCacheForTests();
});

describe('each end’s move, as Compute and the comparison get it', () => {
  it('is the distance from the marked point to where the route starts and ends', async () => {
    const inputs = await load(COWES, CHERBOURG);
    expect(inputs.moved.start_m).toBeCloseTo(metres(COWES, inputs.start), 6);
    expect(inputs.moved.finish_m).toBeCloseTo(metres(CHERBOURG, inputs.finish), 6);
    // Cowes on the outline: about 25 km, out of the Solent the outline closes.
    expect(inputs.moved.start_m).toBeGreaterThan(20_000);
  });

  it('is 0 for ends marked on open sea', async () => {
    const inputs = await load({ lat: 50.0, lon: -2.5 }, { lat: 49.8, lon: -3.0 });
    expect(inputs.moved).toEqual({ start_m: 0, finish_m: 0 });
  });
});

describe('the 5 nm cap on the detailed coastline', () => {
  it('never refuses an end with the fine switch off, however far it moves', async () => {
    for (const [start, finish] of [[VANNES, BELLE_ILE], [CHERBOURG, POOLE_WEST]]) {
      const inputs = await load(start, finish);
      expect(Math.max(inputs.moved.start_m, inputs.moved.finish_m) / 1852).toBeGreaterThan(5);
    }
  });

  it('refuses Vannes as a start and Poole Harbour west as a finish with the fine switch on', async () => {
    switches.fine = true;
    await expect(load(VANNES, BELLE_ILE)).rejects.toThrow(new EndTooFarFromWaterError('start'));
    await expect(load(CHERBOURG, POOLE_WEST)).rejects.toThrow(new EndTooFarFromWaterError('finish'));
    await expect(load(VANNES, BELLE_ILE)).rejects.toMatchObject({ code: 'end-too-far' });
    // Cowes moves under a mile on the fine tiles: it computes.
    const inputs = await load(COWES, CHERBOURG);
    expect(inputs.moved.start_m / 1852).toBeLessThan(1);
  }, 60_000);
});

describe('a way by sea beyond the area the router can search', () => {
  // Belize to the Gulf of Fonseca: the outline has no Panama Canal, so the way round is Cape Horn.
  const BELIZE = { lat: 16.400, lon: -88.341 };
  const FONSECA = { lat: 12.207, lon: -87.047 };
  const GENERIC = new Error('No route found within 48 h (wind coverage, land, or no-go conditions)');

  it('is flagged on the inputs of such a passage, and only there', async () => {
    expect((await load(BELIZE, FONSECA)).wayBeyond).toBe(true);
    expect((await load(COWES, CHERBOURG)).wayBeyond).toBe(false);
  }, 60_000);

  it('replaces the router’s generic failure, for Compute and every departure compared', async () => {
    const inputs = await load(BELIZE, FONSECA);
    computeRoute.mockImplementation(() => { throw GENERIC; });
    const departures = [DEPARTURE, '2026-07-20T14:00:00Z'];
    const { results } = routeOnOneCurrent(inputs, departures, 100, null);
    for (const departure of departures) {
      expect(results.get(departure).error).toBeInstanceOf(WayBeyondSearchError);
      expect(results.get(departure).error.message).toBe(
        'No route found: the way by sea between the start and the finish leaves the area the router can search. Use Draw my route instead.');
    }
  }, 60_000);

  it('leaves every other failure and every route as they are', async () => {
    const beyond = await load(BELIZE, FONSECA);
    const other = new Error('No sea node near start/finish');
    computeRoute.mockImplementation(() => { throw other; });
    expect(routeOnOneCurrent(beyond, [DEPARTURE], 100, null).results.get(DEPARTURE).error).toBe(other);
    const found = { route: { waypoints: [] } };
    computeRoute.mockImplementation(() => found);
    expect(routeOnOneCurrent(beyond, [DEPARTURE], 100, null).results.get(DEPARTURE).result).toBe(found);
    // A passage the windows join keeps the generic failure.
    const joined = await load(COWES, CHERBOURG);
    computeRoute.mockImplementation(() => { throw GENERIC; });
    expect(routeOnOneCurrent(joined, [DEPARTURE], 100, null).results.get(DEPARTURE).error).toBe(GENERIC);
  }, 60_000);
});
