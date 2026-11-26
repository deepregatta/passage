// Computed routes on the fine routing index (TLI1 nweu, 1/480°) in the product's home waters:
// narrow waters the 0.05° outline closes, and waters the fine index itself keeps closed.
// Every emitted leg must stay off the fine window's blocked cells by the router's exact walk.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { passageMaxHours, routeBbox } from '../src/fetch/liveGrids.js';
import { haversineNm } from '../src/geo.js';
import type { RegionGrid } from '../src/grids.js';
import { ClosedWaterError, computeRoute } from '../src/routing/isochrone.js';
import { decodeLandIndexTile, parseLandIndexManifest } from '../src/routing/landIndex.js';
import { isLand, segmentCrossesLand, type RoutingLandMask } from '../src/routing/landmask.js';
import { snapToSea, type PackedLandMaskMetadata } from '../src/routing/landmaskPack.js';
import { routingLandMask } from '../src/routing/fineLandMask.js';
import { polarFromRelease } from '../src/routing/deepPolars.js';
import { INVENTED_POLAR_ENTRY } from '../scripts/perf/scenarios.js';

type P = { lat: number; lon: number };
const HERE = dirname(fileURLToPath(import.meta.url));
const LAND = join(HERE, '..', '..', 'viewer', 'public', 'data', 'land');
const NWEU = join(LAND, 'nweu-20260825T07Z');
const coarse = {
  bytes: new Uint8Array(gunzipSync(readFileSync(join(LAND, 'global-005.bin.gz')))),
  metadata: JSON.parse(readFileSync(join(LAND, 'global-005.json'), 'utf8')) as PackedLandMaskMetadata,
};
const manifest = parseLandIndexManifest(JSON.parse(readFileSync(join(NWEU, 'manifest.json'), 'utf8')));
const fine = {
  manifest,
  tiles: Object.fromEntries(manifest.coverage.tiles.map((id) =>
    [id, decodeLandIndexTile(new Uint8Array(gunzipSync(readFileSync(join(NWEU, `${id}.bin.gz`)))))])),
};

// The bench's invented cruiser, computed from a formula: no polar data enters this repository.
const POLAR = polarFromRelease(INVENTED_POLAR_ENTRY);
const DEPARTURE = '2026-07-20T06:00:00Z';

/** A uniform 14 kt wind from `fromDeg` over the route box, one value per hour. */
function uniformWind(bbox: ReturnType<typeof routeBbox>, fromDeg: number, hours: number): RegionGrid {
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

/** Route as the planner does: window, snap both ends, compute. */
function route(start: P, finish: P, fromDeg = 250) {
  const bbox = routeBbox(start, finish);
  const landMask = routingLandMask(coarse, fine, bbox);
  const from = snapToSea(landMask, start);
  const to = snapToSea(landMask, finish);
  if (!from || !to) throw new Error('an end has no water near it');
  const maxHours = passageMaxHours(from, to);
  const run = () => computeRoute({
    start: from, finish: to, departureUtc: DEPARTURE, polar: POLAR,
    windGrid: uniformWind(bbox, fromDeg, maxHours + 2), landMask, maxHours,
  });
  return { landMask, from, to, run };
}

const legsOnLand = (landMask: RoutingLandMask, waypoints: P[]) =>
  waypoints.slice(1).filter((point, k) => segmentCrossesLand(landMask, waypoints[k]!, point));

describe('computed routes on the fine routing index', () => {
  it('Cowes to Spithead starts in the Solent, a few hundred metres from the Medina mouth', () => {
    const cowes = { lat: 50.766, lon: -1.298 };
    const { landMask, from, run } = route(cowes, { lat: 50.76, lon: -1.10 });
    expect(haversineNm(cowes.lat, cowes.lon, from.lat, from.lon)).toBeLessThan(0.6);
    const { route: computed } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    expect(computed.waypoints[0]).toMatchObject({ lat: Math.round(from.lat * 1e4) / 1e4, lon: Math.round(from.lon * 1e4) / 1e4 });
    // The main grid finds this one: it is never searched again with end patches.
    expect(computed.provenance?.routing_request).not.toHaveProperty('end_resolution_deg');
  }, 60_000);

  it('Cowes to Cherbourg starts inside the Solent', () => {
    const cowes = { lat: 50.766, lon: -1.298 };
    const { landMask, from, run } = route(cowes, { lat: 49.66, lon: -1.62 });
    expect(haversineNm(cowes.lat, cowes.lon, from.lat, from.lon)).toBeLessThan(0.6);
    const { route: computed } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
  }, 60_000);

  it('beating out of the Rade de Brest needs the end patches, and the route records them', () => {
    const { run } = route({ lat: 48.36, lon: -4.48 }, { lat: 48.42, lon: -5.2 }, 250);
    expect(run().route.provenance?.routing_request).toMatchObject({
      land_index: 'nweu-20260825T07Z', end_resolution_deg: Math.round(1e6 / 480) / 1e6,
    });
  }, 60_000);

  it.each([
    ['Brest roads to Ouessant', { lat: 48.36, lon: -4.48 }, { lat: 48.42, lon: -5.2 }],
    ['Ouessant to Brest roads', { lat: 48.42, lon: -5.2 }, { lat: 48.36, lon: -4.48 }],
  ])('%s computes through the Goulet de Brest', (_label, start, finish) => {
    const { landMask, run } = route(start, finish);
    const { route: computed } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    // The Rade de Brest opens only through the Goulet: some leg crosses 4.56°W between 48.32°N and 48.36°N.
    const throughGoulet = computed.waypoints.slice(1).some((b, k) => {
      const a = computed.waypoints[k]!;
      if ((a.lon - -4.56) * (b.lon - -4.56) > 0) return false;
      const lat = a.lat + ((b.lat - a.lat) * (-4.56 - a.lon)) / (b.lon - a.lon || 1);
      return lat > 48.32 && lat < 48.36;
    });
    expect(throughGoulet).toBe(true);
  }, 60_000);

  it('the Golfe du Morbihan stays closed water, said in the fine index’s own words', () => {
    const { landMask, from, run } = route({ lat: 47.6, lon: -2.8 }, { lat: 47.5, lon: -2.95 });
    expect(isLand(landMask, from.lat, from.lon)).toBe(false);
    expect(run).toThrow(ClosedWaterError);
    // Owner-approved wording, 2026-11-26.
    const message = (() => { try { run(); return null; } catch (error) { return (error as Error).message; } })();
    expect(message).toBe('No route found: on the outline of the coast the router uses, no open water joins the start and the finish. ' +
      'A channel between them is too narrow for it or dries at low tide. Use Draw my route instead.');
  }, 60_000);

  it('records the fine index on a route it touches, and not on a route outside it', () => {
    const { run } = route({ lat: 50.766, lon: -1.298 }, { lat: 50.76, lon: -1.10 });
    expect(run().route.provenance?.routing_request).toMatchObject({ land_index: 'nweu-20260825T07Z' });
    const gibraltar = route({ lat: 36.0, lon: -6.5 }, { lat: 36.6, lon: -4.4 });
    expect(gibraltar.landMask.kind).toBe('land_mask');
    expect(gibraltar.run().route.provenance?.routing_request).not.toHaveProperty('land_index');
  }, 60_000);

  it('Hurst narrows stays closed: the West Solent to the Needles goes round the Isle of Wight', () => {
    const { landMask, run } = route({ lat: 50.72, lon: -1.47 }, { lat: 50.66, lon: -1.62 });
    const { route: computed, distance_nm } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    // Through Hurst narrows it is about 7 nm; round the island by Spithead, over 40.
    expect(distance_nm).toBeGreaterThan(40);
  }, 60_000);
});
