// @ts-check
import { formatMessageTime, renderDecisionMessage, renderDecisionRegister } from '@deepweather/engine';
import { translateText } from '../i18n.js';

const unit = (/** @type {string} */ u) => u === 'kt' ? 'nd' : u;
const hazard = { gusts: 'rafales', winds: 'vents', seas: 'mers', 'wind against the tide': 'vent contre la marée', 'squall risk': 'risque de grains', visibility: 'visibilité', conditions: 'conditions' };
const relation = { over: 'au-dessus de', 'close to': 'proches de', under: 'sous', below: 'sous', above: 'au-dessus de' };

/** @satisfies {import('@deepweather/engine').DecisionMessageCatalogue} */
export const FR_DECISION_MESSAGES = {
  'briefing.decision.title.v1': () => 'Par rapport à vos limites déclarées',
  'briefing.decision.within.plain.v1': () => 'Les conditions prévues restent dans les limites que vous avez déclarées pour ce départ.',
  'briefing.decision.within.pro.v1': () => 'Toutes les conditions horaires évaluées restent sous les seuils déclarés.',
  'briefing.decision.approaching.plain.v1': () => 'Les conditions prévues approchent des limites que vous avez déclarées. Examinez la cause avant de décider.',
  'briefing.decision.approaching.pro.v1': () => 'Une ou plusieurs conditions horaires atteignent au moins 75 % d’une limite déclarée, ou la fraction de scénarios d’ensemble dépasse votre seuil déclaré.',
  'briefing.decision.exceeds.plain.v1': () => 'Les conditions prévues dépassent les limites que vous avez déclarées pour ce départ.',
  'briefing.decision.exceeds.pro.v1': () => 'Au moins une condition horaire dépasse un seuil déclaré dans le cycle déterministe.',
  'briefing.decision.insufficient.plain.v1': () => 'Les prévisions divergent trop pour évaluer cette traversée par rapport à vos limites. Réévaluez-la après le prochain cycle du modèle.',
  'briefing.decision.insufficient.pro.v1': () => 'La divergence des modèles déterministes dépasse la tolérance d’évaluation pendant la fenêtre de traversée.',
  'briefing.decision.warning_active.plain.v1': () => 'Une alerte marine officielle couvre une partie de votre route. Elle prévaut sur tout ce qui suit.',
  'briefing.decision.warning_active.pro.v1': () => 'Priorité active à l’autorité : un bulletin officiel couvre des zones de la route pendant la fenêtre de traversée.',
  'briefing.decision.numeric.plain.v1': (p) => {
    const u = p.units ? ` ${unit(p.units)}` : '';
    const claim = p.style === 'down_to'
      ? `visibilité réduite à ${Math.round(p.value)}${u}, ${relation[p.relation]} votre minimum de ${p.limit}${u}`
      : p.style === 'just_over'
        ? `${hazard[p.hazard]} juste au-dessus de votre limite de ${p.limit}${u}`
        : `${hazard[p.hazard]} jusqu’à ${Math.round(p.value)}${u}, ${relation[p.relation]} votre limite de ${p.limit}${u}`;
    return `Signal principal : ${claim} sur ${p.leg_name} vers ${formatMessageTime(p.valid_time, 'fr')} UTC.`;
  },
  'briefing.decision.numeric.pro.v1': (p) => `Facteur déterminant : ${p.rule_id} sur ${p.leg_id} à ${p.valid_time}; ${p.value} ${unit(p.units)} contre une limite déclarée de ${p.limit} ${unit(p.units)}.`,
  'briefing.decision.ensemble.plain.v1': (p) => {
    const scenario = p.total === 1 ? 'scénario de prévision' : 'scénarios de prévision';
    const share = p.exceed === 0 ? p.total === 1 ? 'aucun scénario de prévision ne dépasse' : `aucun des ${p.total} ${scenario} ne dépasse` : p.exceed === p.total
      ? p.total === 1 ? 'le scénario de prévision dépasse' : `les ${p.total} ${scenario} dépassent`
      : `${p.exceed} ${p.exceed === 1 ? 'scénario' : 'scénarios'} sur ${p.total} ${p.exceed === 1 ? 'dépasse' : 'dépassent'}`;
    return `Signal principal : ${share} votre limite de ${p.limit} nd sur ${p.leg_name} vers ${formatMessageTime(p.valid_time, 'fr')} UTC.`;
  },
  'briefing.decision.ensemble.pro.v1': (p) => `Facteur déterminant : ${p.rule_id} sur ${p.leg_id} à ${p.valid_time}; ${p.exceed} membres sur ${p.total} > ${p.limit} ${unit(p.units)}.`,
};

/** Read adapter: no inference of IDs, persistence rewrite, or recomputation.
 * A damaged sentence falls back to the entire stored field, including caveats.
 * @param {number} version
 * @param {{id?: string, title?: string, register_plain?: string, register_pro?: string, messages?: any}} section
 * @param {'title' | 'plain' | 'pro'} field
 * @param {'en' | 'fr'} language
 * @param {import('@deepweather/engine').DecisionMessageCatalogue} [french]
 */
export function renderBriefingField(version, section, field, language, french = FR_DECISION_MESSAGES) {
  const saved = field === 'title' ? section.title : section[`register_${field}`];
  const unavailable = language === 'fr' ? 'Contenu de décision indisponible.' : 'Decision content unavailable.';
  if (version !== 1) return { text: language === 'fr' ? 'Version du briefing non prise en charge.' : 'Unsupported briefing version.', status: 'unsupported' };
  const messages = section.messages;
  const hasMetadata = messages !== undefined;
  const validContainer = messages !== null && typeof messages === 'object' && !Array.isArray(messages)
    && Object.keys(messages).every(key => ['title', 'plain', 'pro'].includes(key))
    && Object.hasOwn(messages, 'title')
    && Object.hasOwn(messages, 'plain') === Object.hasOwn(messages, 'pro');
  const refs = messages?.[field];
  if (!hasMetadata || validContainer && refs === undefined && field !== 'title') {
    return typeof saved === 'string' && saved.length > 0
      ? { text: translateText(saved, language), status: 'legacy' }
      : { text: unavailable, status: 'unavailable' };
  }
  const catalogue = language === 'fr' ? french : undefined;
  const text = !validContainer ? null : field === 'title' ? renderDecisionMessage(refs, catalogue) : renderDecisionRegister(refs, catalogue);
  if (text !== null) return { text, status: 'translated' };
  return typeof saved === 'string' && saved.length > 0 ? { text: saved, status: 'fallback' } : { text: unavailable, status: 'unavailable' };
}

/** @param {string} status @param {'en' | 'fr'} language */
export function messageStatusLabel(status, language) {
  if (status === 'fallback') return language === 'fr' ? 'Texte original en anglais · traduction indisponible' : 'Original English text · translation unavailable';
  return language === 'fr' ? 'Contenu indisponible' : 'Content unavailable';
}
