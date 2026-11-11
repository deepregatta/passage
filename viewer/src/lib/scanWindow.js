import { FORECAST_HOURS } from './routingInputs.js';

/**
 * The one assessment window of a departure comparison: from the first
 * candidate's day to a day past the last candidate's arrival, capped at the
 * forecast horizon. Every candidate widens its own window to it, so all of them
 * read the same tiles. Shared by the scan and by the download quote.
 * @param {string[]} departures candidate departures, ISO UTC, earliest first
 * @param {number} passageHours the passage time the window allows for
 * @param {number} [nowMs]
 */
export function scanDateWindow(departures, passageHours, nowMs = Date.now()) {
  const endMs = Math.min(
    Date.parse(departures[departures.length - 1]) + (passageHours + 24) * 3600_000,
    nowMs + FORECAST_HOURS * 3600_000,
  );
  return {
    startDate: departures[0].slice(0, 10),
    endDate: new Date(Math.max(endMs, Date.parse(departures[0]))).toISOString().slice(0, 10),
  };
}
