import { passageLimitHours } from '@deepweather/engine';

/**
 * Hours of the open check's arrival range that miss a forecast value one of its
 * limits needs, read from the saved `findings.legs` only, so older saved checks
 * get it too and nothing archived is rewritten. The verdict ignores these hours.
 *
 * Counted with the departure grid's rule (passageLimitHours): distinct valid times,
 * a time over a limit counts as over, not as missing. The limits are those the
 * check recorded a status for in any hour, "unknown" included: a declared layer
 * with no value anywhere on this passage (every wave point land-masked, a wind
 * beyond the forecast horizon) is missing here, where a scan-wide count across
 * departures leaves it out. A layer never recorded (no marine input at all, or a
 * steepness with no wave period anywhere) is reported by the coverage panel instead.
 * @param {any} findings
 * @returns {number}
 */
export function missingForecastHours(findings) {
  const limits = recordedLimits(findings);
  if (!limits.size) return 0;
  return passageLimitHours(findings, { limits }).arrival_hours_no_data;
}

/** Limit keys the check recorded a status for in any hour, "unknown" included. */
export function recordedLimits(findings) {
  const limits = new Set();
  for (const leg of findings?.legs ?? []) {
    for (const hour of leg.hours ?? []) {
      for (const key of Object.keys(hour.limit_status ?? {})) limits.add(key);
    }
  }
  return limits;
}
