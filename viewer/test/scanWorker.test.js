// The departure comparison across the Worker boundary: the same action, the
// same result, errors that keep their meaning. No Worker runs here: messages
// go through structuredClone, as postMessage would carry them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastRunGoneError, forecastRunGone } from '@deepweather/engine';
import { captureActionDraft } from '../src/lib/actionInputs.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { runScanAction } from '../src/lib/scanAction.js';
import { createScanHandler } from '../src/lib/scanWorkerHandler.js';
import { rebuildError, serializeError } from '../src/lib/scanMessages.js';
import { ForecastUpdatedError, withFreshForecast } from '../src/lib/forecastFreshness.js';
import limits from '../../config/profiles/default-limits.json';
import { auditStore, DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ prepareAnalysisInputs: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => null }));

const NOW = Date.parse('2026-07-19T12:00:00Z');
let store;

function request(mode = 'compute', inputs = routingInputs(1)) {
  const route = { schema_version: 1, passage_id: 'p', route_id: 'r', name: 'Test passage', mode: 'user',
    waypoints: [{ id: 'a', lat: 49.5, lon: -3.5 }, { id: 'b', lat: 49.5, lon: -3.2 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 },
    timing: { basis: 'through_water' } };
  return {
    draft: captureActionDraft({ route, profile: limits, departureUtc: DEPARTURE }),
    departureUtc: DEPARTURE, mode, polarId: 'constant-5', polarPercent: 100, passageHours: 4,
    endpoints: [inputs.start, inputs.finish].map(({ lat, lon }) => ({ lat, lng: lon })),
  };
}

/** One request through the handler, every message cloned as postMessage would. */
async function viaWorker(req, { pinStore = async () => store } = {}) {
  const messages = [];
  const handle = createScanHandler((message) => messages.push(structuredClone(message)), { pinStore });
  await handle(structuredClone({ type: 'scan', id: 7, request: req, catalogue: { runs: {}, layers: [], regionalLayers: [] }, nowMs: NOW }));
  return messages;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const engine = await vi.importActual('@deepweather/engine');
  const inputs = routingInputs(1);
  store = auditStore(engine, inputs.currentGrid);
  loadRoutingInputs.mockReset().mockResolvedValue(inputs);
  prepareAnalysisInputs.mockReset().mockImplementation(async (draft) => ({ ...draft, store, tileRuns: {}, inputRecords: [] }));
});

describe('the scan across the Worker boundary', () => {
  it.each(['compute', 'draw'])('returns the same %s comparison as the page running it itself', async (mode) => {
    const inPage = await runScanAction(request(mode), { store });
    const messages = await viaWorker(request(mode));
    const done = messages.at(-1);
    expect(done).toMatchObject({ type: 'done', id: 7 });
    expect(inPage.scan.candidates.length).toBe(21);
    // computed_at is the router's own wall clock; everything else must be identical
    const clean = (out) => JSON.parse(JSON.stringify(out, (key, value) => (key === 'computed_at' ? undefined : value)));
    expect(clean(done.out)).toEqual(clean(inPage));
    expect(Object.keys(done.out.routes)).toEqual(Object.keys(inPage.routes));
    expect(done.out.scan.candidates.map((c) => c.departure_utc)).toEqual(inPage.scan.candidates.map((c) => c.departure_utc));
  });

  it('reports routing, then each audited candidate, as counts only', async () => {
    const messages = await viaWorker(request('compute'));
    const steps = messages.filter((m) => m.type === 'progress').map((m) => m.step);
    const routing = steps.filter((s) => s.startsWith('routing departures'));
    const scanning = steps.filter((s) => /^scanning departures \d/.test(s));
    expect(routing[0]).toBe('routing departures 0/21');
    expect(routing.at(-1)).toBe('routing departures 21/21');
    expect(scanning.at(-1)).toBe('scanning departures 21/21');
    expect(steps.indexOf(routing.at(-1))).toBeLessThan(steps.indexOf(scanning[0]));
    // no candidate leaves before the ranking: hour figures are filled in after the last audit
    expect(messages.filter((m) => m.type === 'progress').every((m) => Object.keys(m).sort().join() === 'id,step,type')).toBe(true);
  });

  it('runs on the page\'s clock and pins the page\'s runs', async () => {
    const pinStore = vi.fn(async () => store);
    vi.setSystemTime(new Date(NOW + 3 * 3600_000)); // this thread's clock is three hours off
    await viaWorker(request('compute'), { pinStore });
    expect(pinStore.mock.calls[0][0]).toEqual({ runs: {}, layers: [], regionalLayers: [] });
    const now = loadRoutingInputs.mock.calls[0][0].now;
    expect(Math.abs(now() - NOW)).toBeLessThan(1000);
    expect(prepareAnalysisInputs.mock.calls[0][2]).toBe(store);
  });

  it('fails as an updated forecast when the Worker cannot pin the page\'s runs', async () => {
    const messages = await viaWorker(request(), { pinStore: async () => { throw new ForecastUpdatedError(); } });
    expect(rebuildError(messages.at(-1).error)).toBeInstanceOf(ForecastUpdatedError);
  });
});

describe('errors across the boundary', () => {
  it('keeps a deleted forecast run recognisable, so the page refreshes and tries again', async () => {
    const gone = new ForecastRunGoneError('weather', 'weather-old');
    const wrapped = new Error('Couldn\'t load the forecast tiles.', { cause: gone });
    for (const error of [gone, wrapped]) {
      const rebuilt = rebuildError(structuredClone(serializeError(error)));
      expect(forecastRunGone(rebuilt)).toMatchObject({ layer: 'weather', runId: 'weather-old' });
      expect(rebuilt.message).toBe(error.message);
    }
    // withFreshForecast refreshes once and runs the action again
    const pageStore = { refresh: vi.fn(async () => ['weather']), lastCheckedMs: () => NOW, manifestFor: () => ({ run_id: 'weather-new' }) };
    const action = vi.fn()
      .mockRejectedValueOnce(rebuildError(serializeError(gone)))
      .mockResolvedValueOnce('second run');
    await expect(withFreshForecast(action, { store: pageStore, now: () => NOW })).resolves.toBe('second run');
    expect(pageStore.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the message and code of other failures', () => {
    const rebuilt = rebuildError(structuredClone(serializeError(Object.assign(new Error('No route found within 48 h'), { code: 'no-route' }))));
    expect(rebuilt.message).toBe('No route found within 48 h');
    expect(rebuilt.code).toBe('no-route');
    expect(rebuildError(serializeError('plain')).message).toBe('plain');
  });
});
