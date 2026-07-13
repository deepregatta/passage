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

  const tileInputs = findings.inputs.forecast_tiles ?? [];
  // one line per weather-model layer; other layers (waves, ensemble, currents)
  // are disclosed through coverage and the evidence inspector
  const modelInputs = tileInputs.filter((m) =>
    ['weather', 'weather-ecmwf', 'weather-multimodel'].includes(m.layer),
  );
  const shown = modelInputs.length ? modelInputs : tileInputs.slice(0, 1);
  const divergentHours = findings.legs.reduce(
    (n, leg) => n + (leg.divergent_hours?.length ?? 0),
    0,
  );

  return (
    <footer className="border-t hairline mt-6 pt-3 flex flex-wrap items-center gap-x-8 gap-y-2">
      <span className="eyebrow">Evidence · model guidance</span>
      {shown.map((input) => (
        <div key={input.layer ?? input.model} className="flex items-center gap-2 font-sans text-sm">
          <span className="font-mono text-[13px]">{input.model}</span>
          {input.resolution_deg ? (
            <span className="text-ink-soft text-[12px]">{input.resolution_deg}°</span>
          ) : null}
          <span className="text-ink-soft text-[12px]">
            {input.cycle && input.cycle !== 'scenario' ? `run ${input.cycle} · ` : ''}
            age {runAge(input.cycle && input.cycle !== 'scenario' ? input.cycle : input.fetched_at, nowMs) ?? '—'}
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
      <span className="text-ink-soft text-[12px] font-sans basis-full">
        Global models under-resolve coastal wind acceleration, harbours and tidal races; ocean-model
        currents are not tidal stream predictions.
      </span>
    </footer>
  );
}
