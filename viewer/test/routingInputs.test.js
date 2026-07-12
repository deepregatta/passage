import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildWindGrid: vi.fn(),
  buildCurrentGrid: vi.fn(),
  snapToSea: vi.fn(),
  landMaskForBbox: vi.fn(),
}));

vi.mock('@deepweather/engine', () => ({
  MemoryCacheStore: class MemoryCacheStore {},
  routeBbox: () => ({ minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }),
  passageMaxHours: () => 48,
  buildWindGrid: mocks.buildWindGrid,
  buildCurrentGrid: mocks.buildCurrentGrid,
  snapToSea: mocks.snapToSea,
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

describe('live routing inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => new Response(JSON.stringify(polar)));
    mocks.landMaskForBbox.mockResolvedValue(landMask);
    mocks.snapToSea
      .mockReturnValueOnce({ lat: 0.1, lon: 0.1 })
      .mockReturnValueOnce({ lat: 0.9, lon: 0.9 });
    mocks.buildWindGrid.mockResolvedValue(windGrid);
    mocks.buildCurrentGrid.mockResolvedValue({ kind: 'surface_current' });
  });

  it('returns snapped endpoints, grids, polar, duration and progress', async () => {
    const onProgress = vi.fn();
    const result = await loadRoutingInputs({
      start: { lat: 0, lon: 0, name: 'Start' },
      finish: { lat: 1, lon: 1, name: 'Finish' },
      polarId: 'test', departureIso, now, onProgress,
    });
    expect(result).toMatchObject({
      polar, windGrid, landMask, maxHours: 48,
      start: { lat: 0.1, lon: 0.1, name: 'Start' },
      finish: { lat: 0.9, lon: 0.9, name: 'Finish' },
    });
    expect(result.notes).toEqual(['Grid was coarsened.']);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      'loading coastline', 'fetching forecast grid', 'fetching currents',
    ]);
  });

  it('clamps a scan grid to the forecast horizon', async () => {
    await loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test',
      departureIso: '2026-08-01T00:00:00Z', scanning: true, now,
    });
    expect(mocks.buildWindGrid.mock.calls[0][0].hours).toBe(48);
  });

  it('degrades current failure to wind-only with a visible note', async () => {
    mocks.buildCurrentGrid.mockResolvedValue(null);
    const result = await loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now,
    });
    expect(result.currentGrid).toBeNull();
    expect(result.notes.join(' ')).toMatch(/wind alone/i);
  });

  it('maps wind failure and rejects departures beyond the horizon', async () => {
    mocks.buildWindGrid.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now,
    })).rejects.toThrow(/live wind forecast/);

    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test',
      departureIso: '2026-08-20T00:00:00Z', now,
    })).rejects.toThrow(/beyond the live forecast horizon/);
  });

  it('asks for an open-water click when snapping cannot find sea', async () => {
    mocks.snapToSea.mockReset().mockReturnValue(null);
    await expect(loadRoutingInputs({
      start: { lat: 0, lon: 0 }, finish: { lat: 1, lon: 1 }, polarId: 'test', departureIso, now,
    })).rejects.toThrow(/open water/);
  });
});
