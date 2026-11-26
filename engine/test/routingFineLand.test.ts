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
import { isLand, seaJoinsPoints, segmentCrossesLand, type RoutingLandMask } from '../src/routing/landmask.js';
import { snapEndsToSea as snapEnds, snapToSea, windowLandMask, type PackedLandMaskMetadata } from '../src/routing/landmaskPack.js';
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
  const { start: from, finish: to } = snapEnds(landMask, start, finish);
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

  it.each([
    ['Cowes to off Brest, in a northerly', { lat: 50.766, lon: -1.298 }, { lat: 48.30, lon: -4.90 }, 0],
    ['Cowes to off Brest, in an easterly', { lat: 50.766, lon: -1.298 }, { lat: 48.30, lon: -4.90 }, 90],
    ['Cowes to off La Coruña, in a northerly', { lat: 50.766, lon: -1.298 }, { lat: 43.55, lon: -8.45 }, 0],
    ['Cowes to Bergen, in an easterly', { lat: 50.766, lon: -1.298 }, { lat: 60.39, lon: 5.32 }, 90],
    ['the Rade de Brest to Lisbon, in a northerly', { lat: 48.36, lon: -4.50 }, { lat: 38.70, lon: -9.15 }, 0],
    ['the Rade de Brest to Bilbao, in a northerly', { lat: 48.36, lon: -4.50 }, { lat: 43.40, lon: -3.00 }, 0],
  ])('a long passage from narrow water computes: %s', (_label, start, finish, fromDeg) => {
    // The outer end patch carries the route from the inner one out past narrow water the main grid
    // of a long passage (0.03° to 0.1°) is too coarse to thread.
    const { landMask, run } = route(start, finish, fromDeg);
    const { route: computed } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    expect(computed.provenance?.routing_request).toMatchObject({ end_resolution_deg: Math.round(1e6 / 480) / 1e6 });
  }, 60_000);

  it('the IJsselmeer stays closed water, said in the fine index’s own words', () => {
    // Closed by its dams: about 31,000 cells of sea, far more than a pocket an end is moved out of.
    const { landMask, from, run } = route({ lat: 52.75, lon: 5.30 }, { lat: 52.98, lon: 4.70 });
    expect(from).toEqual({ lat: 52.75, lon: 5.30 });
    expect(isLand(landMask, from.lat, from.lon)).toBe(false);
    expect(run).toThrow(ClosedWaterError);
    // Owner-approved wording, 2026-11-26.
    const message = (() => { try { run(); return null; } catch (error) { return (error as Error).message; } })();
    expect(message).toBe('No route found: on the outline of the coast the router uses, no open water joins the start and the finish. ' +
      'A channel between them is too narrow for it or dries at low tide. Use Draw my route instead.');
  }, 60_000);

  it('an end in the drying pockets of the Golfe du Morbihan moves out to water joined to the sea', () => {
    const { landMask, from, to, run } = route({ lat: 47.6, lon: -2.8 }, { lat: 47.5, lon: -2.95 });
    expect(seaJoinsPoints(landMask, from, to, false)).toBe(true);
    expect(legsOnLand(landMask, run().route.waypoints)).toEqual([]);
  }, 60_000);

  it('records the fine index on a route it touches, and not on a route outside it', () => {
    const { run } = route({ lat: 50.766, lon: -1.298 }, { lat: 50.76, lon: -1.10 });
    expect(run().route.provenance?.routing_request).toMatchObject({ land_index: 'nweu-20260825T07Z' });
    const gibraltar = route({ lat: 36.0, lon: -6.5 }, { lat: 36.6, lon: -4.4 });
    expect(gibraltar.landMask.kind).toBe('land_mask');
    expect(gibraltar.run().route.provenance?.routing_request).not.toHaveProperty('land_index');
  }, 60_000);

  it.each([
    ['Cork Harbour to Valentia, west of 10°W', { lat: 51.80, lon: -8.30 }, { lat: 51.93, lon: -10.35 }],
    ['Aberdeen to Bergen, north of 60°N', { lat: 57.10, lon: -2.00 }, { lat: 60.39, lon: 5.20 }],
  ])('records no fine index on a route partly outside it: %s', (_label, start, finish) => {
    const { landMask, run } = route(start, finish);
    const { route: computed } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    // Part of it lies in fine cells, part only on the 0.05° outline.
    const fineAt = (p: P) => landMask.kind === 'land_cells' &&
      landMask.fineAt!(Math.round((p.lat - landMask.lat0) / landMask.dlat), Math.round((p.lon - landMask.lon0) / landMask.dlon));
    expect(computed.waypoints.some(fineAt)).toBe(true);
    expect(computed.waypoints.every(fineAt)).toBe(false);
    expect(computed.provenance?.routing_request).not.toHaveProperty('land_index');
  }, 60_000);

  it('Hurst narrows stays closed: the West Solent to the Needles goes round the Isle of Wight', () => {
    const { landMask, run } = route({ lat: 50.72, lon: -1.47 }, { lat: 50.66, lon: -1.62 });
    const { route: computed, distance_nm } = run();
    expect(legsOnLand(landMask, computed.waypoints)).toEqual([]);
    // Through Hurst narrows it is about 7 nm; round the island by Spithead, over 40.
    expect(distance_nm).toBeGreaterThan(40);
  }, 60_000);
});

// Harbour ends the 0.05° outline routes from, whose own water on the fine index is a closed
// pocket of 1 to 231 cells (measured on the nweu tiles, 2026-11-26).
const POCKET_ENDS: Array<[string, P, P]> = [
  ['Cowes to Cherbourg Grande Rade', { lat: 50.766, lon: -1.298 }, { lat: 49.65, lon: -1.62 }],
  ['Plymouth Sound to the Rade de Brest', { lat: 50.35, lon: -4.14 }, { lat: 48.36, lon: -4.50 }],
  ['St Helier to St Peter Port', { lat: 49.17, lon: -2.11 }, { lat: 49.455, lon: -2.53 }],
  ['Poole Harbour to Cherbourg', { lat: 50.69, lon: -1.95 }, { lat: 49.66, lon: -1.62 }],
  ['Lorient to Belle-Île', { lat: 47.71, lon: -3.36 }, { lat: 47.35, lon: -3.15 }],
  ['Cork Harbour to Valentia', { lat: 51.80, lon: -8.30 }, { lat: 51.93, lon: -10.35 }],
  ['Douglas to Liverpool', { lat: 54.15, lon: -4.46 }, { lat: 53.45, lon: -3.05 }],
  ['Den Helder to Terschelling', { lat: 52.97, lon: 4.78 }, { lat: 53.36, lon: 5.22 }],
  ['Arcachon to Bilbao', { lat: 44.66, lon: -1.17 }, { lat: 43.35, lon: -3.03 }],
];

describe('ends in closed pockets of sea on the fine routing index', () => {
  it.each(POCKET_ENDS)('%s: each end moves to the nearest water joined to the other end', (_label, start, finish) => {
    const landMask = routingLandMask(coarse, fine, routeBbox(start, finish));
    const { start: from, finish: to } = snapEnds(landMask, start, finish);
    expect(from && to).toBeTruthy();
    expect(seaJoinsPoints(landMask, from!, to!, false)).toBe(true);
    // Still near the harbour asked for (the Bassin d’Arcachon’s nearest open water is out past its
    // drying banks, 5.7 nm), where the outline snaps the same ends 3 to 14 nm.
    expect(haversineNm(start.lat, start.lon, from!.lat, from!.lon)).toBeLessThan(6);
    expect(haversineNm(finish.lat, finish.lon, to!.lat, to!.lon)).toBeLessThan(6);
  }, 60_000);

  it.each([POCKET_ENDS[0]!, POCKET_ENDS[2]!])('%s computes, every leg off the fine cells', (_label, start, finish) => {
    const { landMask, run } = route(start, finish);
    expect(legsOnLand(landMask, run().route.waypoints)).toEqual([]);
  }, 60_000);

  it('two ends in one pocket stay where they are', () => {
    // Two sea cells of one drying pocket of the Golfe du Morbihan, 181 cells.
    const a = { lat: 47.55520833333333, lon: -2.7531250000000003 };
    const b = { lat: a.lat + 3 / 480, lon: a.lon };
    const landMask = routingLandMask(coarse, fine, routeBbox(a, b));
    expect(isLand(landMask, b.lat, b.lon)).toBe(false);
    expect(snapEnds(landMask, a, b)).toEqual({ start: a, finish: b });
  });

  it('on the 0.05° outline both ends snap exactly as before', () => {
    for (const [, start, finish] of POCKET_ENDS) {
      const landMask = windowLandMask(coarse.bytes, coarse.metadata, routeBbox(start, finish));
      expect(snapEnds(landMask, start, finish)).toEqual({ start: snapToSea(landMask, start), finish: snapToSea(landMask, finish) });
    }
  });
});

// Graph nodes past the window's last cell used to count as sea (the mask simply ends there), and
// routes ran across Devon, the Netherlands and Ireland through them (independent review of 6c5cfda,
// 2026-11-26). Ends snapped as the planner snaps them; a uniform 14 kt wind from the given direction.
const WINDOW_EDGE_CASES: Array<[string, P, P, number]> = [
  ['Cornwall, north round Devon', { lat: 50.2264, lon: -4.7943 }, { lat: 50.6335, lon: -4.7882 }, 270],
  ['the Humber to the Golfe du Lion', { lat: 53.6923, lon: -0.2492 }, { lat: 43.3906, lon: 4.5342 }, 45],
  ['Galway Bay to the Elbe', { lat: 53.1169, lon: -9.7602 }, { lat: 55.0646, lon: 8.4571 }, 180],
  ['Dunkirk to Liverpool Bay', { lat: 51.0426, lon: 2.2517 }, { lat: 53.3029, lon: -3.8657 }, 45],
];
/** Whether `p` lies in one of the window's cells (the cell isLand would read). */
const inWindow = (m: RoutingLandMask, p: P) => {
  const i = Math.round((p.lat - m.lat0) / m.dlat);
  const j = Math.round((p.lon - m.lon0) / m.dlon);
  return i >= 0 && i < m.nlat && j >= 0 && j < m.nlon;
};

describe.each([
  ['the 0.05° outline', (bbox: ReturnType<typeof routeBbox>) => windowLandMask(coarse.bytes, coarse.metadata, bbox)],
  ['the fine routing index', (bbox: ReturnType<typeof routeBbox>) => routingLandMask(coarse, fine, bbox)],
])('on %s, a route never leaves the land window', (_label, windowFor) => {
  it.each(WINDOW_EDGE_CASES)('%s', (_case, start, finish, fromDeg) => {
    const bbox = routeBbox(start, finish);
    const landMask = windowFor(bbox);
    const { start: from, finish: to } = snapEnds(landMask, start, finish);
    const maxHours = passageMaxHours(from!, to!);
    let waypoints: P[] = [];
    try {
      waypoints = computeRoute({
        start: from!, finish: to!, departureUtc: DEPARTURE, polar: POLAR,
        windGrid: uniformWind(bbox, fromDeg, maxHours + 2), landMask, maxHours,
      }).route.waypoints;
    } catch (error) {
      // No route is an answer; a route over land is not.
      expect((error as Error).message).toMatch(/^No route found/);
    }
    expect(waypoints.filter((p) => !inWindow(landMask, p))).toEqual([]);
    expect(legsOnLand(landMask, waypoints)).toEqual([]);
  }, 120_000);
});

describe('where a moved end settles on the fine routing index', () => {
  // Plymouth Sound's nearest open water is a slot one cell wide, open to the south: from there no
  // route could beat out into a southerly. La Rochelle's is the same. A moved end now settles on a
  // cell whose eight neighbours are sea.
  it.each([
    ['Plymouth Sound to the Rade de Brest', { lat: 50.35, lon: -4.14 }, { lat: 48.36, lon: -4.50 }, [150, 180, 210]],
    ['La Rochelle to Les Sables', { lat: 46.15, lon: -1.17 }, { lat: 46.49, lon: -1.79 }, [180, 210]],
  ])('%s computes into the wind, from a cell with room round it', (_label, start, finish, winds) => {
    for (const fromDeg of winds as number[]) {
      const { landMask, from, run } = route(start, finish, fromDeg);
      const i = Math.round((from.lat - landMask.lat0) / landMask.dlat);
      const j = Math.round((from.lon - landMask.lon0) / landMask.dlon);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) expect(isLand(landMask, landMask.lat0 + (i + di) * landMask.dlat, landMask.lon0 + (j + dj) * landMask.dlon)).toBe(false);
      expect(legsOnLand(landMask, run().route.waypoints), `wind ${fromDeg}`).toEqual([]);
    }
  }, 120_000);

  it('two ends in two different pockets: neither moves into the other’s pocket', () => {
    // Poole Harbour west and Poole Quay: two separate pockets of the harbour’s drying water.
    const start = { lat: 50.69, lon: -2.03 };
    const finish = { lat: 50.71, lon: -1.99 };
    const { landMask, from, to, run } = route(start, finish);
    expect(from).not.toEqual(to);
    expect(seaJoinsPoints(landMask, from, to, false)).toBe(true);
    expect(legsOnLand(landMask, run().route.waypoints)).toEqual([]);
  }, 60_000);

  it('an end the sailor put on open sea stays where it is, slot or not', () => {
    // The one-cell slot off Plymouth: open water, but no room round it.
    const slot = { lat: 50.33020833333333, lon: -4.132291666666666 };
    const landMask = routingLandMask(coarse, fine, routeBbox(slot, { lat: 48.36, lon: -4.50 }));
    expect(isLand(landMask, slot.lat, slot.lon)).toBe(false);
    expect(snapEnds(landMask, slot, { lat: 48.36, lon: -4.50 }).start).toEqual(slot);
  });
});
