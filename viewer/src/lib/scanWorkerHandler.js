// What the scan Worker does with a request (scanWorker.js is only its wiring,
// so that tests can drive this without a Worker).
import { pinForecastStore } from './pinnedForecast.js';
import { runScanAction } from './scanAction.js';
import { serializeError } from './scanMessages.js';

/**
 * @param {(message: object) => void} post
 * @param {{ pinStore?: typeof pinForecastStore, run?: typeof runScanAction }} [deps]
 */
export function createScanHandler(post, { pinStore = pinForecastStore, run = runScanAction } = {}) {
  return async (data) => {
    if (data?.type !== 'scan') return;
    const { id, request, catalogue, nowMs } = data;
    // The page's clock, not this thread's: departures, horizons and record
    // times are judged from the moment the page started the action.
    const offset = nowMs - Date.now();
    const now = () => Date.now() + offset;
    try {
      const store = await pinStore(catalogue, { now });
      const out = await run(request, { store, now, onProgress: (step) => post({ type: 'progress', id, step }) });
      post({ type: 'done', id, out });
    } catch (error) {
      post({ type: 'error', id, error: serializeError(error) });
    }
  };
}
