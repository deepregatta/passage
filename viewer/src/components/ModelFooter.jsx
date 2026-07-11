import { useApp } from '../stores/appStore.js';
import { runAge } from '../lib/format.js';

/**
 * Model guidance footer — §16 correction enforced: run age + agreement status,
 * NEVER "High/Medium confidence".
 */
export default function ModelFooter() {
  const findings = useApp((s) => s.findings);
  const nowMs = useApp((s) => s.nowMs);
  if (!findings) return null;

  const multi = findings.inputs.openmeteo.find((m) => m.api === 'forecast-multimodel');
  const models = multi?.models ?? [findings.inputs.openmeteo[0]?.model].filter(Boolean);
  const divergentHours = findings.legs.reduce(
    (n, leg) => n + (leg.divergent_hours?.length ?? 0),
    0,
  );

  return (
    <footer className="border-t hairline mt-6 pt-3 flex flex-wrap items-center gap-x-8 gap-y-2">
      <span className="eyebrow">Evidence · model guidance</span>
      {models.map((model) => (
        <div key={model} className="flex items-center gap-2 font-sans text-sm">
          <span className="font-mono text-[13px]">{model}</span>
          <span className="text-ink-soft text-[12px]">
            run age {runAge(multi?.fetched_at ?? findings.inputs.openmeteo[0]?.fetched_at, nowMs) ?? '—'}
          </span>
        </div>
      ))}
      <span
        className="font-sans text-[12px] px-2 py-0.5 rounded-sm border"
        style={
          divergentHours > 0
            ? { color: '#5A6B82', borderColor: '#5A6B82' }
            : { color: '#2F6E4F', borderColor: '#2F6E4F' }
        }
      >
        {divergentHours > 0
          ? `models diverge on ${divergentHours} h of this passage`
          : 'models in agreement across this passage'}
      </span>
      <span className="text-ink-soft text-[12px] font-sans italic">agreement is not proof</span>
    </footer>
  );
}
