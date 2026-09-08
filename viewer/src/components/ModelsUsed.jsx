import { useApp } from '../stores/appStore.js';
import { fmtLocalTime, localTimeZoneName } from '../lib/format.js';

const LAYERS = {
  weather: 'Wind and gusts', ensemble: 'Ensemble', waves: 'Waves',
  'weather-ecmwf': 'Additional weather model', 'weather-multimodel': 'Additional weather model',
  currents: 'Surface currents',
};
const SOURCES = { tiles: 'Forecast tiles', fixture: 'Fixture data', synthetic: 'emulated' };

/** Records belong to the open briefing, including when viewed from a new planner draft. */
export default function ModelsUsed() {
  const findings = useApp((s) => s.findings);
  const inputs = findings?.inputs?.forecast_tiles ?? [];
  const coverage = findings?.coverage ?? [];
  return (
    <details className="mt-6 border-t border-ink/40 pt-3">
      <summary className="font-instrument font-semibold uppercase tracking-wider cursor-pointer">Models and coverage</summary>
      {!findings ? (
        <p className="mt-3 font-sans text-sm">Check a passage to record its models and coverage.</p>
      ) : (
        <div className="mt-3 font-sans text-sm">
          <p className="eyebrow">Open briefing</p>
          <p className="mt-1 break-words"><span>{findings.route_id}</span> · {fmtLocalTime(findings.departure_utc)} · {localTimeZoneName()}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
            <section aria-label="Recorded models">
              <h3 className="eyebrow mb-2">Recorded models</h3>
              {inputs.length ? <ul className="space-y-3">{inputs.map((input, i) => (
                <li key={`${input.layer}-${input.run_id}-${i}`}>
                  <p><span>{LAYERS[input.layer] ?? input.layer}</span> · <span className="font-mono break-all">{input.model}</span></p>
                  <p className="font-mono text-xs break-all">{input.run_id}</p>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs">
                    <span className={input.source === 'fixture' || input.source === 'synthetic' || input.source_kind === 'emulated' ? 'stamp-emulated' : 'text-ink-soft'}>
                      {input.source_kind === 'emulated' ? 'emulated' : SOURCES[input.source] ?? 'Source not recorded'}
                    </span>
                    {input.member_count != null && <span>{`${input.member_count} members`}</span>}
                  </p>
                </li>
              ))}</ul> : <p>Model records unavailable for this briefing.</p>}
            </section>
            <section aria-label="Recorded coverage">
              <h3 className="eyebrow mb-2">Recorded coverage</h3>
              {coverage.length ? <ul>{coverage.map((item) => (
                <li key={item.capability} className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b hairline py-1">
                  <span>{item.capability.replaceAll('_', ' ')}</span>
                  <span className={item.status === 'assessed_emulated' ? 'stamp-emulated' : 'text-ink-soft'}>{item.status.replaceAll('_', ' ')}</span>
                </li>
              ))}</ul> : <p>Coverage records unavailable for this briefing.</p>}
            </section>
          </div>
        </div>
      )}
    </details>
  );
}
