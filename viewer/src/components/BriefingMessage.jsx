import { useApp } from '../stores/appStore.js';
import { messageStatusLabel, renderBriefingField } from '../lib/briefingMessages.js';
import { translateText } from '../i18n.js';
import { fmtTextTime } from '../lib/format.js';
import { legLabel } from '../pages/briefing/routeLabels.jsx';

/** The plain register names a leg by place and number and gives times in the header zone, like the verdict sentence. */
function localizeFor(findings) {
  if (!findings?.legs) return undefined;
  return {
    departure: findings.departure_utc,
    leg: (name, language) => {
      // only a leg named "A → B" has a place to show; any other name stays as recorded
      const leg = name.includes('→') ? findings.legs.find((item) => item.name === name) : undefined;
      return leg ? translateText(legLabel(findings, leg.leg_id), language) : null;
    },
    time: (iso, language) => translateText(fmtTextTime(iso), language),
  };
}

/** Owns text and language changes, including literal fallback and parameter text. */
export default function BriefingMessage({ section, field, version = 1, omitScenarioCount = false, describeDriver }) {
  const language = useApp(s => s.language);
  const findings = useApp(s => s.findings);
  const result = renderBriefingField(version, section, field, language, undefined, { omitScenarioCount, describeDriver, localize: localizeFor(findings) });
  const problem = ['fallback', 'unavailable', 'unsupported'].includes(result.status);
  return (
    <span data-i18n-owned="message" data-message-field={field} data-message-status={result.status}>
      {problem && <span className="block font-sans text-xs text-verdict-insufficient" role="status">
        {messageStatusLabel(result.status, language)}
      </span>}
      {result.text}
    </span>
  );
}
