// The departure comparison across the Worker boundary: the same action, the
// same result, errors that keep their meaning. No Worker runs here: messages
// go through structuredClone, as postMessage would carry them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastRunGoneError, forecastRunGone } from '@deepweather/engine';
import { captureActionDraft } from '../src/lib/actionInputs.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { runRefineAction, runScanAction } from '../src/lib/scanAction.js';
import { createScanHandler } from '../src/lib/scanWorkerHandler.js';
import { RefineUnavailableError, rebuildError, serializeError } from '../src/lib/scanMessages.js';
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

// computed_at is the router's own wall clock; everything else must be identical
const clean = (out) => JSON.parse(JSON.stringify(out, (key, value) => (key === 'computed_at' ? undefined : value)));

describe('refining across the Worker boundary', () => {
  const CATALOGUE = { runs: {}, layers: [], regionalLayers: [] };
  /** A comparison, then a refinement, through one handler; every message cloned as postMessage would. */
  async function scanThenRefine(mode, scanId = 7) {
    const messages = [];
    const handle = createScanHandler((message) => messages.push(structuredClone(message)), { pinStore: async () => store });
    await handle(structuredClone({ type: 'scan', id: 7, request: request(mode), catalogue: CATALOGUE, nowMs: NOW }));
    const scanned = messages.at(-1);
    messages.length = 0;
    await handle(structuredClone({ type: 'refine', id: 8, scanId }));
    return { scanned, messages, handle };
  }

  it.each(['compute', 'draw'])('refines the %s comparison on the very inputs it ran with, as the page does, loading nothing again', async (mode) => {
    const { scanned, messages } = await scanThenRefine(mode);
    expect(scanned).toMatchObject({ type: 'done', id: 7 });
    expect(Object.keys(scanned.out.scan)).not.toContain('refinement'); // the engine's refinement data never crosses
    const done = messages.at(-1);
    expect(done).toMatchObject({ type: 'done', id: 8 });
    expect(loadRoutingInputs).toHaveBeenCalledTimes(mode === 'compute' ? 1 : 0);
    expect(prepareAnalysisInputs).toHaveBeenCalledTimes(1);
    // Uniform weather: every 6-hourly time is tied, so every 2 h time of the span is added once.
    expect(done.out.added).toHaveLength(40);
    expect(done.out.scan.candidates).toHaveLength(61);
    expect(new Set(done.out.scan.candidates.map((c) => c.departure_utc)).size).toBe(61);
    expect(Object.keys(done.out.scan)).not.toContain('refinement');
    // the same refinement run by the page itself
    let context;
    await runScanAction(request(mode), { store, keepContext: (kept) => { context = kept; } });
    expect(clean(done.out)).toEqual(clean(await runRefineAction(context)));
    const steps = messages.filter((m) => m.type === 'progress').map((m) => m.step);
    if (mode === 'compute') {
      expect(steps[0]).toBe('routing departures 0/40');
      expect(steps).toContain('routing departures 40/40');
      // one current source across both passes: every refined route on the comparison's grid
      const coarse = scanned.out.routes['2026-07-20T00:00:00Z'].route.provenance.routing_request;
      for (const departure of done.out.added) {
        expect(done.out.routes[departure].route.provenance.routing_request.current_run).toBe(coarse.current_run);
      }
    } else {
      expect(done.out.routes).toEqual({});
    }
    expect(steps.at(-1)).toBe('scanning departures 40/40');
  });

  it('answers a refinement of another comparison, or a second refinement, with "unavailable", never silence', async () => {
    const stale = await scanThenRefine('draw', 6);
    expect(rebuildError(stale.messages.at(-1).error)).toBeInstanceOf(RefineUnavailableError);
    // the stale request released nothing it did not hold: but one request per comparison, whatever it was
    const { messages, handle } = await scanThenRefine('draw');
    expect(messages.at(-1)).toMatchObject({ type: 'done', id: 8 });
    messages.length = 0;
    await handle({ type: 'refine', id: 9, scanId: 7 });
    expect(messages).toHaveLength(1);
    expect(rebuildError(messages[0].error)).toBeInstanceOf(RefineUnavailableError);
  });

  it('releases the inputs when the page drops the comparison, and only that comparison\'s', async () => {
    const messages = [];
    const handle = createScanHandler((message) => messages.push(structuredClone(message)), { pinStore: async () => store });
    await handle({ type: 'scan', id: 1, request: request('draw'), catalogue: CATALOGUE, nowMs: NOW });
    await handle({ type: 'release', scanId: 9 }); // another comparison's id: kept
    await handle({ type: 'refine', id: 2, scanId: 1 });
    expect(messages.at(-1)).toMatchObject({ type: 'done', id: 2 });
    await handle({ type: 'scan', id: 3, request: request('draw'), catalogue: CATALOGUE, nowMs: NOW });
    messages.length = 0;
    await handle({ type: 'release', scanId: 3 });
    expect(messages).toEqual([]); // a release is never answered
    await handle({ type: 'refine', id: 4, scanId: 3 });
    expect(rebuildError(messages.at(-1).error)).toBeInstanceOf(RefineUnavailableError);
  });

  it('releases the inputs when a newer comparison starts, and after a failed comparison holds none', async () => {
    const messages = [];
    const handle = createScanHandler((message) => messages.push(structuredClone(message)), { pinStore: async () => store });
    await handle({ type: 'scan', id: 1, request: request('draw'), catalogue: CATALOGUE, nowMs: NOW });
    prepareAnalysisInputs.mockRejectedValueOnce(new Error('offline'));
    await handle({ type: 'scan', id: 2, request: request('draw'), catalogue: CATALOGUE, nowMs: NOW });
    await handle({ type: 'refine', id: 3, scanId: 1 });
    await handle({ type: 'refine', id: 4, scanId: 2 });
    expect(messages.filter((m) => m.id >= 3).map((m) => rebuildError(m.error))).toEqual([expect.any(RefineUnavailableError), expect.any(RefineUnavailableError)]);
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
