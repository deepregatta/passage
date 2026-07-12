import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCurrentGrid,
  buildWindGrid,
  passageMaxHours,
  planGrid,
  routeBbox,
} from '../src/fetch/liveGrids.js';
import { computeRoute } from '../src/routing/isochrone.js';

const start = '2026-07-20T00:20:00Z';
const times = Array.from({ length: 7 }, (_, hour) =>
  `2026-07-20T${String(hour).padStart(2, '0')}:00:00Z`,
);

function responseFor(
  url,
  kind = 'wind',
  makeValues = (_i, n) => Array(n).fill(10),
  directionFor = (i) => [0, 90, 180, 270][i % 4],
) {
  const parsed = new URL(url);
  const lats = parsed.searchParams.get('latitude').split(',');
  const locations = lats.map((_lat, i) => ({
    hourly: kind === 'wind'
      ? {
          time: times.map((t) => t.slice(0, 16)),
          wind_speed_10m: makeValues(i, times.length),
          wind_gusts_10m: Array(times.length).fill(12),
          wind_direction_10m: Array(times.length).fill(directionFor(i)),
        }
      : {
          time: times.map((t) => t.slice(0, 16)),
          ocean_current_velocity: makeValues(i, times.length),
          ocean_current_direction: Array(times.length).fill(90),
        },
  }));
  return new Response(JSON.stringify(locations.length === 1 ? locations[0] : locations));
}

const tinyBbox = { minLat: 0, maxLat: 0.15, minLon: 0, maxLon: 0.15 };

describe('live grid planning', () => {
  it('pads route bounds, scales duration, and coarsens within the point budget', () => {
    expect(routeBbox({ lat: 50, lon: -2 }, { lat: 51, lon: 0 })).toEqual({
      minLat: 49.5, maxLat: 51.5, minLon: -2.5, maxLon: 0.5,
    });
    expect(passageMaxHours({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBe(48);
    const plan = planGrid({ minLat: 0, maxLat: 5, minLon: 0, maxLon: 5 });
    expect(plan.points.length).toBeLessThanOrEqual(200);
    expect(plan.dlat).toBeGreaterThan(0.25);
    expect(plan.under_resolved_note).toMatch(/coarsened/);
  });

  it('refuses oversized and antimeridian-crossing areas', () => {
    expect(() => planGrid({ minLat: -20, maxLat: 20, minLon: -20, maxLon: 20 })).toThrow(/too large/);
    expect(() => routeBbox({ lat: 0, lon: 170 }, { lat: 0, lon: -170 })).toThrow(/Antimeridian/);
  });
});

describe('live grid assembly', () => {
  it('converts meteorological cardinal directions and assembles time-major flat arrays', async () => {
    const fetchFn = vi.fn(async (input) => responseFor(String(input)));
    const grid = await buildWindGrid({
      bbox: tinyBbox, startIso: start, hours: 1,
      options: { fetchFn, maxRetries: 0 },
    });
    expect(grid.time_axis).toEqual(times.slice(0, 2));
    expect(grid.u_kt.slice(0, 4).map((v) => Math.round(v))).toEqual([0, -10, 0, 10]);
    expect(grid.v_kt.slice(0, 4).map((v) => Math.round(v))).toEqual([-10, 0, 10, 0]);
    expect(grid.u_kt.slice(4, 8)).toEqual(grid.u_kt.slice(0, 4));
  });

  it('uses the current direction as toward, fills nearby gaps, and zero-fills isolated steps', async () => {
    const fetchFn = vi.fn(async (input) => responseFor(String(input), 'current', (i, n) =>
      i === 0 ? Array(n).fill(2) : Array(n).fill(null),
    ));
    const grid = await buildCurrentGrid({ bbox: tinyBbox, startIso: start, hours: 1, options: { fetchFn, maxRetries: 0 } });
    expect(grid).not.toBeNull();
    expect(grid.u_kt.slice(0, 4).map((v) => Math.round(v))).toEqual([2, 2, 2, 2]);
    expect(grid.v_kt.slice(0, 4).map((v) => Math.round(v))).toEqual([0, 0, 0, 0]);

    const emptyFetch = vi.fn(async (input) => responseFor(String(input), 'current', (_i, n) => Array(n).fill(null)));
    const empty = await buildCurrentGrid({ bbox: tinyBbox, startIso: start, hours: 1, options: { fetchFn: emptyFetch, maxRetries: 0 } });
    expect(empty.u_kt).toEqual(Array(8).fill(0));
    expect(empty.under_resolved_note).toMatch(/More than half/);
  });

  it('batches at most 50 locations and returns null after a current fetch failure', async () => {
    const fetchFn = vi.fn(async (input) => responseFor(String(input)));
    const bbox = { minLat: 0, maxLat: 1.34, minLon: 0, maxLon: 1.64 };
    const grid = await buildWindGrid({ bbox, startIso: start, hours: 1, options: { fetchFn, maxRetries: 0 }, planOptions: { targetPoints: 120 } });
    expect(grid.nlat * grid.nlon).toBe(120);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [url] of fetchFn.mock.calls) {
      expect(new URL(String(url)).searchParams.get('latitude').split(',').length).toBeLessThanOrEqual(50);
    }
    const failed = await buildCurrentGrid({
      bbox: tinyBbox, startIso: start, hours: 1,
      options: { fetchFn: vi.fn(async () => { throw new Error('offline'); }), maxRetries: 0 },
    });
    expect(failed).toBeNull();
  });

  it('validates a built grid against the region-grid contract', async () => {
    const grid = await buildWindGrid({
      bbox: tinyBbox, startIso: start, hours: 1,
      options: { fetchFn: async (input) => responseFor(String(input)), maxRetries: 0 },
    });
    const schema = JSON.parse(readFileSync(join(process.cwd(), '..', 'contracts', 'region-grid.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(grid), JSON.stringify(validate.errors)).toBe(true);
  });

  it('feeds a mock-built uniform grid into the router end to end', async () => {
    const grid = await buildWindGrid({
      bbox: { minLat: 0, maxLat: 0.3, minLon: 0, maxLon: 0.3 },
      startIso: '2026-07-20T00:00:00Z', hours: 6,
      options: {
        fetchFn: async (input) => responseFor(String(input), 'wind', (_i, n) => Array(n).fill(12), () => 180),
        maxRetries: 0,
      },
    });
    const result = computeRoute({
      start: { lat: 0.05, lon: 0.05 }, finish: { lat: 0.05, lon: 0.25 },
      departureUtc: '2026-07-20T00:00:00Z', windGrid: grid, maxHours: 6,
      polar: {
        schema_version: 1, polar_id: 'test', label: 'Test',
        tws_kt: [6, 12, 20], twa_deg: [45, 90, 135, 180],
        speeds_kt: [[3, 4, 4, 3], [5, 6.5, 6, 5], [6, 7, 7, 6]],
        source: { kind: 'test' },
      },
    });
    expect(result.distance_nm).toBeGreaterThan(10);
    expect(result.duration_h).toBeLessThan(6);
  });
});
