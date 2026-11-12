// Runs a departure comparison in a Web Worker, so the page keeps painting,
// shows the count and answers taps while 21 departures are routed and audited.
//
// - The Worker runs the whole action (scanAction.js) on its own copy of the
//   page's pinned forecast runs (pinnedForecast.js): only the draft, a few
//   parameters and the run catalogue go in; the comparison and the routes come
//   back. Tiles never cross: the Worker reads them from the shared cache.
// - Cancel ends the Worker at once (terminate); the next comparison starts a
//   new one. The comparison yields only microtasks, so a "stop" message would
//   be read after it had finished.
// - Where a Worker cannot start (no Worker, a constructor that throws, no
//   "ready" in time) the page runs the same action itself, as it always did,
//   and remembers that for the rest of the visit.
import { forecastStore } from './forecastStore.js';
import { pinnedCatalogue } from './pinnedForecast.js';
import { runScanAction } from './scanAction.js';
import { rebuildError } from './scanMessages.js';

export const SCAN_FAILED = 'The comparison could not finish. Try again.';
const READY_TIMEOUT_MS = 15_000;

export class ScanCancelledError extends Error {
  code = 'scan-cancelled';
  constructor() {
    super('Comparison stopped.');
    this.name = 'ScanCancelledError';
  }
}

const defaultWorker = () => new Worker(new URL('./scanWorker.js', import.meta.url), { type: 'module' });

let worker = null;
let ready = null;
let unavailable = false;
let nextId = 1;

/** Forget the Worker and the fallback decision. Tests only. */
export function resetScanWorker() {
  worker?.terminate();
  worker = null;
  ready = null;
  unavailable = false;
}

function discard(w) {
  w.terminate();
  if (worker === w) {
    worker = null;
    ready = null;
  }
}

/** The running Worker, a new one, or null where none can start. */
function startWorker(createWorker) {
  if (ready) return ready;
  let w;
  try {
    w = createWorker();
  } catch {
    unavailable = true;
    return Promise.resolve(null);
  }
  worker = w;
  ready = new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onFail);
      resolve(value);
    };
    const onMessage = (event) => { if (event.data?.type === 'ready') done(w); };
    const onFail = () => {
      unavailable = true;
      discard(w);
      done(null);
    };
    const timer = setTimeout(onFail, READY_TIMEOUT_MS);
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onFail);
  });
  return ready;
}

const canUseWorker = (store) => !unavailable && globalThis.__deepweatherScanInPage !== true
  && typeof store?.describe === 'function' && typeof store.manifestFor === 'function';

async function runInPage(request, { store, onProgress, signal }) {
  const out = await runScanAction(request, { store, onProgress });
  if (signal?.aborted) throw new ScanCancelledError();
  return out;
}

/**
 * Run one comparison (see runScanAction for `request` and the result).
 * Rejects with ScanCancelledError when `signal` aborts.
 * @param {Parameters<typeof runScanAction>[0]} request
 * @param {{ store?: any, onProgress?: (step: string) => void, signal?: AbortSignal, createWorker?: () => Worker }} [options]
 * @returns {ReturnType<typeof runScanAction>}
 */
export async function runScanJob(request, { store = forecastStore(), onProgress = () => {}, signal, createWorker } = {}) {
  if (signal?.aborted) throw new ScanCancelledError();
  const make = createWorker ?? (typeof Worker === 'function' ? defaultWorker : null);
  const w = make && canUseWorker(store) ? await startWorker(make) : null;
  if (signal?.aborted) throw new ScanCancelledError();
  if (!w) return runInPage(request, { store, onProgress, signal });
  // Pinned here, on the page's store, inside the caller's withFreshForecast: the Worker gets these runs and no others.
  await store.init();
  if (signal?.aborted) throw new ScanCancelledError();
  const catalogue = pinnedCatalogue(store);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onCrash);
      w.removeEventListener('messageerror', onCrash);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = ({ data }) => {
      if (data?.id !== id) return;
      if (data.type === 'progress') onProgress(data.step);
      else if (data.type === 'done') { cleanup(); resolve(data.out); }
      else if (data.type === 'error') { cleanup(); reject(rebuildError(data.error)); }
    };
    const onCrash = (event) => {
      cleanup();
      discard(w);
      reject(new Error(SCAN_FAILED, { cause: event?.message ?? event }));
    };
    const onAbort = () => {
      cleanup();
      discard(w);
      reject(new ScanCancelledError());
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onCrash);
    w.addEventListener('messageerror', onCrash);
    signal?.addEventListener('abort', onAbort, { once: true });
    w.postMessage({ type: 'scan', id, request, catalogue, nowMs: Date.now() });
  });
}
