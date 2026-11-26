// The planner's coastline loader and the fine routing index (TLI1 nweu, pinned in
// public/data/land/nweu-20260825T07Z/): off by default, so routes keep the 0.05° outline;
// when on, only the tiles a window needs are fetched, each checked against the manifest's
// size and checksum, and any failure falls back to the outline, never to sea.
import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import {
  computeRoute, passageMaxHours, routeBbox, segmentCrossesLand, snapEndsToSea, snapToSea,
} from '@deepweather/engine';
import RouteSourceNotes from '../src/pages/planner/RouteSourceNotes.jsx';

// routingLandMask is the engine's own, unless a test makes it throw.
const engine = vi.hoisted(() => ({ routingLandMask: null }));
vi.mock('@deepweather/engine', async (importOriginal) => {
  const original = await importOriginal();
  engine.routingLandMask = vi.fn(original.routingLandMask);
  return { ...original, routingLandMask: (...args) => engine.routingLandMask(...args) };
});
import {
  clearLandMaskCacheForTests, FINE_LAND_ENABLED, FINE_LAND_INDEX, FINE_STALL_PAUSE_MS, landMaskForBbox,
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
afterEach(cleanup);
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

  it.each([
    ['the manifest', `${FINE_LAND_INDEX}/manifest.json`],
    ['a tile', `${FINE_LAND_INDEX}/N50W010.bin.gz`],
  ])('when on, %s that never answers falls back to the outline in time, and is not kept', async (_label, stalled) => {
    const answer = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => (String(url) === stalled ? new Promise(() => {}) : answer(url, init)));
    const started = Date.now();
    const fallback = await landMaskForBbox(solent, { fine: true, timeoutMs: 50 });
    expect(fallback.kind).toBe('land_mask');
    expect(Date.now() - started).toBeLessThan(2000);
    // The stalled request was aborted, not left running.
    const call = globalThis.fetch.mock.calls.find(([url]) => String(url) === stalled);
    expect(call[1]?.signal?.aborted).toBe(true);
    // After the pause a stall earns, the next route tries the fine index again.
    serve();
    vi.spyOn(Date, 'now').mockReturnValue(started + FINE_STALL_PAUSE_MS + 60_000);
    expect((await landMaskForBbox(solent, { fine: true, timeoutMs: 50 })).kind).toBe('land_cells');
    vi.mocked(Date.now).mockRestore();
  });

  it('when on, one deadline covers the whole fine load: a slow manifest leaves the tiles only what is left', async () => {
    const answer = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url) === `${FINE_LAND_INDEX}/manifest.json`) return new Promise((resolve) => setTimeout(() => resolve(answer(url, init)), 300));
      if (String(url).startsWith(FINE_LAND_INDEX)) return new Promise(() => {});
      return answer(url, init);
    });
    const started = Date.now();
    expect((await landMaskForBbox(solent, { fine: true, timeoutMs: 400 })).kind).toBe('land_mask');
    // A deadline per file would wait 300 ms for the manifest, then 400 ms more for the tile.
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('when on, after a stall the next routes go straight to the outline for a while, fetching nothing', async () => {
    const answer = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => (String(url) === `${FINE_LAND_INDEX}/N50W010.bin.gz` ? new Promise(() => {}) : answer(url, init)));
    expect((await landMaskForBbox(solent, { fine: true, timeoutMs: 50 })).kind).toBe('land_mask');
    serve();
    requested = [];
    const started = Date.now();
    expect((await landMaskForBbox(solent, { fine: true, timeoutMs: 5000 })).kind).toBe('land_mask');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fineRequests()).toEqual([]);
  });

  it('when on, a fine file that fails at once (not a stall) is tried again on the next route', async () => {
    serve((url, bytes) => (url.endsWith('N50W010.bin.gz') ? null : bytes));
    expect((await landMaskForBbox(solent, { fine: true })).kind).toBe('land_mask');
    serve();
    expect((await landMaskForBbox(solent, { fine: true })).kind).toBe('land_cells');
  });

  it('when on, a fine window that cannot be built falls back to the outline', async () => {
    engine.routingLandMask.mockImplementationOnce(() => { throw new Error('routing-index tile N50W010 is missing'); });
    const fallback = await landMaskForBbox(solent, { fine: true });
    expect(fallback.kind).toBe('land_mask');
    expect((await landMaskForBbox(solent, { fine: true })).kind).toBe('land_cells');
  });

  it.each([
    // The Grande Rade end is a one-cell pocket of sea on the fine index: it moves out to open water.
    ['Cowes to Cherbourg’s Grande Rade', { lat: 50.766, lon: -1.298 }, { lat: 49.65, lon: -1.62 }, 'fine'],
    // Valentia lies west of 10°W, past the fine tiles: that stretch is checked on the outline alone.
    ['Cork Harbour to Valentia', { lat: 51.80, lon: -8.30 }, { lat: 51.93, lon: -10.35 }, 'outline'],
  ])('when on, %s computes as the planner computes it, with the note its land check earns', async (_label, start, finish, note) => {
    const bbox = routeBbox(start, finish);
    const landMask = await landMaskForBbox(bbox, { fine: true });
    const { start: from, finish: to } = snapEndsToSea(landMask, start, finish);
    expect(haversineNm(start.lat, start.lon, from.lat, from.lon)).toBeLessThan(2);
    if (note === 'fine') {
      // The outline snaps the same start miles out of the Solent.
      const outline = await landMaskForBbox(bbox, { fine: false });
      const outlineFrom = snapToSea(outline, start);
      expect(haversineNm(start.lat, start.lon, outlineFrom.lat, outlineFrom.lon)).toBeGreaterThan(5);
    }
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
    render(createElement(RouteSourceNotes, { computed: { route } }));
    expect(screen.getByTestId('route-not-for-navigation').textContent).toMatch(note === 'fine'
      ? /^Not for navigation\. This route avoids land and areas that dry at low tide as a 230 m grid shows them/
      : /^Not for navigation\. This route avoids only a coarse outline of the coast/);
  }, 60_000);
});
