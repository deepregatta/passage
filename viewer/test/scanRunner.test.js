// The page side of the scan Worker: start, progress, result, cancel, fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forecastRunGone, ForecastRunGoneError } from '@deepweather/engine';
import { runScanAction } from '../src/lib/scanAction.js';
import { resetScanWorker, runScanJob, SCAN_FAILED, ScanCancelledError } from '../src/lib/scanRunner.js';
import { serializeError } from '../src/lib/scanMessages.js';

vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => null }));
vi.mock('../src/lib/scanAction.js', () => ({ runScanAction: vi.fn() }));

/** A Worker double: records what the page posts and lets the test answer. */
class FakeWorker {
  static instances = [];
  constructor({ ready = true } = {}) {
    this.listeners = {};
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
    if (ready) queueMicrotask(() => this.emit('message', { data: { type: 'ready' } }));
  }
  addEventListener(type, fn) { (this.listeners[type] ??= new Set()).add(fn); }
  removeEventListener(type, fn) { this.listeners[type]?.delete(fn); }
  emit(type, event) { for (const fn of [...(this.listeners[type] ?? [])]) fn(event); }
  postMessage(message) { this.posted.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  reply(data) { this.emit('message', { data: structuredClone({ id: this.posted.at(-1).id, ...data }) }); }
}

const store = () => ({
  init: vi.fn(async () => {}),
  describe: () => ({ weather: { layer: 'weather', run_id: 'w1', cycle: 'c', published_at: 'p' } }),
  manifestFor: () => ({ run_id: 'w1', layer: 'weather' }),
  regionalLayerIds: () => [],
});
const REQUEST = { draft: { route: {} }, departureUtc: '2026-07-20T00:00:00Z', mode: 'compute' };
const OUT = { scan: { candidates: [], best_index: null, skipped: [] }, routes: {}, notes: [], currents: null, rerouted: true, requested: 21 };
const posted = async (worker) => vi.waitFor(() => expect(worker.posted).toHaveLength(1));

beforeEach(() => {
  FakeWorker.instances = [];
  resetScanWorker();
  runScanAction.mockReset().mockResolvedValue({ inPage: true });
});
afterEach(() => {
  delete globalThis.__deepweatherScanInPage;
  vi.useRealTimers();
});

describe('runScanJob', () => {
  it('sends the request with the page\'s pinned runs and clock, forwards progress and resolves with the result', async () => {
    const pageStore = store();
    const progress = [];
    const job = runScanJob(REQUEST, { store: pageStore, createWorker: () => new FakeWorker(), onProgress: (s) => progress.push(s) });
    const [worker] = FakeWorker.instances;
    await posted(worker);
    expect(pageStore.init).toHaveBeenCalled();
    expect(worker.posted[0]).toMatchObject({ type: 'scan', request: REQUEST, catalogue: { runs: pageStore.describe(), regionalLayers: [] } });
    expect(Math.abs(worker.posted[0].nowMs - Date.now())).toBeLessThan(1000);
    worker.reply({ type: 'progress', step: 'routing departures 3/21' });
    worker.reply({ type: 'progress', step: 'scanning departures 5/21' });
    worker.reply({ type: 'done', out: OUT });
    await expect(job).resolves.toEqual(OUT);
    expect(progress).toEqual(['routing departures 3/21', 'scanning departures 5/21']);
    expect(runScanAction).not.toHaveBeenCalled();
    // the Worker stays for the next comparison
    const second = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker() });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    worker.reply({ type: 'done', out: OUT });
    await second;
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('cancels at once by ending the Worker; the next comparison starts a new one', async () => {
    const controller = new AbortController();
    const job = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker(), signal: controller.signal });
    const [first] = FakeWorker.instances;
    await posted(first);
    controller.abort();
    await expect(job).rejects.toBeInstanceOf(ScanCancelledError);
    expect(first.terminated).toBe(true);
    // a late answer from the ended Worker is ignored
    first.reply({ type: 'done', out: OUT });
    const next = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker() });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const second = FakeWorker.instances[1];
    await posted(second);
    second.reply({ type: 'done', out: OUT });
    await expect(next).resolves.toEqual(OUT);
  });

  it('does not start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker(), signal: controller.signal }))
      .rejects.toBeInstanceOf(ScanCancelledError);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('rebuilds a deleted-run failure so the page can refresh and retry', async () => {
    const job = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker() });
    const [worker] = FakeWorker.instances;
    await posted(worker);
    worker.reply({ type: 'error', error: serializeError(new ForecastRunGoneError('weather', 'w1')) });
    const error = await job.catch((e) => e);
    expect(forecastRunGone(error)).toMatchObject({ layer: 'weather', runId: 'w1' });
  });

  it('fails plainly, and drops the Worker, when the Worker itself crashes', async () => {
    const job = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker() });
    const [worker] = FakeWorker.instances;
    await posted(worker);
    worker.emit('error', { message: 'out of memory' });
    await expect(job).rejects.toThrow(SCAN_FAILED);
    expect(worker.terminated).toBe(true);
  });
});

describe('fallback: the page runs the comparison itself', () => {
  it.each([
    ['no Worker can be built', () => { throw new Error('module workers unsupported'); }],
    ['the Worker fails to load', () => {
      const worker = new FakeWorker({ ready: false });
      queueMicrotask(() => worker.emit('error', { message: 'syntax error' }));
      return worker;
    }],
  ])('when %s, and remembers it for the visit', async (_, createWorker) => {
    const progress = vi.fn();
    const pageStore = store();
    await expect(runScanJob(REQUEST, { store: pageStore, createWorker, onProgress: progress })).resolves.toEqual({ inPage: true });
    expect(runScanAction).toHaveBeenCalledWith(REQUEST, { store: pageStore, onProgress: progress });
    const built = FakeWorker.instances.length;
    await runScanJob(REQUEST, { store: pageStore, createWorker: () => new FakeWorker() });
    expect(FakeWorker.instances).toHaveLength(built);
    expect(runScanAction).toHaveBeenCalledTimes(2);
  });

  it('when the Worker never says it is ready', async () => {
    vi.useFakeTimers();
    const job = runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker({ ready: false }) });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(job).resolves.toEqual({ inPage: true });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('when the test hook or a store without pinned runs asks for it', async () => {
    globalThis.__deepweatherScanInPage = true;
    await runScanJob(REQUEST, { store: store(), createWorker: () => new FakeWorker() });
    delete globalThis.__deepweatherScanInPage;
    await runScanJob(REQUEST, { store: {}, createWorker: () => new FakeWorker() });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(runScanAction).toHaveBeenCalledTimes(2);
  });

  it('drops an in-page result that was cancelled while it ran', async () => {
    const controller = new AbortController();
    runScanAction.mockImplementation(async () => { controller.abort(); return { inPage: true }; });
    await expect(runScanJob(REQUEST, { store: {}, signal: controller.signal })).rejects.toBeInstanceOf(ScanCancelledError);
  });
});
