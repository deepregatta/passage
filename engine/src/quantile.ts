/**
 * Quantile of an ascending-sorted array by linear interpolation between the
 * two nearest ranks (position (n - 1) * q). One definition shared by the
 * ensemble plume chart and the scenario-spread summary, so both read the same
 * numbers from the same members. Returns null for an empty array.
 */
export function quantile(sortedValues: readonly number[], q: number): number | null {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (pos - lo);
}
