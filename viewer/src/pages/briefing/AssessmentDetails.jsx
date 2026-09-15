import clsx from 'clsx';
import { EvidenceLink } from '../../components/common.jsx';
import { deriveCoverage } from '../../lib/evidenceSelectors.js';

export default function AssessmentDetails({ sections, findings }) {
  return (
    <div className="mt-3 space-y-4 max-h-[340px] overflow-y-auto pr-1">
      {sections.map((section) => (
        <StorySection key={section.id} section={section} findings={findings} />
      ))}
      <CoverageMatrix findings={findings} />
    </div>
  );
}

function StorySection({ section, findings }) {
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
      <h3 className="eyebrow mb-1">{section.title}</h3>
      <p className="font-sans text-[13px] leading-relaxed">{plain}</p>
      {section.per_leg && (
        <ul className="mt-1.5 space-y-1.5">
          {section.per_leg.map((leg) => (
            <li key={leg.leg_id} className="font-sans text-[13px] leading-relaxed">
              <span className="font-mono text-[11px] text-ink-soft mr-1.5">{leg.leg_id}</span>
              {leg.register_plain}{' '}
              {leg.evidence_ids.length > 0 && (
                <EvidenceLink evidenceId={leg.evidence_ids[0]}>evidence</EvidenceLink>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1">
        <summary className="font-sans text-[12px] text-ink-soft cursor-pointer">
          professional register
        </summary>
        <p className="font-sans text-[12px] leading-relaxed text-ink-soft mt-1">
          {section.register_pro}
        </p>
        {section.evidence_ids.length > 0 && (
          <p className="mt-1 font-mono text-[11px] text-ink-soft">
            evidence:{' '}
            {section.evidence_ids.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <EvidenceLink evidenceId={id}>{id}</EvidenceLink>
              </span>
            ))}
          </p>
        )}
      </details>
    </div>
  );
}

function CoverageMatrix({ findings }) {
  const coverage = deriveCoverage(findings);
  return (
    <section className="border-t hairline pt-3" aria-label="Capability coverage">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="eyebrow">Capability coverage</h3>
        {coverage.derived && <span className="font-mono text-[9px] text-ink-soft">derived from evidence · legacy snapshot</span>}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {coverage.items.map((item) => (
          <li key={item.capability} className="flex items-baseline justify-between gap-2 border-b hairline py-1 font-instrument text-[12px]">
            <span>{item.capability.replaceAll('_', ' ')}</span>
            <span className={clsx('font-mono text-[10px]', item.status === 'not_assessed' ? 'text-verdict-insufficient' : item.status === 'assessed_emulated' ? 'stamp-emulated' : 'text-verdict-within')}>
              {item.status.replaceAll('_', ' ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
