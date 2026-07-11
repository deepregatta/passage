/**
 * Verdict states (brief §7). The app NEVER says "GO".
 *   within | approaching | exceeds | insufficient | warning_active
 * An active official warning is an authority state that overrides the
 * personal-limit summary (it does not claim a numeric limit was exceeded).
 */

import type { Evidence, VerdictState } from './types.js';

export interface VerdictInput {
  /** worst value/limit ratio observed across all evaluated condition-hours */
  worstRatio: number | null;
  anyExceeded: boolean;
  anyApproaching: boolean;
  /** M2+: max ensemble exceedance fraction vs profile floor */
  scenarioFractionAboveFloor?: boolean;
  /** M3+: model disagreement makes the assessment unstable */
  insufficientConfidence?: boolean;
  /** M9+: active official warning covering the route */
  warningActive?: boolean;
  warningBulletinRef?: string | null;
  driverEvidenceId: string | null;
}

export function decideVerdict(input: VerdictInput): {
  state: VerdictState;
  driver_evidence_id: string | null;
  warning_override: { active: boolean; bulletin_ref: string | null };
} {
  const warning_override = {
    active: Boolean(input.warningActive),
    bulletin_ref: input.warningBulletinRef ?? null,
  };

  let state: VerdictState;
  if (warning_override.active) {
    state = 'warning_active';
  } else if (input.insufficientConfidence) {
    state = 'insufficient';
  } else if (input.anyExceeded) {
    state = 'exceeds';
  } else if (input.anyApproaching || input.scenarioFractionAboveFloor) {
    state = 'approaching';
  } else {
    state = 'within';
  }

  return { state, driver_evidence_id: input.driverEvidenceId, warning_override };
}

/** Pick the evidence with the worst value/limit ratio as the verdict driver. */
export function worstEvidence(
  candidates: Array<{ evidence: Evidence; ratio: number }>,
): { evidence: Evidence; ratio: number } | null {
  let worst: { evidence: Evidence; ratio: number } | null = null;
  for (const c of candidates) {
    if (!worst || c.ratio > worst.ratio) worst = c;
  }
  return worst;
}
