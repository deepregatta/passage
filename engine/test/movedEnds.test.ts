// How far each end of a computed passage moves to the water the router starts from, and the
// cap on that move on the fine routing index (owner-approved 2026-11-28): the planner shows a
// move over 200 m, and on the detailed coastline refuses one over 5 nm. On the real 0.05°
// outline and the pinned nweu fine tiles.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { routeBbox, type RouteBbox } from '../src/fetch/liveGrids.js';
import { haversineNm } from '../src/geo.js';
import { decodeLandIndexTile, parseLandIndexManifest } from '../src/routing/landIndex.js';
import { routingLandMask } from '../src/routing/fineLandMask.js';
import {
  END_MOVE_SHOWN_M, EndTooFarFromWaterError, FINE_END_MOVE_CAP_NM, snapEndsToSea, windowLandMask, type PackedLandMaskMetadata,
} from '../src/routing/landmaskPack.js';
import { WayBeyondSearchError, routingWindow } from '../src/routing/routingWindow.js';

type P = { lat: number; lon: number };
const HERE = dirname(fileURLToPath(import.meta.url));
const LAND = join(HERE, '..', '..', 'viewer', 'public', 'data', 'land');
const coarse = {
  bytes: new Uint8Array(gunzipSync(readFileSync(join(LAND, 'global-005.bin.gz')))),
  metadata: JSON.parse(readFileSync(join(LAND, 'global-005.json'), 'utf8')) as PackedLandMaskMetadata,
};
const outline = (bbox: RouteBbox) => windowLandMask(coarse.bytes, coarse.metadata, bbox);
const NWEU = join(LAND, 'nweu-20260825T07Z');
const manifest = parseLandIndexManifest(JSON.parse(readFileSync(join(NWEU, 'manifest.json'), 'utf8')));
const fine = {
  manifest,
  tiles: Object.fromEntries(manifest.coverage.tiles.map((id) =>
    [id, decodeLandIndexTile(new Uint8Array(gunzipSync(readFileSync(join(NWEU, `${id}.bin.gz`)))))])),
};
const fineWindow = (bbox: RouteBbox) => routingLandMask(coarse, fine, bbox);
const metres = (a: P, b: P) => haversineNm(a.lat, a.lon, b.lat, b.lon) * 1852;

const COWES = { lat: 50.766, lon: -1.298 };
const CHERBOURG = { lat: 49.645, lon: -1.62 };
const VANNES = { lat: 47.63, lon: -2.76 };
const BELLE_ILE = { lat: 47.30, lon: -3.20 };
const POOLE_WEST = { lat: 50.69, lon: -2.03 };

describe('the distance each end moves', () => {
  it('is the great-circle distance from the point asked to the water the route starts from', () => {
    const snapped = snapEndsToSea(outline(routeBbox(COWES, CHERBOURG)), COWES, CHERBOURG);
    expect(snapped.moved_m.start).toBeCloseTo(metres(COWES, snapped.start!), 6);
    expect(snapped.moved_m.finish).toBeCloseTo(metres(CHERBOURG, snapped.finish!), 6);
    // Cowes on the outline: about 25 km, out of the Solent the outline closes.
    expect(snapped.moved_m.start).toBeGreaterThan(20_000);
    expect(snapped.moved_m.finish).toBeGreaterThan(END_MOVE_SHOWN_M);
  });

  it('is 0 for an end on open sea', () => {
    const start = { lat: 50.0, lon: -2.5 };
    const finish = { lat: 49.8, lon: -3.0 };
    for (const mask of [outline(routeBbox(start, finish)), fineWindow(routeBbox(start, finish))]) {
      const snapped = snapEndsToSea(mask, start, finish);
      expect(snapped.moved_m).toEqual({ start: 0, finish: 0 });
      expect(snapped.beyond_cap).toBeNull();
    }
  });

  it('is null for an end with no water in reach', () => {
    const inland = { lat: 47.0, lon: 2.0 };
    const snapped = snapEndsToSea(outline(routeBbox(inland, BELLE_ILE)), inland, BELLE_ILE);
    expect(snapped.start).toBeNull();
    expect(snapped.moved_m.start).toBeNull();
  });
});

describe('the cap on a move, on the detailed coastline only', () => {
  it('is 5 nm', () => {
    expect(FINE_END_MOVE_CAP_NM).toBe(5);
  });

  it('refuses Vannes as a start and Poole Harbour west as a finish on the fine tiles', () => {
    const vannes = snapEndsToSea(fineWindow(routeBbox(VANNES, BELLE_ILE)), VANNES, BELLE_ILE);
    expect(vannes.moved_m.start! / 1852).toBeGreaterThan(FINE_END_MOVE_CAP_NM);
    expect(vannes.beyond_cap).toBe('start');
    const poole = snapEndsToSea(fineWindow(routeBbox(CHERBOURG, POOLE_WEST)), CHERBOURG, POOLE_WEST);
    expect(poole.moved_m.finish! / 1852).toBeGreaterThan(FINE_END_MOVE_CAP_NM);
    expect(poole.beyond_cap).toBe('finish');
  });

  it('keeps a move under the cap on the fine tiles: Cowes moves under a nautical mile', () => {
    const cowes = snapEndsToSea(fineWindow(routeBbox(COWES, CHERBOURG)), COWES, CHERBOURG);
    expect(cowes.moved_m.start!).toBeGreaterThan(END_MOVE_SHOWN_M);
    expect(cowes.moved_m.start! / 1852).toBeLessThan(1);
    expect(cowes.beyond_cap).toBeNull();
  });

  it('never applies on the 0.05° outline, however far the end moves', () => {
    for (const [start, finish] of [[VANNES, BELLE_ILE], [COWES, CHERBOURG], [CHERBOURG, POOLE_WEST]] as const) {
      const snapped = snapEndsToSea(outline(routeBbox(start, finish)), start, finish);
      expect(Math.max(snapped.moved_m.start!, snapped.moved_m.finish!) / 1852).toBeGreaterThan(FINE_END_MOVE_CAP_NM);
      expect(snapped.beyond_cap).toBeNull();
    }
  });

  it('says which end, in the approved words', () => {
    const start = new EndTooFarFromWaterError('start');
    expect(start.code).toBe('end-too-far');
    expect(start.end).toBe('start');
    expect(start.message).toBe('No open water within 5 nm of the start on the detailed coastline. Mark a start at sea, or use Draw my route.');
    expect(new EndTooFarFromWaterError('finish').message)
      .toBe('No open water within 5 nm of the finish on the detailed coastline. Mark a finish at sea, or use Draw my route.');
  });
});

describe('a way by sea beyond the area the router can search', () => {
  it('is flagged when no larger window joins the ends or proves them apart', async () => {
    // Belize to the Gulf of Fonseca: the outline has no Panama Canal, so the way round is Cape Horn.
    const start = { lat: 16.400, lon: -88.341 };
    const finish = { lat: 12.207, lon: -87.047 };
    const bbox = routeBbox(start, finish);
    const landMask = outline(bbox);
    const snapped = snapEndsToSea(landMask, start, finish);
    const window = await routingWindow({ bbox, landMask, start: snapped.start!, finish: snapped.finish!, maxHours: 48, maskFor: outline });
    expect(window.grownDeg).toBe(0);
    expect(window.wayBeyond).toBe(true);
  }, 120_000);

  it('is not flagged for a route box that joins the ends, a larger window that does, or closed water', async () => {
    const cases: Array<[P, P]> = [
      [{ lat: 50.0, lon: -2.5 }, { lat: 49.8, lon: -3.0 }], // open Channel
      [{ lat: 50.15, lon: -5.05 }, { lat: 50.56, lon: -4.95 }], // Falmouth to Padstow, round Land's End
      [{ lat: 37.6046, lon: 26.6509 }, { lat: 42.564, lon: 27.8637 }], // the Aegean to the Black Sea: closed on the outline
    ];
    for (const [start, finish] of cases) {
      const bbox = routeBbox(start, finish);
      const landMask = outline(bbox);
      const snapped = snapEndsToSea(landMask, start, finish);
      const window = await routingWindow({ bbox, landMask, start: snapped.start!, finish: snapped.finish!, maxHours: 48, maskFor: outline });
      expect(window.wayBeyond).toBe(false);
    }
  }, 120_000);

  it('says so in the approved words, with Draw my route as the way on', () => {
    const error = new WayBeyondSearchError();
    expect(error.code).toBe('way-beyond-search');
    expect(error.message).toBe('No route found: the way by sea between the start and the finish leaves the area the router can search. Use Draw my route instead.');
  });
});
