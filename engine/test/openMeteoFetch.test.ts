/**
 * Quota discipline for the Open-Meteo client: duplicate coordinates collapse
 * into one requested location, and 429 retries wait out the per-minute quota.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchPointForecasts, MemoryCacheStore } from '../src/fetch/openMeteo.js';

const HOURLY = {
  time: ['2026-07-15T00:00', '2026-07-15T01:00'],
  wind_speed_10m: [10, 12],
  wind_gusts_10m: [14, 16],
  wind_direction_10m: [270, 275],
};

function locationResponse(count: number): Response {
  const body = Array.from({ length: count }, (_, i) => ({
    hourly: { ...HOURLY, wind_speed_10m: [10 + i, 12 + i] },
  }));
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('open-meteo quota discipline', () => {
  it('collapses duplicate coordinates into one requested location', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return locationResponse(2);
    }) as unknown as typeof fetch;

    const points = [
      { lat: 49.75, lon: -1.5 },
      { lat: 49.75, lon: -1.5 },
      { lat: 50.0, lon: -2.25 },
    ];
    const { forecasts, meta } = await fetchPointForecasts(points, '2026-07-15', '2026-07-16', {
      fetchFn,
      cache: new MemoryCacheStore(),
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('latitude=49.75,50.00');
    expect(urls[0]).toContain('longitude=-1.50,-2.25');
    // response expands back onto the caller's per-point order
    expect(forecasts).toHaveLength(3);
    expect(forecasts[0]!.wind_kt).toEqual(forecasts[1]!.wind_kt);
    expect(forecasts[2]!.wind_kt).toEqual([11, 13]);
    expect(forecasts[2]!.lat).toBe(50.0);
    expect(meta.points).toBe(3);
  });

  it('waits out the per-minute quota before retrying a 429', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('rate limited', { status: 429 }) : locationResponse(1);
    }) as unknown as typeof fetch;

    const { forecasts } = await fetchPointForecasts([{ lat: 49.75, lon: -1.5 }], '2026-07-15', '2026-07-16', {
      fetchFn,
      cache: new MemoryCacheStore(),
      baseDelayMs: 1000,
      rateLimitDelayMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(forecasts).toHaveLength(1);
    expect(calls).toBe(2);
    // 4000ms quota top-up at failure time + the 1000ms exponential delay = 5000ms total
    expect(sleeps).toEqual([4000, 1000]);
  });
});
