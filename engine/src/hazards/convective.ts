/**
 * Convective screening: CAPE (+ convective precip context) is a WEAK
 * proxy for localized squalls. Output is a labeled screening level; "elevated
 * squall potential"; never a precise prediction, and never an 'exceeds' driver.
 * Official warnings are the authority for storms.
 */

export type SquallPotential = 'low' | 'elevated' | 'high';

export function squallPotential(capeJkg: number | null): SquallPotential | null {
  if (capeJkg === null || !Number.isFinite(capeJkg)) return null;
  if (capeJkg >= 1000) return 'high';
  if (capeJkg >= 300) return 'elevated';
  return 'low';
}
