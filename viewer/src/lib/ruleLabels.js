// Short UI labels and longer archived-ledger subjects intentionally differ.
// Keep both forms and their French translations together for each rule.
const rule = (label, fr, subject = label, subjectFr = fr) => ({ label, fr, subject, subjectFr });
const rules = {
  'W-GUST-01': rule('gusts', 'rafales', 'gusts vs your limit', 'rafales par rapport à votre limite'),
  'W-GUST-03': rule('gust scenarios over your limit', 'scénarios de rafales au-dessus de votre limite'),
  'W-SUST-01': rule('wind', 'vent', 'sustained wind vs your limit', 'vent moyen par rapport à votre limite'),
  'W-SUST-03': rule('wind scenarios over your limit', 'scénarios de vent au-dessus de votre limite'),
  'A-WARN-01': rule('marine warning', 'alerte marine', 'official marine warning', 'alerte marine officielle'),
  'S-WAVE-01': rule('wave-height limit', 'limite de hauteur de vagues', 'wave height vs your limit', 'hauteur de vagues par rapport à votre limite'),
  'S-CROSS-01': rule('cross-sea', 'mer croisée'),
  'S-STEEP-01': rule('steep waves', 'vagues cambrées'),
  'S-WAS-01': rule('wind against swell', 'vent contre houle'),
  'T-WAC-01': rule('wind against current', 'vent contre courant'),
  'T-GATE-01': rule('tidal gate', 'porte de marée', 'tidal gate fit', 'compatibilité de porte de marée'),
  'C-CAPE-01': rule('thunderstorm potential', 'potentiel orageux'),
  'V-VIS-01': rule('visibility', 'visibilité'),
  'D-DIVERGE-01': rule('model disagreement', 'divergence des modèles'),
};

export const ruleLabels = Object.fromEntries(Object.entries(rules).map(([id, entry]) => [id, entry.label]));
export const ruleLabelTranslations = Object.fromEntries(Object.values(rules).map(({ label, fr }) => [label, fr]));
export const ruleSubjectTranslations = Object.fromEntries(Object.values(rules).map(({ subject, subjectFr }) => [subject, subjectFr]));
