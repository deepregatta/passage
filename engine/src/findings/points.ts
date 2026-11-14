import { parseUtc } from '../eta.js';

/**
 * For each hour row of a leg (index-aligned with its hours), the audit sample
 * points read for it, as indices into the per-point forecast arrays: the
 * points the boat can be at in that hour (auditSampling.legHourCandidates), or,
 * for the expected timing, the one point the boat is at.
 */
export type HourPoints = ReadonlyArray<readonly number[]>;

const HOUR = 3_600_000;

/**
 * A lookup of a valid time (ms) in each point forecast's `times`, built once
 * per point when first asked (the last position of a repeated time, as before).
 */
export function pointTimeIndex(forecasts: ReadonlyArray<{ times: string[] } | null | undefined>) {
  const cache = new Map<number, (tMs: number) => number | undefined>();
  const build = (point: number) => {
    const times = forecasts[point]?.times ?? [];
    if (!times.length) return () => undefined;
    const known = lookups.get(times);
    if (known) return known;
    const lookup = buildLookup(times);
    lookups.set(times, lookup);
    return lookup;
  };
  return (point: number, tMs: number): number | undefined => {
    let lookup = cache.get(point);
    if (!lookup) {
      lookup = build(point);
      cache.set(point, lookup);
    }
    return lookup(tMs);
  };
}

/** One lookup per `times` array, shared by every evaluator that reads the same forecast. */
const lookups = new WeakMap<readonly string[], (tMs: number) => number | undefined>();

function buildLookup(times: readonly string[]): (tMs: number) => number | undefined {
  const parsed = times.map(parseUtc);
  const first = parsed[0]!;
  if (parsed.every((t, k) => t === first + k * HOUR)) {
    return (tMs: number) => {
      const k = (tMs - first) / HOUR;
      return Number.isInteger(k) && k >= 0 && k < times.length ? k : undefined;
    };
  }
  const index = new Map<number, number>();
  parsed.forEach((t, k) => index.set(t, k));
  return (tMs: number) => index.get(tMs);
}
