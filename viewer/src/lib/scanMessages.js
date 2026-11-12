// Errors cross the scan Worker's boundary as plain data: structured clone keeps
// neither an error's class nor its own fields, and the page needs both to know
// that a forecast run was deleted (withFreshForecast then refreshes and retries).
import { ForecastRunGoneError, forecastRunGone } from '@deepweather/engine';
import { ForecastUpdatedError } from './forecastFreshness.js';

/** @param {unknown} error */
export function serializeError(error) {
  const gone = forecastRunGone(error);
  const e = /** @type {{ name?: string, message?: string, code?: unknown }} */ (error ?? {});
  return {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: error instanceof Error ? error.message : String(error ?? ''),
    code: typeof e.code === 'string' ? e.code : null,
    gone: gone ? { layer: gone.layer, runId: gone.runId } : null,
  };
}

/** The error the page throws for a serialized one. @param {ReturnType<typeof serializeError>} data */
export function rebuildError(data) {
  if (data.code === 'forecast-updated') return new ForecastUpdatedError();
  if (data.gone) {
    const gone = new ForecastRunGoneError(data.gone.layer, data.gone.runId);
    return data.message === gone.message ? gone : new Error(data.message, { cause: gone });
  }
  const error = new Error(data.message);
  error.name = data.name;
  if (data.code) Object.assign(error, { code: data.code });
  return error;
}
