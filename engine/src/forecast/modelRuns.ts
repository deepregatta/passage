/**
 * One model published as several layers at different cycles. ECMWF's open
 * data runs four times a day, but only its 00Z/12Z cycles reach 240 h
 * (`weather-ecmwf`); the 06Z/18Z cycles stop at 144 h and are their own
 * layer, `weather-ecmwf-short` (grib-export-plan Phase 5C). A reader takes,
 * for each forecast time, the newest cycle that covers it; a GRIB file, which
 * holds one reference time, takes the newest run covering its whole period.
 */

import { parseUtc } from '../eta.js';
import type { RunManifest } from './store.js';

/** ECMWF's layers, the full-horizon one first. */
export const ECMWF_LAYERS = ['weather-ecmwf', 'weather-ecmwf-short'] as const;

const HOUR_MS = 3_600_000;

/** Where one run's forecast times lie. */
export interface RunSpan {
  layer: string;
  run_id: string;
  cycleMs: number;
  /** first and last valid time on the axis of the variable the span was taken from */
  startMs: number;
  endMs: number;
}

/** The span of a run's axis for `variable`, or null when the run does not list it. */
export function runSpan(manifest: RunManifest, variable: string): RunSpan | null {
  const listed = manifest.variables.find((v) => v.name === variable && !v.per_member);
  const axis = listed ? manifest.time_axes[listed.axis] : undefined;
  if (!axis?.offsets_h.length) return null;
  const baseMs = parseUtc(axis.base);
  return {
    layer: manifest.layer,
    run_id: manifest.run_id,
    cycleMs: parseUtc(manifest.cycle),
    startMs: baseMs + Math.min(...axis.offsets_h) * HOUR_MS,
    endMs: baseMs + Math.max(...axis.offsets_h) * HOUR_MS,
  };
}

/** Newer cycle first; for one cycle in two layers, the longer horizon, then the first listed. */
function newer(a: RunSpan, b: RunSpan): boolean {
  return a.cycleMs !== b.cycleMs ? a.cycleMs > b.cycleMs : a.endMs > b.endMs;
}

function newestOf(spans: ReadonlyArray<RunSpan | null>, covers: (span: RunSpan) => boolean): number {
  let best = -1;
  spans.forEach((span, i) => {
    if (span && covers(span) && (best < 0 || newer(span, spans[best]!))) best = i;
  });
  return best;
}

/** Index of the newest run whose axis covers the time, or −1 when none does. */
export function newestRunAt(spans: ReadonlyArray<RunSpan | null>, timeMs: number): number {
  return newestOf(spans, (span) => span.startMs <= timeMs && timeMs <= span.endMs);
}

/** Index of the newest run whose axis covers the whole period, or −1 when none does. */
export function newestRunCovering(spans: ReadonlyArray<RunSpan | null>, startMs: number, endMs: number): number {
  return newestOf(spans, (span) => span.startMs <= startMs && endMs <= span.endMs);
}

/** A run's share of a combined series: the valid times it served, as hourly ranges. */
export interface ServedRange {
  from: string;
  to: string;
}

/** "06Z" for a cycle. */
export function cycleHourLabel(cycle: string): string {
  return `${String(new Date(parseUtc(cycle)).getUTCHours()).padStart(2, '0')}Z`;
}

/**
 * The ECMWF runs behind a briefing's model comparison, from the newest cycle
 * on, e.g. "ECMWF 06Z to +144 h, then 00Z", or "ECMWF 12Z" when one run
 * served every time from its cycle on. Times before the newest cycle (the
 * analysis day's early hours) are left out: they are past when that cycle is
 * published. Reads the `served` ranges recorded in findings.inputs; null for
 * a briefing whose ECMWF series came from one run.
 */
export function describeEcmwfRuns(inputs: ReadonlyArray<Record<string, unknown>>): string | null {
  const runs = inputs.flatMap((input) => {
    const served = input.served;
    if (!(ECMWF_LAYERS as readonly unknown[]).includes(input.layer) || typeof input.cycle !== 'string') return [];
    if (!Array.isArray(served) || !served.length) return [];
    return [{ cycle: input.cycle, cycleMs: parseUtc(input.cycle), served: served as ServedRange[] }];
  });
  if (!runs.length) return null;
  const newestMs = Math.max(...runs.map((run) => run.cycleMs));
  const segments = runs
    .flatMap((run) => run.served.map((range) => ({ run, fromMs: parseUtc(range.from), toMs: parseUtc(range.to) })))
    .filter((segment) => segment.toMs >= newestMs)
    .sort((a, b) => a.fromMs - b.fromMs);
  if (!segments.length) return null;
  let label = `ECMWF ${cycleHourLabel(segments[0]!.run.cycle)}`;
  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1]!;
    const lead = Math.round((before.toMs - before.run.cycleMs) / HOUR_MS);
    label += ` to +${lead} h, then ${cycleHourLabel(segments[i]!.run.cycle)}`;
  }
  return label;
}
