/**
 * Display-time reading of the next-run estimate frozen in a briefing
 * (`briefing.next_runs`, computed by `nextForecastRuns` at analysis time).
 * The viewer calls this with the current clock, so a saved check opened later
 * never shows a time that has already passed, and an estimate a few minutes
 * away is said as "due now" rather than as a precise-looking clock time.
 */

import type { NextForecastRun } from './briefing.js';
import { cycleHourLabel } from './forecast/modelRuns.js';

/** An estimate this close (or closer) is "due", not a clock time. */
export const NEXT_RUN_DUE_MINUTES = 15;
/** Publication jitter tolerated after the estimate before it counts as overdue. */
export const NEXT_RUN_GRACE_MINUTES = 30;

const MODEL_NAMES: Record<string, string> = {
  gfs_0p25: 'GFS',
  ecmwf_ifs_0p25: 'ECMWF',
  gefs_0p50: 'GEFS',
  gfswave_0p25: 'GFS-Wave',
  cmems_glo12: 'Copernicus GLO12',
  cmems_ibi: 'Copernicus IBI',
  dwd_icon_eu_0p0625: 'ICON-EU',
  meteofrance_arome_france_0p025: 'AROME',
  ukmo_uk_deterministic_2km_0p025: 'UKV',
};

/** Short public name for a forecast model id; unknown ids are returned unchanged. */
export function modelDisplayName(model: string): string {
  return MODEL_NAMES[model] ?? model;
}

interface RunLabel {
  model: string;
  /** e.g. "GFS" */
  model_name: string;
  /** expected cycle hour, e.g. "18Z"; null for briefings saved without a cycle */
  cycle: string | null;
}

export type NextRunDescription =
  /** expected_at is more than NEXT_RUN_DUE_MINUTES after now */
  | (RunLabel & { kind: 'future'; expected_at: string; minutes_until: number })
  /** from NEXT_RUN_DUE_MINUTES before to NEXT_RUN_GRACE_MINUTES after the estimate: say "due now", no time */
  | (RunLabel & { kind: 'due' })
  /** every estimate passed more than the grace ago: newer forecasts are likely out, no estimate */
  | (RunLabel & { kind: 'overdue'; minutes_late: number })
  /** no usable estimate */
  | { kind: 'none' };

const MINUTE_MS = 60_000;

function label(run: NextForecastRun): RunLabel {
  const cycleOk = typeof run.cycle === 'string' && Number.isFinite(Date.parse(run.cycle));
  return {
    model: run.model,
    model_name: modelDisplayName(run.model),
    cycle: cycleOk ? cycleHourLabel(run.cycle!) : null,
  };
}

/**
 * The next forecast update as of `nowIso`. Accepts `briefing.next_runs` (preferred:
 * an overdue first entry falls through to a later one) or the `next_run` alias.
 * A `future` result's `expected_at` is always more than NEXT_RUN_DUE_MINUTES after now.
 */
export function describeNextRun(
  next: NextForecastRun | readonly NextForecastRun[] | null | undefined,
  nowIso: string,
): NextRunDescription {
  const now = Date.parse(nowIso);
  const runs: readonly NextForecastRun[] = next ? (Array.isArray(next) ? next : [next as NextForecastRun]) : [];
  const valid = runs
    .filter((run) => typeof run?.model === 'string' && Number.isFinite(Date.parse(run.expected_at)))
    .sort((a, b) => Date.parse(a.expected_at) - Date.parse(b.expected_at));
  if (!Number.isFinite(now) || !valid.length) return { kind: 'none' };
  const upcoming = valid.find((run) => Date.parse(run.expected_at) >= now - NEXT_RUN_GRACE_MINUTES * MINUTE_MS);
  if (!upcoming) {
    const last = valid[valid.length - 1]!;
    return {
      kind: 'overdue', ...label(last),
      minutes_late: Math.floor((now - Date.parse(last.expected_at)) / MINUTE_MS),
    };
  }
  const untilMs = Date.parse(upcoming.expected_at) - now;
  if (untilMs <= NEXT_RUN_DUE_MINUTES * MINUTE_MS) return { kind: 'due', ...label(upcoming) };
  return {
    kind: 'future', ...label(upcoming),
    expected_at: upcoming.expected_at,
    minutes_until: Math.round(untilMs / MINUTE_MS),
  };
}
