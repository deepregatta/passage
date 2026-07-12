const CAPABILITY_RULES = {
  sustained_wind: ['W-SUST-01', 'W-SUST-03'],
  gusts: ['W-GUST-01', 'W-GUST-03'],
  waves: ['S-WAVE-01', 'S-STEEP-01', 'S-CROSS-01', 'S-WAS-01'],
  visibility_and_convection: ['V-VIS-01', 'C-CAPE-01'],
  tidal_currents: ['T-WAC-01'],
  tidal_gates: ['T-GATE-01'],
  official_warnings: ['A-WARN-01'],
};

export function deriveCoverage(findings) {
  if (findings?.coverage?.length) return { items: findings.coverage, derived: false };
  const evidence = findings?.evidence ?? [];
  const ids = (capability) =>
    evidence
      .filter((item) => CAPABILITY_RULES[capability]?.includes(item.rule_id))
      .map((item) => item.evidence_id);
  const warningEvidence = evidence.filter((item) => item.rule_id === 'A-WARN-01');
  const warningStatus = warningEvidence.some((item) => item.source_kind === 'warning')
    ? 'assessed'
    : warningEvidence.some((item) => item.source_kind === 'emulated')
      ? 'assessed_emulated'
      : 'not_assessed';
  const unsupported = (findings?.unsupported_hazards ?? []).join(' ').toLowerCase();
  const item = (capability, status, detail) => ({
    capability,
    status,
    detail,
    evidence_ids: ids(capability),
  });
  return {
    derived: true,
    items: [
      item('sustained_wind', 'assessed', 'derived from wind evidence'),
      item('gusts', 'assessed', 'derived from gust evidence'),
      item('waves', evidence.some((e) => e.rule_id.startsWith('S-')) ? 'partially_assessed' : 'not_assessed', 'legacy snapshot'),
      item('tidal_currents', unsupported.includes('tidal current') ? 'not_assessed' : 'partially_assessed', 'legacy snapshot'),
      item('tidal_gates', unsupported.includes('tidal gate') ? 'not_assessed' : 'partially_assessed', 'legacy snapshot'),
      item('official_warnings', warningStatus, warningStatus === 'assessed_emulated' ? 'synthetic evidence; not authority' : 'derived from evidence source kind'),
      item('synoptic_attribution', 'not_assessed', 'legacy snapshot has no causal coverage record'),
      item('tropical_systems', 'not_assessed', 'legacy snapshot'),
      item('ice', 'not_assessed', 'legacy snapshot'),
    ],
  };
}

export function evidenceById(findings, evidenceId) {
  return findings?.evidence?.find((item) => item.evidence_id === evidenceId) ?? null;
}

export function worstEnsembleEvidence(findings, legId) {
  return [...(findings?.evidence ?? [])]
    .filter((item) => item.source_kind === 'ensemble' && item.member_fraction && (!legId || item.leg_id === legId))
    .sort((a, b) => b.member_fraction.exceed / b.member_fraction.total - a.member_fraction.exceed / a.member_fraction.total)[0] ?? null;
}

export function evidenceVariable(evidence) {
  if (!evidence) return 'gust';
  return evidence.rule_id.includes('GUST') ? 'gust' : 'wind';
}
