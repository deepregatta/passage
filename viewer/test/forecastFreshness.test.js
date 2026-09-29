import { describe, expect, it, vi } from 'vitest';
import { ForecastRunGoneError } from '@deepweather/engine';
import {
  FORECAST_CHECK_MS,
  ForecastUpdatedError,
  refreshForecastIfStale,
  withFreshForecast,
} from '../src/lib/forecastFreshness.js';

vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => null }));

const T0 = Date.parse('2026-09-30T10:00:00Z');

/** The store surface the module uses: its last check, refresh and the pinned runs. */
function fakeStore({ runs = { weather: 'weather-20260930T00Z' }, checkedAt = T0 } = {}) {
  const store = {
    pinned: { ...runs },
    published: { ...runs },
    checkedAt,
    refreshes: 0,
    failRefresh: false,
    lastCheckedMs: () => store.checkedAt,
    manifestFor: (layer) => (store.pinned[layer] ? { run_id: store.pinned[layer] } : null),
    refresh: vi.fn(async () => {
      store.refreshes += 1;
      if (store.failRefresh) throw new Error('offline');
      const changed = Object.keys(store.published).filter((layer) => store.published[layer] !== store.pinned[layer]);
      store.pinned = { ...store.published };
      return changed;
    }),
  };
  return store;
}

const gone = (runId = 'weather-20260930T00Z') =>
  new ForecastRunGoneError('weather', runId, { cause: Object.assign(new Error('HTTP 404'), { status: 404 }) });

describe('refreshForecastIfStale', () => {
  it('re-reads latest.json only when the last check is over 10 minutes old', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    expect(await refreshForecastIfStale({ store, now: () => T0 + FORECAST_CHECK_MS })).toEqual([]);
    expect(store.refreshes).toBe(0);
    expect(await refreshForecastIfStale({ store, now: () => T0 + FORECAST_CHECK_MS + 1 })).toEqual(['weather']);
    expect(store.refreshes).toBe(1);
  });

  it('keeps the pinned runs when offline', async () => {
    const store = fakeStore();
    store.failRefresh = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await refreshForecastIfStale({ store, now: () => T0 + 60 * 60_000 })).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('withFreshForecast', () => {
  it('refreshes a stale store before the action and tells it what changed', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    const action = vi.fn(async ({ changed }) => ({ changed, run: store.pinned.weather }));
    const result = await withFreshForecast(action, { store, now: () => T0 + 11 * 60_000 });
    expect(result).toEqual({ changed: ['weather'], run: 'weather-20260930T06Z' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('never refreshes while another action runs', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    const now = () => T0 + 30 * 60_000;
    let release;
    const first = withFreshForecast(() => new Promise((resolve) => { release = resolve; }), { store, now: () => T0 });
    const second = await withFreshForecast(async () => store.pinned.weather, { store, now });
    expect(second).toBe('weather-20260930T00Z'); // shares the first action's runs
    expect(store.refreshes).toBe(0);
    release();
    await first;
    expect(await withFreshForecast(async () => store.pinned.weather, { store, now })).toBe('weather-20260930T06Z');
  });

  it('refreshes once and retries when a tile of a replaced run is gone', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    const action = vi.fn(async ({ changed }) => {
      if (store.pinned.weather === 'weather-20260930T00Z') throw gone();
      return changed;
    });
    expect(await withFreshForecast(action, { store, now: () => T0 })).toEqual(['weather']);
    expect(action).toHaveBeenCalledTimes(2);
    expect(store.refreshes).toBe(1);
  });

  it('also retries a GRIB plan made on runs the store has since replaced', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    const action = vi.fn(async ({ changed }) => {
      if (!changed.length) throw Object.assign(new Error('The forecast has been updated. Try again.'), { code: 'forecast-updated' });
      return 'file';
    });
    expect(await withFreshForecast(action, { store, now: () => T0 })).toBe('file');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('asks to try again when latest.json still lists the missing run', async () => {
    const store = fakeStore();
    const action = vi.fn(async () => { throw gone(); });
    const error = await withFreshForecast(action, { store, now: () => T0 }).catch((e) => e);
    expect(error).toBeInstanceOf(ForecastUpdatedError);
    expect(error.message).toBe('The forecast has been updated. Try again.');
    expect(error.code).toBe('forecast-updated');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('retries only once', async () => {
    const store = fakeStore();
    store.published.weather = 'weather-20260930T06Z';
    const action = vi.fn(async () => { throw gone(store.pinned.weather); });
    await expect(withFreshForecast(action, { store, now: () => T0 })).rejects.toBeInstanceOf(ForecastUpdatedError);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('passes other failures through untouched, without refreshing', async () => {
    const store = fakeStore();
    const failure = new Error('Click a point in open water near both ends of the passage');
    await expect(withFreshForecast(async () => { throw failure; }, { store, now: () => T0 })).rejects.toBe(failure);
    expect(store.refreshes).toBe(0);
  });
});
