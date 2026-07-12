export const ruleLabels = {
  'W-GUST-01': 'gust limit',
  'W-GUST-03': 'ensemble gust crossing',
  'W-SUST-01': 'sustained-wind limit',
  'W-SUST-03': 'ensemble wind crossing',
  'A-WARN-01': 'marine warning',
  'S-WAVE-01': 'wave-height limit',
  'D-DIVERGE-01': 'model disagreement',
};

export function deriveChangeStory(changes, briefing) {
  if (changes?.story) return changes.story;
  const ranked = [...(changes?.entries ?? [])].map((entry, index) => ({ entry, index, score: entry.kind === 'verdict_changed' ? 100 : entry.kind === 'event_shifted' ? 70 : entry.kind === 'value_changed' ? 60 : entry.rule_id === 'A-WARN-01' ? 40 : 0 })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
  return {
    headline_plain: changes?.verdict_transition?.from !== changes?.verdict_transition?.to ? `The assessment changed from ${changes.verdict_transition.from} to ${changes.verdict_transition.to}.` : `The assessment remains ${changes?.verdict_transition?.to ?? 'unchanged'}, with updated detail.`,
    headline_pro: 'Client-derived story for a legacy changes artifact; the full ledger remains authoritative.',
    material: ranked.map(({ entry, index }) => ({ change_ref: index, before: entry.previous ?? null, after: entry.latest ?? null, why_it_matters: entry.description, evidence_ids: entry.evidence_pair ?? [] })),
    next_run: briefing?.next_run ?? briefing?.next_runs?.[0] ?? null,
  };
}
