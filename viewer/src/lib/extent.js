/**
 * Math.min / Math.max over a list of any length. Spreading a check's list into
 * Math.min(...values) throws a RangeError once it is long enough (200,000
 * values in Node; Safari's limit is believed lower), and the page then breaks
 * (2026-11-15). These loops give the same results as the spread: NaN when a
 * value is not a number, Infinity / -Infinity for an empty list.
 */
export function minOf(values) {
  let min = Infinity;
  for (const value of values) min = Math.min(min, value);
  return min;
}

export function maxOf(values) {
  let max = -Infinity;
  for (const value of values) max = Math.max(max, value);
  return max;
}
