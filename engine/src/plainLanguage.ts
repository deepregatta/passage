/**
 * Shared English wording: the amateur layer never sees
 * rule ids, decimals, or a bare value/limit pair without a relation word.
 */

import { DEFAULT_APPROACHING_RATIO } from './limits.js';

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
  if (value >= DEFAULT_APPROACHING_RATIO * limit) return 'close to';
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

/** Short change-ledger labels and both briefing registers share one English vocabulary. */
export const VERDICT_TEXT: Record<string, { label: string; plain: string; pro: string }> = {
  within: {
    label: 'within your limits',
    plain: 'Forecast conditions stay inside the limits you declared for this departure.',
    pro: 'All evaluated condition-hours remain below declared thresholds.',
  },
  approaching: {
    label: 'close to your limits',
    plain: 'Forecast conditions come close to the limits you declared. Look at what is driving this before deciding.',
    pro: 'One or more condition-hours reach ≥75% of a declared limit, or the ensemble scenario fraction is above your declared floor.',
  },
  exceeds: {
    label: 'beyond your limits',
    plain: 'Forecast conditions go beyond the limits you declared for this departure.',
    pro: 'At least one condition-hour exceeds a declared threshold in the deterministic run.',
  },
  insufficient: {
    label: 'too uncertain to assess',
    plain: 'The forecasts disagree too much to assess this passage against your limits. Reassess after the next model run.',
    pro: 'Deterministic model divergence exceeds assessment tolerance within the passage window.',
  },
  warning_active: {
    label: 'official warning active',
    plain: 'An official marine warning covers part of your route. That takes precedence over everything below.',
    pro: 'Authority override active: an official bulletin covers route zones during the passage window.',
  },
};

export function verdictLabel(state: string) {
  return VERDICT_TEXT[state]?.label ?? state.replaceAll('_', ' ');
}
