import type { Evidence } from '../types.js';
import { RULES } from './rules.js';

/** Each leg gets its own collector; the offset preserves passage-wide IDs. */
export function createEvidenceCollector(offset = 0) {
  const evidence: Evidence[] = [];
  const nextEvidence = (partial: Omit<Evidence, 'evidence_id'>): Evidence => {
    const entry = { evidence_id: `E${offset + evidence.length + 1}`, ...partial };
    evidence.push(entry);
    return entry;
  };
  return { evidence, nextEvidence };
}

/** Higher means worse: visibility is a minimum, other numeric limits are maxima. */
export function evidenceLimitRatio(item: Evidence): number | null {
  if (typeof item.value !== 'number' || typeof item.limit !== 'number' || item.limit <= 0) return null;
  return item.rule_id === RULES.VISIBILITY ? item.limit / item.value : item.value / item.limit;
}
