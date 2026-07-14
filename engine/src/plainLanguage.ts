/**
 * Plain-register wording helpers (brief §8): the amateur layer never sees
 * rule ids, decimals, or a bare value/limit pair without a relation word.
 */

/** Rule family → the plain noun used in amateur sentences. */
export function hazardNoun(ruleId: string | null): string {
  if (!ruleId) return 'conditions';
  if (ruleId.startsWith('W-GUST')) return 'gusts';
  if (ruleId.startsWith('W-SUST')) return 'winds';
  if (ruleId.startsWith('S-')) return 'seas';
  if (ruleId.startsWith('T-WAC')) return 'wind against the tide';
  if (ruleId.startsWith('C-CAPE')) return 'squall risk';
  if (ruleId.startsWith('V-VIS')) return 'visibility';
  return 'conditions';
}

/** Relation word for a ceiling-type limit. 75% matches the verdict "approaching" threshold. */
export function limitRelation(value: number, limit: number): 'over' | 'close to' | 'under' {
  if (value > limit) return 'over';
  if (value >= 0.75 * limit) return 'close to';
  return 'under';
}

/**
 * "gusts up to 39 kt, over your 28 kt limit" / "visibility down to 0.5 nm,
 * below your 2 nm minimum". Whole numbers only; the pro register keeps the
 * exact values.
 */
export function plainValueVsLimit(
  ruleId: string | null,
  value: number,
  limit: number,
  units: string | null,
): string {
  const u = units ? ` ${units}` : '';
  if (ruleId?.startsWith('V-VIS')) {
    const relation = value < limit ? 'below' : 'above';
    return `visibility down to ${Math.round(value)}${u}, ${relation} your ${limit}${u} minimum`;
  }
  const rounded = Math.round(value);
  const relation = limitRelation(value, limit);
  if (relation === 'over' && rounded <= limit) {
    return `${hazardNoun(ruleId)} just over your ${limit}${u} limit`;
  }
  return `${hazardNoun(ruleId)} up to ${rounded}${u}, ${relation} your ${limit}${u} limit`;
}
