import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWindGrid: vi.fn(),
  getCurrentGrid: vi.fn(),
  snapToSea: vi.fn(),
  landMaskForBbox: vi.fn(),
}));

vi.mock('@deepweather/engine', () => ({
  routeBbox: () => ({ minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }),
  passageMaxHours: () => 48,
  snapToSea: mocks.snapToSea,
  TileForecastStore: class TileForecastStore {},
  HttpTileTransport: class HttpTileTransport {},
}));

vi.mock('../src/lib/landMask.js', () => ({
  landMaskForBbox: mocks.landMaskForBbox,
}));

import { loadRoutingInputs } from '../src/lib/routingInputs.js';

const departureIso = '2026-07-20T00:00:00Z';
const now = () => Date.parse('2026-07-19T00:00:00Z');
const polar = { polar_id: 'test', label: 'Test boat' };
const windGrid = { kind: 'wind10m', under_resolved_note: 'Grid was coarsened.' };
const landMask = { kind: 'land_mask' };
const store = { getWindGrid: mocks.getWindGrid, getCurrentGrid: mocks.getCurrentGrid };

describe('live routing inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => new Response(JSON.stringify(polar)));
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
    expect(result.notes).toEqual(['Grid was coarsened.']);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      'loading coastline', 'loading forecast tiles', 'loading current tiles',
    ]);
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
});
