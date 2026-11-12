import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWindGrid: vi.fn(),
  getCurrentGrid: vi.fn(),
  snapToSea: vi.fn(),
  landMaskForBbox: vi.fn(),
  polarFromRelease: vi.fn(),
}));

vi.mock('@deepweather/engine', () => ({
  routeBbox: () => ({ minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }),
  passageMaxHours: () => 48,
  snapToSea: mocks.snapToSea,
  polarFromRelease: mocks.polarFromRelease,
  forecastRunGone: (error) => (error?.name === 'ForecastRunGoneError' ? error : null),
  contentHash: (value) => `digest-${value.run_id}`,
  TileForecastStore: class TileForecastStore {},
  HttpTileTransport: class HttpTileTransport {},
}));

vi.mock('../src/lib/landMask.js', () => ({
  landMaskForBbox: mocks.landMaskForBbox,
}));

import { loadRoutingInputs, routedOutcome, routingCurrentSummary, routingNotes } from '../src/lib/routingInputs.js';

const departureIso = '2026-07-20T00:00:00Z';
const now = () => Date.parse('2026-07-19T00:00:00Z');
const entry = { format: 'deepregatta-polars/1', id: 'test' };
const polar = { polar_id: 'test', label: 'Test boat' };
const windGrid = { kind: 'wind10m', under_resolved_note: 'Grid was coarsened.' };
const landMask = { kind: 'land_mask' };
const store = { getWindGrid: mocks.getWindGrid, getCurrentGrid: mocks.getCurrentGrid };

describe('live routing inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => new Response(JSON.stringify(entry)));
    mocks.polarFromRelease.mockReturnValue(polar);
    mocks.landMaskForBbox.mockResolvedValue(landMask);
    mocks.snapToSea
      .mockReturnValueOnce({ lat: 0.1, lon: 0.1 })
      .mockReturnValueOnce({ lat: 0.9, lon: 0.9 });
    mocks.getWindGrid.mockResolvedValue(windGrid);
    mocks.getCurrentGrid.mockResolvedValue({ kind: 'surface_current' });
  });

  it('returns snapped endpoints, grids, polar, duration and progress', async () => {
    const onProgress = vi.fn();
    const result = await loadRoutingInputs({
      start: { lat: 0, lon: 0, name: 'Start' },
      finish: { lat: 1, lon: 1, name: 'Finish' },
      polarId: 'test', departureIso, now, onProgress, store,
    });
    expect(result).toMatchObject({
      polar, windGrid, landMask, maxHours: 48,
      start: { lat: 0.1, lon: 0.1, name: 'Start' },
      finish: { lat: 0.9, lon: 0.9, name: 'Finish' },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/polars/test');
    expect(mocks.polarFromRelease).toHaveBeenCalledWith(entry);
    expect(result.notes).toEqual(['Grid was coarsened.']);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      'loading coastline', 'loading forecast tiles', 'loading current tiles',
    ]);
  });

  it.each([
    [() => new Response(null, { status: 429 }), /Too many boat polar requests/],
    [() => new Response(null, { status: 404 }), /no longer in the polar list/],
    [() => new Response(null, { status: 503 }), /Boat polars are unavailable/],
    [() => new Response('<!doctype html>'), /Boat polars are unavailable/],
    [() => { throw new TypeError('Failed to fetch'); }, /Boat polars are unavailable/],
  ])('reports a polar it cannot read before loading anything else (%#)', async (respond, message) => {
    global.fetch = vi.fn(async () => respond());
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
    })).rejects.toThrow(message);
    expect(mocks.landMaskForBbox).not.toHaveBeenCalled();
  });

  it('reports an entry the engine cannot convert as unavailable', async () => {
    mocks.polarFromRelease.mockImplementation(() => { throw new Error('Not a deepregatta-polars/1 entry'); });
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
    })).rejects.toThrow(/Boat polars are unavailable/);
  });

  it('clamps a scan grid to the deterministic tile horizon', async () => {
    await loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test',
      departureIso: '2026-07-24T00:00:00Z', scanning: true, now, store,
    });
    // 240 h horizon − 120 h until departure = 120 h available < 120+48+6
    expect(mocks.getWindGrid.mock.calls[0][2]).toBe(120);
  });

  it('degrades current failure to wind-only with a visible note', async () => {
    mocks.getCurrentGrid.mockResolvedValue(null);
    const result = await loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
    });
    expect(result.currentGrid).toBeNull();
    expect(result.notes.join(' ')).toMatch(/wind alone/i);
  });

  it('passes a deleted run through for a refresh and retry, from wind or currents', async () => {
    const gone = Object.assign(new Error('forecast run weather-20260720T00Z is no longer published (HTTP 404)'), {
      name: 'ForecastRunGoneError', status: 404,
    });
    const args = { start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store };
    mocks.getWindGrid.mockRejectedValueOnce(gone);
    await expect(loadRoutingInputs(args)).rejects.toBe(gone);
    mocks.snapToSea.mockReturnValueOnce({ lat: 0.1, lon: 0.1 }).mockReturnValueOnce({ lat: 0.9, lon: 0.9 });
    mocks.getCurrentGrid.mockRejectedValueOnce(gone);
    await expect(loadRoutingInputs(args)).rejects.toBe(gone);
  });

  it('maps wind failure and rejects departures beyond the horizon', async () => {
    mocks.getWindGrid.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
    })).rejects.toThrow(/forecast tiles/);

    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test',
      departureIso: '2026-08-20T00:00:00Z', now, store,
    })).rejects.toThrow(/beyond the forecast horizon/);
  });

  it('asks for an open-water click when snapping cannot find sea', async () => {
    mocks.snapToSea.mockReset().mockReturnValue(null);
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
    })).rejects.toThrow(/open water/);
  });

  it.each(['Decompression failed for coastline', 'Failed to fetch'])(
    'retains the cause of a coastline failure (%s)', async (message) => {
      const cause = new TypeError(message);
      mocks.landMaskForBbox.mockRejectedValueOnce(cause);
      await expect(loadRoutingInputs({
        start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store,
      })).rejects.toMatchObject({
        message: /coastline|decompress/i.test(message)
          ? message : "Couldn't load the coastline data needed for safe routing",
        cause,
      });
    },
  );

  it('reads the prepared current grid only for Compute, from a fresh pointer', async () => {
    const preparedGrid = { kind: 'surface_current', run_id: 'cmems-ibi-20260719T06Z', source: { dataset_id: 'cmems_mod_ibi_phy_anfc' } };
    global.fetch = vi.fn(async (url) => new Response(JSON.stringify(
      url === '/data/runs/latest.json' ? { run_id: 'prepared', artifacts: { current_grid: 'runs/prepared/current_grid.json' } }
        : url === '/data/runs/prepared/current_grid.json' ? preparedGrid : entry)));
    const args = { start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now, store };
    const scan = await loadRoutingInputs({ ...args, scanning: true });
    expect(scan).not.toHaveProperty('preparedCurrent');
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/polars/test']);
    mocks.snapToSea.mockReturnValueOnce({ lat: 0.1, lon: 0.1 }).mockReturnValueOnce({ lat: 0.9, lon: 0.9 });
    const onProgress = vi.fn();
    const compute = await loadRoutingInputs({ ...args, prepared: true, onProgress });
    expect(compute.preparedCurrent).toEqual({ currentGrid: preparedGrid, currentGridProvenance: expect.objectContaining({
      source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc', run_id: 'cmems-ibi-20260719T06Z',
      artifact_ref: 'runs/prepared/current_grid.json', content_digest: 'digest-cmems-ibi-20260719T06Z',
    }) });
    expect(global.fetch).toHaveBeenCalledWith('/data/runs/latest.json', { cache: 'no-cache' });
    expect(onProgress.mock.calls.at(-1)[0]).toBe('loading prepared data');
  });

  it('notes only what the chosen current source says about the route', () => {
    const wind = { under_resolved_note: 'Grid was coarsened.' };
    const tile = { under_resolved_note: 'Tile currents coarsened.' };
    const prepared = { under_resolved_note: 'stride-subsampled x2 from native 0.0278 deg' };
    expect(routingNotes(wind, tile)).toEqual(['Grid was coarsened.', 'Tile currents coarsened.']);
    expect(routingNotes(wind, null)).toEqual(['Grid was coarsened.', 'Currents unavailable right now. This route uses wind alone.']);
    expect(routingNotes(wind, prepared, 'prepared')).toEqual(['Grid was coarsened.']);
  });

  it('fails a departure the selection never routed with a message, and rethrows a routing error', () => {
    const failure = new Error('No route found within 48 h (wind coverage, land, or no-go conditions)');
    const results = new Map([['a', { result: { route: 'r' } }], ['b', { error: failure }]]);
    expect(routedOutcome(results, 'a')).toEqual({ route: 'r' });
    expect(() => routedOutcome(results, 'b')).toThrow(failure);
    expect(() => routedOutcome(results, 'c')).toThrow('This departure could not be routed.');
  });

  it('names the tile currents model from its id, and guesses none when the grid does not record it', () => {
    const tiles = (dataset) => ({ grid: { source: { mode: 'live', ...(dataset ? { dataset_id: dataset } : {}) } }, provenance: { current_source: 'tiles' } });
    expect(routingCurrentSummary(tiles('cmems_glo12 tiles (currents-20260720T00Z)'))).toEqual({ source: 'tiles', model: 'cmems_glo12', emulated: false, caveat: null });
    expect(routingCurrentSummary(tiles()).model).toBeNull();
    expect(routingCurrentSummary({ grid: { source: { mode: 'synthetic' } }, provenance: { current_source: 'prepared' } }).model).toBeNull();
    expect(routingCurrentSummary({ grid: undefined, provenance: { current_source: 'tiles' } })).toBeNull();
  });
});
