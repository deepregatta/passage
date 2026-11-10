import { fmtLocalTime, localDateTimeToIso, toLocalDateTimeValue } from '../../lib/format.js';
import { FORECAST_HOURS, ROUTING_MIN_HOURS } from '../../lib/routingInputs.js';

/** Pure helpers behind the planner's departure control: forgiving time entry,
 * the forecast horizon, and the one place that decides whether a departure may
 * be planned. Compute, Scan and Check all consult validateDeparture. */

export const TIME_FORMAT_HINT = 'Enter the time as HH:mm, for example 08:30.';
export const INVALID_DEPARTURE = 'Enter a valid departure date and 24-hour time.';
export const PAST_DEPARTURE = 'Choose a departure that is not in the past';

/** A departure this far behind the clock still counts as "now" (the sailor typed
 * the current time a few minutes after it passed). */
export const PAST_GRACE_MS = 15 * 60_000;

/** The last departure the router can serve: it needs ROUTING_MIN_HOURS of
 * forecast after leaving, inside the FORECAST_HOURS tile horizon. */
export const LAST_DEPARTURE_LEAD_H = FORECAST_HOURS - ROUTING_MIN_HOURS;

const pad = (n) => String(n).padStart(2, '0');
const format = (h, m) => (h <= 23 && m <= 59 ? { ok: true, value: `${pad(h)}:${pad(m)}` } : { ok: false });

/**
 * Read a 24-hour time however a phone keypad or a keyboard produced it:
 * "8" "830" "0830" "8:30" "08.30" "8h30" all become HH:mm.
 * @returns {{ok: true, value: string} | {ok: false}}
 */
export function parseTimeInput(text) {
  const s = String(text ?? '').trim();
  let match = /^(\d{1,2})(?:[:.hH](\d{2})?)?$/.exec(s);
  if (match) return format(Number(match[1]), match[2] ? Number(match[2]) : 0);
  match = /^(\d{1,2})(\d{2})$/.exec(s);
  if (match) return format(Number(match[1]), Number(match[2]));
  return { ok: false };
}

/** Whether typed text is complete enough to commit while still being typed:
 * four digits or a full HH:mm. Anything shorter waits for blur. */
export const isCompleteTimeEntry = (text) => /^\d{4}$/.test(text) || /^\d{2}[:.]\d{2}$/.test(text);

/** The dates a departure may take and how to describe them. */
export function departureWindow(nowMs = Date.now()) {
  const maxMs = nowMs + LAST_DEPARTURE_LEAD_H * 3600_000;
  const localDate = (ms) => toLocalDateTimeValue(new Date(ms).toISOString()).slice(0, 10);
  return {
    nowMs,
    maxMs,
    minDate: localDate(nowMs),
    maxDate: localDate(maxMs),
    days: Math.floor(LAST_DEPARTURE_LEAD_H / 24),
    // "Fri 20 Nov": fmtLocalTime without its trailing " HH:mm"
    maxLabel: fmtLocalTime(new Date(maxMs).toISOString()).slice(0, -6),
  };
}

export function horizonText(window = departureWindow()) {
  return `Forecasts cover the next ${window.days} days, up to ${window.maxLabel}`;
}

/**
 * Why a departure cannot be planned, or null when it can. `dateIssue` marks the
 * reasons that are about the chosen day (past, beyond the forecast).
 * @returns {null | {code: 'invalid' | 'past' | 'beyond', message: string, dateIssue: boolean}}
 */
export function validateDeparture(departureLocal, nowMs = Date.now()) {
  const iso = localDateTimeToIso(departureLocal);
  if (!iso) return { code: 'invalid', message: INVALID_DEPARTURE, dateIssue: false };
  const ms = Date.parse(iso);
  if (ms < nowMs - PAST_GRACE_MS) return { code: 'past', message: PAST_DEPARTURE, dateIssue: true };
  const window = departureWindow(nowMs);
  if (ms > window.maxMs) {
    return {
      code: 'beyond', message: `Choose a departure within the forecast, up to ${window.maxLabel}`, dateIssue: true,
    };
  }
  return null;
}
