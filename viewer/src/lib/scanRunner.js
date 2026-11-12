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
// - A finished comparison can be refined once (runRefineJob). Its inputs stay
//   on the thread that ran it (the Worker, or this page in the fallback) and
//   never cross: the refinement reuses those very objects. They are released by
//   the next comparison, by the end of that Worker (Stop, a crash, leaving the
//   planner during a run) and by the refinement itself.
import { forecastStore } from './forecastStore.js';
import { pinnedCatalogue } from './pinnedForecast.js';
import { runRefineAction, runScanAction } from './scanAction.js';
import { RefineUnavailableError, rebuildError } from './scanMessages.js';

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
// The comparison that can still be refined: {id, worker} when its inputs are in
// that Worker, {id, context} when this page ran it. One at a time. Every change
// goes through setRefinable, which tells subscribers (the planner re-renders).
let refinable = null;
let refinableVersion = 0;
const refinableListeners = new Set();
function setRefinable(next, { force = false } = {}) {
  if (next === refinable && !force) return;
  refinable = next;
  refinableVersion += 1;
  for (const listener of [...refinableListeners]) listener();
}

/** Subscribe to changes of which comparison can be refined (useSyncExternalStore's subscribe). */
export function subscribeRefinable(listener) {
  refinableListeners.add(listener);
  return () => refinableListeners.delete(listener);
}

/** A number that changes whenever which comparison can be refined changes (useSyncExternalStore's snapshot). */
export const refinableSnapshot = () => refinableVersion;

/** Forget the Worker, the fallback decision and any refinable comparison. Tests only. */
export function resetScanWorker() {
  worker?.terminate();
  worker = null;
  ready = null;
  unavailable = false;
  setRefinable(null, { force: true });
}

function discard(w) {
  w.terminate();
  if (refinable?.worker === w) setRefinable(null);
  if (worker === w) {
    worker = null;
    ready = null;
  }
}

/** Whether the comparison `scanId` can still be refined here: its inputs are still held. */
export function refineHeld(scanId) {
  if (scanId == null || refinable?.id !== scanId) return false;
  return refinable.context != null || (refinable.worker != null && refinable.worker === worker);
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
    const onMessage = (event) => {
      if (event.data?.type !== 'ready') return;
      // A Worker that fails later, even between jobs, is dropped with whatever it held.
      w.addEventListener('error', () => discard(w));
      done(w);
    };
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
  let context = null;
  const out = await runScanAction(request, { store, onProgress, keepContext: (kept) => { context = kept; } });
  if (signal?.aborted) throw new ScanCancelledError();
  const id = nextId++;
  if (context) setRefinable({ id, context });
  return { ...out, scanId: id };
}

/** Post one job to the Worker and settle with its answer; Cancel ends the Worker. */
function postJob(w, message, { onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const { id } = message;
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
    w.postMessage(message);
  });
}

/**
 * Run one comparison (see runScanAction for `request` and the result).
 * Rejects with ScanCancelledError when `signal` aborts.
 * @param {Parameters<typeof runScanAction>[0]} request
 * @param {{ store?: any, onProgress?: (step: string) => void, signal?: AbortSignal, createWorker?: () => Worker }} [options]
 * @returns {ReturnType<typeof runScanAction>}
 */
export async function runScanJob(request, { store = forecastStore(), onProgress = () => {}, signal, createWorker } = {}) {
  // A new comparison replaces the one that could be refined, whatever happens to it.
  setRefinable(null);
  if (signal?.aborted) throw new ScanCancelledError();
  const make = createWorker ?? (typeof Worker === 'function' ? defaultWorker : null);
  const w = make && canUseWorker(store) ? await startWorker(make) : null;
  if (signal?.aborted) throw new ScanCancelledError();
  if (!w) return runInPage(request, { store, onProgress, signal });
  // Pinned here, on the page's store, inside the caller's withFreshForecast: the Worker gets these runs and no others.
  await store.init();
  if (signal?.aborted) throw new ScanCancelledError();
  const catalogue = pinnedCatalogue(store);
  const id = nextId++;
  const out = await postJob(w, { type: 'scan', id, request, catalogue, nowMs: Date.now() }, { onProgress, signal });
  // The Worker keeps this comparison's inputs for one refinement, while it lives.
  if (worker === w) setRefinable({ id, worker: w });
  return { ...out, scanId: id };
}

/**
 * Release the inputs held for refining the comparison `scanId`, when it can no
 * longer be refined (it was dropped, the planner was left, its forecast was
 * replaced). They are the comparison's whole working set: its pinned store with
 * decoded tiles, routing grids, current grid and records. A Worker is told to drop
 * them; nothing happens for another comparison's id.
 * @param {number | null | undefined} scanId
 */
export function releaseRefinable(scanId) {
  if (scanId == null || refinable?.id !== scanId) return;
  const held = refinable;
  setRefinable(null);
  if (held.worker && held.worker === worker) held.worker.postMessage({ type: 'release', scanId });
}

/**
 * Refine the comparison `scanId` once, on the very inputs it ran with (see
 * runRefineAction for the result). Rejects with RefineUnavailableError when those
 * inputs are no longer held, without starting anything, and with
 * ScanCancelledError when `signal` aborts (which ends the Worker, and with it the
 * inputs). The caller checks first that the forecast runs and limits are still
 * the comparison's: a refinement never reads anything new, so it would refine an
 * outdated comparison.
 * @param {number} scanId  the `scanId` runScanJob resolved with
 * @param {{ onProgress?: (step: string) => void, signal?: AbortSignal }} [options]
 * @returns {ReturnType<typeof runRefineAction>}
 */
export async function runRefineJob(scanId, { onProgress = () => {}, signal } = {}) {
  if (signal?.aborted) throw new ScanCancelledError();
  if (!refineHeld(scanId)) throw new RefineUnavailableError();
  const held = refinable;
  setRefinable(null); // one refinement per comparison, whatever its outcome
  if (held.context) {
    const out = await runRefineAction(held.context, { onProgress });
    if (signal?.aborted) throw new ScanCancelledError();
    return out;
  }
  return postJob(held.worker, { type: 'refine', id: nextId++, scanId }, { onProgress, signal });
}
