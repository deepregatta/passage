import { useApp } from '../stores/appStore.js';
import { messageStatusLabel, renderBriefingField } from '../lib/briefingMessages.js';

/** Owns text and language changes, including literal fallback and parameter text. */
export default function BriefingMessage({ section, field, version = 1 }) {
  const language = useApp(s => s.language);
  const result = renderBriefingField(version, section, field, language);
  const problem = ['fallback', 'unavailable', 'unsupported'].includes(result.status);
  return (
    <span data-i18n-owned="message" data-message-field={field} data-message-status={result.status}>
      {problem && <span className="block font-sans text-[11px] text-verdict-insufficient" role="status">
        {messageStatusLabel(result.status, language)}
      </span>}
      {result.text}
    </span>
  );
}
