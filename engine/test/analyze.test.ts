import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runAnalysis } from '../src/index.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import type { RegionGrid } from '../src/grids.js';
import type { LimitsProfile, Route } from '../src/types.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const options = {
  route: read('../../config/routes/cherbourg-plymouth.json') as Route,
  profile: read('../../config/profiles/default-limits.json') as LimitsProfile,
  departureUtc: '2026-07-20T06:00:00Z',
  now: () => Date.parse('2026-07-20T04:00:00Z'),
};
const methods = [
  'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts',
] as const;

function fixtureStore(optional = true) {
  return new ScenarioBundleStore({
    loadBundle: async (name) => optional || name === 'forecast'
      ? read(`./fixtures/scenarios/reference-demo/${name}.json`) : null,
    now: options.now,
  });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('public analysis with UTC offsets', () => {
  it.each([
    '2026-07-20T01:00:00-05:00',
    '2026-07-19T23:00:00-07:00',
    '2026-07-20T08:00:00+02:00',
    '2026-07-20T06:00:00',
  ])('preserves forecast windows and assessment for departure %s', async (departureUtc) => {
    const expected = await runAnalysis({ ...options, store: fixtureStore() });
    const store = fixtureStore();
    const reads = methods.map((method) => vi.spyOn(store, method));
    const actual = await runAnalysis({ ...options, departureUtc, store });

    for (const readLayer of reads) {
      expect(readLayer).toHaveBeenCalledExactlyOnceWith(
        expect.any(Array), Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 23),
      );
    }
    // Input spelling remains in departure metadata and snapshot identities.
    expect(actual.findings).toEqual({
      ...expected.findings,
      departure_utc: departureUtc,
      snapshot_id: actual.findings.snapshot_id,
    });
    expect(actual.briefing).toEqual({ ...expected.briefing, snapshot_id: actual.findings.snapshot_id });
    expect(actual.plume).toEqual({ ...expected.plume, snapshot_id: actual.findings.snapshot_id });
    expect(actual.snapshotInputs).toEqual(expected.snapshotInputs);
  });
});

describe('analysis layer reads', () => {
  it('starts every forecast read before any finishes and preserves results and progress', async () => {
    const expected = await runAnalysis({ ...options, store: fixtureStore() });
    const store = fixtureStore();
    const progress: string[] = [];
    const started: string[] = [];
    const finished: string[] = [];
    const gates = methods.map(() => gate());
    function hold<T>(method: typeof methods[number], original: (
      points: Array<{ lat: number; lon: number }>, startMs: number, endMs: number,
    ) => Promise<T>) {
      return async (points: Array<{ lat: number; lon: number }>, startMs: number, endMs: number) => {
        started.push(method);
        await gates[methods.indexOf(method)]!.promise;
        const value = await original(points, startMs, endMs);
        finished.push(method);
        return value;
      };
    }
    store.getPointForecasts = hold('getPointForecasts', store.getPointForecasts.bind(store));
    store.getEnsembleForecasts = hold('getEnsembleForecasts', store.getEnsembleForecasts.bind(store));
    store.getWaveForecasts = hold('getWaveForecasts', store.getWaveForecasts.bind(store));
    store.getHazardForecasts = hold('getHazardForecasts', store.getHazardForecasts.bind(store));
    const pending = runAnalysis({ ...options, store, onProgress: (step) => progress.push(step) });
    try {
      await vi.waitFor(() => expect([...started]).toEqual(methods));
      expect(finished).toEqual([]);
      expect(progress).toEqual([
        'reading forecast run manifest',
        'reading deterministic forecast tiles',
        `reading ${store.describe().ensemble!.member_count}-member ensemble tiles`,
        'reading wave tiles',
        'reading hazard and model-comparison tiles',
      ]);
      for (let i = gates.length - 1; i >= 0; i--) {
        gates[i]!.release();
        await vi.waitFor(() => expect(finished).toContain(methods[i]));
      }
      expect(JSON.stringify(await pending)).toBe(JSON.stringify(expected));
      expect(finished).toEqual([...methods].reverse());
      expect(progress.slice(-2)).toEqual(['reading current tiles', 'evaluating against your limits']);
    } finally {
      gates.forEach((g) => g.release());
      await pending;
    }
  });

  it('waits for initialization before starting the forecast reads', async () => {
    const store = fixtureStore();
    const initGate = gate();
    const init = store.init.bind(store);
    vi.spyOn(store, 'init').mockImplementation(async () => { await initGate.promise; await init(); });
    const reads = methods.map((method) => vi.spyOn(store, method));
    const pending = runAnalysis({ ...options, store });
    try {
      expect(store.init).toHaveBeenCalledOnce();
      reads.forEach((readLayer) => expect(readLayer).not.toHaveBeenCalled());
    } finally {
      initGate.release();
      await pending;
    }
    reads.forEach((readLayer) => expect(readLayer).toHaveBeenCalledOnce());
  });

  it.each(methods)('propagates %s failure without evaluating incomplete inputs', async (method) => {
    const store = fixtureStore();
    const error = new Error('unreadable forecast tile');
    vi.spyOn(store, method).mockRejectedValue(error);
    const progress = vi.fn();
    await expect(runAnalysis({ ...options, store, onProgress: progress })).rejects.toBe(error);
    expect(progress).not.toHaveBeenCalledWith('evaluating against your limits');
  });

  it('preserves absent optional forecasts, ensemble progress and graceful current failure', async () => {
    const expected = await runAnalysis({ ...options, store: fixtureStore(false) });
    const store = fixtureStore(false);
    vi.spyOn(store, 'getCurrentGrid').mockRejectedValue(new Error('currents unavailable'));
    const progress = vi.fn();
    const result = await runAnalysis({ ...options, store, onProgress: progress });
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    expect(progress).toHaveBeenCalledWith('checking ensemble tiles');
    expect(progress).toHaveBeenCalledWith('reading current tiles');
    expect(progress).toHaveBeenLastCalledWith('evaluating against your limits');
  });

  it('keeps the prepared current grid override and skips its tile read and progress', async () => {
    const store = fixtureStore();
    const readCurrents = vi.spyOn(store, 'getCurrentGrid');
    const progress = vi.fn();
    const currentGrid: RegionGrid = {
      schema_version: 1, kind: 'surface_current', run_id: 'test-current',
      generated_at: '2026-07-20T04:00:00Z', source: { mode: 'synthetic' },
      lat0: 45, lon0: -10, dlat: 10, dlon: 10, nlat: 2, nlon: 2,
      time_axis: ['2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z'],
      u_kt: Array(8).fill(0), v_kt: Array(8).fill(0),
    };
    await runAnalysis({ ...options, store, currentGrid, onProgress: progress });
    expect(readCurrents).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalledWith('reading current tiles');
    expect(progress).toHaveBeenLastCalledWith('evaluating against your limits');
  });
});
