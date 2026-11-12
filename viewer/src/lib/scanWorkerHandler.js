// What the scan Worker does with a request (scanWorker.js is only its wiring,
// so that tests can drive this without a Worker).
import { pinForecastStore } from './pinnedForecast.js';
import { runRefineAction, runScanAction } from './scanAction.js';
import { REFINE_UNAVAILABLE_CODE, serializeError } from './scanMessages.js';

/**
 * @param {(message: object) => void} post
 * @param {{ pinStore?: typeof pinForecastStore, run?: typeof runScanAction, refine?: typeof runRefineAction }} [deps]
 */
export function createScanHandler(post, { pinStore = pinForecastStore, run = runScanAction, refine = runRefineAction } = {}) {
  // The last finished comparison's inputs, for one refinement of it ({id, context}).
  // Held here, on this thread: they never cross back to the page.
  let held = null;
  return async (data) => {
    // The page has dropped the comparison: free its inputs now rather than at the next comparison.
    if (data?.type === 'release') {
      if (held?.id === data.scanId) held = null;
      return;
    }
    if (data?.type === 'refine') {
      const { id, scanId } = data;
      // One refinement per comparison: the inputs are released whatever its outcome.
      const context = held?.id === scanId ? held.context : null;
      held = null;
      if (!context) {
        post({ type: 'error', id, error: { name: 'Error', message: 'refine-unavailable', code: REFINE_UNAVAILABLE_CODE, gone: null } });
        return;
      }
      try {
        const out = await refine(context, { onProgress: (step) => post({ type: 'progress', id, step }) });
        post({ type: 'done', id, out });
      } catch (error) {
        post({ type: 'error', id, error: serializeError(error) });
      }
      return;
    }
    if (data?.type !== 'scan') return;
    const { id, request, catalogue, nowMs } = data;
    held = null;
    // The page's clock, not this thread's: departures, horizons and record
    // times are judged from the moment the page started the action.
    const offset = nowMs - Date.now();
    const now = () => Date.now() + offset;
    try {
      const store = await pinStore(catalogue, { now });
      let context = null;
      const out = await run(request, {
        store, now, onProgress: (step) => post({ type: 'progress', id, step }), keepContext: (kept) => { context = kept; },
      });
      if (context) held = { id, context };
      post({ type: 'done', id, out });
    } catch (error) {
      post({ type: 'error', id, error: serializeError(error) });
    }
  };
}
