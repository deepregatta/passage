// Computed routes through narrow straits on the published coastline outline
// (public/data/land/global-005.*), read through the planner's own loader. Each
// strait was closed by the outline's former plain one-cell growth; the
// topology-preserving growth keeps a one-cell lane through it. Every emitted leg
// must stay off the outline's land cells by the router's exact walk.
import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeRoute, passageMaxHours, routeBbox, segmentCrossesLand, snapToSea } from '@deepweather/engine';
import { clearLandMaskCacheForTests, landMaskForBbox } from '../src/lib/landMask.js';
import { DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const { polar } = routingInputs();

/** A uniform 14 kt wind from `fromDeg` over the route box, one value per hour. */
function uniformWind(bbox, fromDeg, hours) {
  const rad = (fromDeg * Math.PI) / 180;
  const u = Math.round(-14 * Math.sin(rad) * 100) / 100;
  const v = Math.round(-14 * Math.cos(rad) * 100) / 100;
  const lat0 = Math.floor(bbox.minLat) - 1;
  const lon0 = Math.floor(bbox.minLon) - 1;
  const nlat = Math.ceil((bbox.maxLat + 1 - lat0) / 0.25) + 1;
  const nlon = Math.ceil((bbox.maxLon + 1 - lon0) / 0.25) + 1;
  const time_axis = Array.from({ length: hours }, (_, h) =>
    new Date(Date.parse(DEPARTURE) + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const size = hours * nlat * nlon;
  return {
    schema_version: 1, kind: 'wind10m', run_id: 'synthetic-uniform', generated_at: DEPARTURE,
    lat0, lon0, dlat: 0.25, dlon: 0.25, nlat, nlon, time_axis,
    u_kt: Array(size).fill(u), v_kt: Array(size).fill(v), source: { mode: 'synthetic' },
  };
}

const STRAITS = [
  ['Great Belt', { lat: 54.7, lon: 10.9 }, { lat: 55.6, lon: 11.0 }],
  ['Øresund', { lat: 55.55, lon: 12.85 }, { lat: 56.3, lon: 12.3 }],
  ['Strait of Gibraltar', { lat: 36.0, lon: -6.5 }, { lat: 36.6, lon: -4.4 }],
  ['Bab-el-Mandeb', { lat: 12.3, lon: 44.0 }, { lat: 13.3, lon: 42.8 }],
];

// The shared setup replaces fetch before each test with the demo fixtures; serve the
// coastline files from public/ instead. jsdom's Blob has no stream(), which the loader's
// gzip path needs, so Node's Blob stands in. The loader keeps the decoded mask across tests.
const serveCoastline = async (url) => new Response(await readFile(path.join(PUBLIC, String(url))));
beforeAll(() => {
  clearLandMaskCacheForTests();
  vi.stubGlobal('Blob', NodeBlob);
});
beforeEach(() => { globalThis.fetch = serveCoastline; });
afterAll(() => {
  vi.unstubAllGlobals();
  clearLandMaskCacheForTests();
});

describe('computed routes through narrow straits on the published coastline outline', () => {
  it.each(STRAITS)('%s computes, and no leg touches a land cell', async (_name, start, finish) => {
    const bbox = routeBbox(start, finish);
    const landMask = await landMaskForBbox(bbox);
    const from = snapToSea(landMask, start);
    const to = snapToSea(landMask, finish);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    const maxHours = passageMaxHours(from, to);
    const { route } = computeRoute({
      start: from, finish: to, departureUtc: DEPARTURE, polar,
      windGrid: uniformWind(bbox, 250, maxHours + 2), landMask, maxHours,
    });
    const legsOnLand = route.waypoints.slice(1)
      .filter((point, k) => segmentCrossesLand(landMask, route.waypoints[k], point));
    expect(legsOnLand).toEqual([]);
  });
});
