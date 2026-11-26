// The planner's coastline loader and the fine routing index (TLI1 nweu, pinned in
// public/data/land/nweu-20260825T07Z/): off by default, so routes keep the 0.05° outline;
// when on, only the tiles a window needs are fetched, each checked against the manifest's
// size and checksum, and any failure falls back to the outline, never to sea.
import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeRoute, passageMaxHours, routeBbox, segmentCrossesLand, snapToSea,
} from '@deepweather/engine';
import {
  clearLandMaskCacheForTests, FINE_LAND_ENABLED, FINE_LAND_INDEX, landMaskForBbox,
} from '../src/lib/landMask.js';
import { DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const solent = { minLat: 50.5, maxLat: 51, minLon: -1.6, maxLon: -0.9 };
const gibraltar = { minLat: 35.5, maxLat: 36.5, minLon: -6.5, maxLon: -5 };

let requested = [];
/** Serves public/ like the Pages build, with `tamper(url, bytes)` able to change or refuse a file. */
function serve(tamper = (_url, bytes) => bytes) {
  globalThis.fetch = vi.fn(async (url) => {
    requested.push(String(url));
    const bytes = tamper(String(url), new Uint8Array(await readFile(path.join(PUBLIC, String(url)))));
    return bytes ? new Response(bytes) : new Response('', { status: 404 });
  });
}
/** Great-circle distance in nautical miles. */
const haversineNm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
};
const fineRequests = () => requested.filter((url) => url.startsWith(FINE_LAND_INDEX));

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
beforeEach(() => {
  clearLandMaskCacheForTests();
  requested = [];
  serve();
});
afterAll(() => {
  vi.unstubAllGlobals();
  clearLandMaskCacheForTests();
});

describe('the fine routing index in the planner', () => {
  it('is off: routes keep the 0.05° outline and nothing of the index is fetched', async () => {
    expect(FINE_LAND_ENABLED).toBe(false);
    const mask = await landMaskForBbox(solent);
    expect(mask.kind).toBe('land_mask');
    expect(mask.dlat).toBe(0.05);
    expect(fineRequests()).toEqual([]);
  });

  it('is the pinned copy the shared-contracts lock records', () => {
    const lock = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../contracts/shared-contracts.lock.json'), 'utf8'));
    const pinned = lock.artifacts.map((row) => row.path).filter((p) => p.startsWith(`viewer/public${FINE_LAND_INDEX}/`));
    expect(pinned.map((p) => path.basename(p)).sort())
      .toEqual(['N40E000.bin.gz', 'N40W010.bin.gz', 'N50E000.bin.gz', 'N50W010.bin.gz', 'manifest.json']);
  });

  it('when on, fetches the manifest and only the tiles the window needs, once', async () => {
    const mask = await landMaskForBbox(solent, { fine: true });
    expect(mask.kind).toBe('land_cells');
    expect(mask.fine_index_id).toBe('nweu-20260825T07Z');
    expect(mask.dlat).toBe(1 / 480);
    expect(fineRequests().sort()).toEqual([`${FINE_LAND_INDEX}/N50W010.bin.gz`, `${FINE_LAND_INDEX}/manifest.json`]);
    await landMaskForBbox({ ...solent, minLon: -1.5 }, { fine: true });
    expect(fineRequests()).toHaveLength(2);
  });

  it('when on, a window no fine tile reaches is the outline window, with no tile fetched', async () => {
    const mask = await landMaskForBbox(gibraltar, { fine: true });
    expect(mask.kind).toBe('land_mask');
    expect(fineRequests().filter((url) => url.endsWith('.bin.gz'))).toEqual([]);
  });

  it.each([
    ['a tile whose bytes differ from the manifest', (url, bytes) => {
      if (!url.endsWith('N50W010.bin.gz')) return bytes;
      const changed = bytes.slice();
      changed[100] ^= 1;
      return changed;
    }],
    ['a missing tile', (url, bytes) => (url.endsWith('N50W010.bin.gz') ? null : bytes)],
    ['a missing manifest', (url, bytes) => (url.endsWith(`${FINE_LAND_INDEX}/manifest.json`) ? null : bytes)],
    ['a manifest of another version', (url, bytes) => {
      if (!url.endsWith(`${FINE_LAND_INDEX}/manifest.json`)) return bytes;
      const doc = JSON.parse(new TextDecoder().decode(bytes));
      return new TextEncoder().encode(JSON.stringify({ ...doc, schema_version: 2 }));
    }],
  ])('when on, %s falls back to the outline, and the next route tries again', async (_label, tamper) => {
    serve(tamper);
    const fallback = await landMaskForBbox(solent, { fine: true });
    expect(fallback.kind).toBe('land_mask');
    expect(fallback.dlat).toBe(0.05);
    serve();
    const fine = await landMaskForBbox(solent, { fine: true });
    expect(fine.kind).toBe('land_cells');
  });

  it('when on, Cowes to Cherbourg computes from inside the Solent, every leg off the fine cells', async () => {
    const cowes = { lat: 50.766, lon: -1.298 };
    const cherbourg = { lat: 49.66, lon: -1.62 };
    const bbox = routeBbox(cowes, cherbourg);
    const landMask = await landMaskForBbox(bbox, { fine: true });
    const outline = await landMaskForBbox(bbox, { fine: false });
    const from = snapToSea(landMask, cowes);
    const to = snapToSea(landMask, cherbourg);
    expect(haversineNm(cowes.lat, cowes.lon, from.lat, from.lon)).toBeLessThan(0.6);
    // The outline snaps the same start miles out of the Solent.
    const outlineFrom = snapToSea(outline, cowes);
    expect(haversineNm(cowes.lat, cowes.lon, outlineFrom.lat, outlineFrom.lon)).toBeGreaterThan(5);
    const maxHours = passageMaxHours(from, to);
    const hours = maxHours + 2;
    const lat0 = Math.floor(bbox.minLat) - 1;
    const lon0 = Math.floor(bbox.minLon) - 1;
    const nlat = Math.ceil((bbox.maxLat + 1 - lat0) / 0.25) + 1;
    const nlon = Math.ceil((bbox.maxLon + 1 - lon0) / 0.25) + 1;
    const windGrid = {
      schema_version: 1, kind: 'wind10m', run_id: 'synthetic-uniform', generated_at: DEPARTURE,
      lat0, lon0, dlat: 0.25, dlon: 0.25, nlat, nlon,
      time_axis: Array.from({ length: hours }, (_, h) =>
        new Date(Date.parse(DEPARTURE) + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')),
      // 14 kt from 250°.
      u_kt: Array(hours * nlat * nlon).fill(13.16), v_kt: Array(hours * nlat * nlon).fill(4.79),
      source: { mode: 'synthetic' },
    };
    const { route } = computeRoute({
      start: from, finish: to, departureUtc: DEPARTURE, polar: routingInputs().polar, windGrid, landMask, maxHours,
    });
    const onLand = route.waypoints.slice(1).filter((point, k) => segmentCrossesLand(landMask, route.waypoints[k], point));
    expect(onLand).toEqual([]);
  }, 60_000);
});
