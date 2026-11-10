import BriefingMessage from '../../components/BriefingMessage.jsx';
import { useApp } from '../../stores/appStore.js';
import { EvidenceLink } from '../../components/common.jsx';
import { deriveCoverage } from '../../lib/evidenceSelectors.js';

/** Why the assessment reads as it does: the reasoning, once. Per-leg numbers live in the timeline
 * and leg table, counts in the Evidence section, capability coverage under "Models and coverage". */
export default function AssessmentDetails({ sections, findings }) {
  // The route-impact section only lists legs, which the timeline already shows; its method note
  // stays in the professional register below.
  const reasoning = sections.filter((section) => !section.per_leg);
  return (
    <div className="mt-3 space-y-4">
      {reasoning.map((section) => (
        <StorySection key={section.id} section={section} findings={findings} />
      ))}
      <ProfessionalRegister sections={sections} />
    </div>
  );
}

function StorySection({ section, findings }) {
  const version = useApp(s => s.briefing?.schema_version ?? 1);
  const decision = section.id === 'decision';
  const coverage = section.id === 'unsupported' ? deriveCoverage(findings) : null;
  const unassessed = coverage?.items.filter((item) => item.status === 'not_assessed') ?? [];
  const plain = coverage
    ? `Not assessed: ${unassessed.map((item) => item.detail ?? item.capability.replaceAll('_', ' ')).join(', ')}. No flag does not mean no risk.${coverage.derived ? ' Coverage derived conservatively from evidence in this legacy snapshot.' : ''}`
    : section.register_plain;
  const tone =
    section.id === 'warnings'
      ? 'border-l-4 border-authority pl-3'
      : section.id === 'unsupported' || section.id === 'emulated_disclosure'
        ? 'border-l-4 border-line pl-3'
        : '';

  return (
    <div className={tone}>
      <h3 className="eyebrow mb-1">{decision ? <BriefingMessage section={section} field="title" version={version} /> : section.title}</h3>
      <p className="font-sans text-[13px] leading-relaxed">{decision ? <BriefingMessage section={section} field="plain" version={version} /> : plain}</p>
    </div>
  );
}

/** One disclosure for the whole block: the engine's professional wording of every section above. */
function ProfessionalRegister({ sections }) {
  const version = useApp(s => s.briefing?.schema_version ?? 1);
  return (
    <details className="border-t hairline pt-1">
      <summary className="font-sans text-xs text-ink-soft cursor-pointer min-h-11 flex items-center">
        Professional register
      </summary>
      <div className="space-y-3 pb-1">
        {sections.map((section) => {
          const decision = section.id === 'decision';
          return (
            <div key={section.id}>
              <h4 className="font-sans text-xs font-medium">{decision ? <BriefingMessage section={section} field="title" version={version} /> : section.title}</h4>
              <p className="font-sans text-xs leading-relaxed text-ink-soft mt-0.5">
                {decision ? <BriefingMessage section={section} field="pro" version={version} /> : section.register_pro}
              </p>
              {section.evidence_ids.length > 0 && (
                <p className="mt-1 font-mono text-xs text-ink-soft">
                  evidence:{' '}
                  {section.evidence_ids.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <EvidenceLink evidenceId={id}>{id}</EvidenceLink>
                    </span>
                  ))}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
