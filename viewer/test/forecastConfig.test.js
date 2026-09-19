import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@deepweather/engine', () => ({
  HttpTileTransport: class { constructor(options) { transport(options); } },
  TileForecastStore: class {},
}));
vi.mock('../src/lib/tileCache.js', () => ({ createTileCache: () => null }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); transport.mockClear(); });

it.each([
  [false, '', 'https://forecast.deepregatta.com'],
  [true, '', '/data/forecast'],
  [false, 'https://forecast.test/custom/', 'https://forecast.test/custom'],
  [true, 'https://forecast.test/', 'https://forecast.test'],
])('configures the tile transport (dev=%s, override=%j)', async (dev, override, baseUrl) => {
  vi.stubEnv('DEV', dev);
  vi.stubEnv('VITE_FORECAST_BASE_URL', override);
  const { forecastStore } = await import('../src/lib/forecastStore.js');
  const store = forecastStore();
  expect(forecastStore()).toBe(store);
  expect(transport).toHaveBeenCalledExactlyOnceWith({ baseUrl });
});
