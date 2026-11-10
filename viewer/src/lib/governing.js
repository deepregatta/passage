import { governingReason } from '@deepweather/engine';

/**
 * governingReason for saved findings, or null for findings the engine cannot
 * read. The profile only matters for a `within` margin; the engine ignores one
 * whose hash differs from findings.inputs.profile_hash.
 */
export function safeGoverningReason(findings, profile) {
  if (!findings) return null;
  try {
    return governingReason(findings, { profile: profile ?? undefined });
  } catch {
    return null;
  }
}

/** The ensemble claim the top sentence quotes (same leg, limit kind and hour), for the Evidence headline. */
export function governingClaim(findings, reason) {
  const result = reason?.result;
  if (!findings || !result || !['wind', 'gust'].includes(result.limit.kind)) return null;
  const family = result.limit.kind === 'gust' ? 'W-GUST' : 'W-SUST';
  const claims = findings.evidence.filter((e) => e.source_kind === 'ensemble' && e.member_fraction
    && e.leg_id === result.leg.leg_id && e.rule_id.startsWith(family));
  return claims.find((e) => e.evidence_id === result.evidence_id)
    ?? claims.find((e) => e.valid_time === result.scenarios?.valid_time)
    ?? claims[0] ?? null;
}

/**
 * The page's initial selection when a check opens: the claim and leg the verdict
 * sentence names, so Evidence, the timeline and the top sentence start on the same
 * claim. Falls back to the verdict driver for checks with no governing claim.
 */
export function initialSelection(findings, profile) {
  const reason = safeGoverningReason(findings, profile);
  const claim = governingClaim(findings, reason);
  const driver = findings.evidence.find((e) => e.evidence_id === findings.verdict.driver_evidence_id);
  const legId = reason?.result?.leg.leg_id ?? reason?.disagreement?.leg.leg_id ?? driver?.leg_id ?? findings.legs[0]?.leg_id ?? null;
  const evidenceId = claim?.evidence_id ?? reason?.result?.evidence_id ?? findings.verdict.driver_evidence_id
    ?? findings.evidence.find((item) => item.member_fraction)?.evidence_id ?? null;
  return { selectedLegId: legId, selectedEvidenceId: evidenceId };
}
