import { CHANNEL_PREPARED_COVERAGE, describeEcmwfRuns } from '@deepweather/engine';
import { deriveCoverage } from '../lib/evidenceSelectors.js';
import { useApp } from '../stores/appStore.js';
import { palette } from '../lib/palette.js';
import { runAge } from '../lib/format.js';

const LAYERS = {
  weather: 'Wind and gusts', ensemble: 'Ensemble', waves: 'Waves',
  'weather-ecmwf': 'Additional weather model', 'weather-ecmwf-short': 'Additional weather model',
  'weather-multimodel': 'Additional weather model',
  currents: 'Surface currents',
  synoptic: 'Synoptic features', tides: 'Tide predictions', gates: 'Tidal gates', warnings: 'Official warnings',
};
const SOURCES = { tiles: 'Forecast tiles', fixture: 'Fixture data', synthetic: 'emulated', 'prepared-artifact': 'Prepared data', 'region-grid': 'Current grid' };

/**
 * The models and coverage recorded with the open briefing, with run age and
 * agreement status; NEVER "High/Medium confidence". The caveat stays visible.
 */
export default function ModelsUsed() {
  const findings = useApp((s) => s.findings);
  const nowMs = useApp((s) => s.nowMs);
  if (!findings) return null;
  const inputs = (findings.inputs?.forecast_tiles ?? []).filter(input => input.source !== 'action-inputs');
  // ECMWF's comparison series may join a 06Z/18Z run (to +144 h) and a 00Z/12Z one
  const ecmwfRuns = describeEcmwfRuns(inputs);
  const coverage = findings.coverage?.length ? deriveCoverage(findings).items : [];
  const divergentHours = findings.legs.reduce((n, leg) => n + (leg.divergent_hours?.length ?? 0), 0);
  return (
    <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Models">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-sans text-[12px]">
        <span
          className="px-2 py-0.5 rounded-sm border"
          style={
            divergentHours > 0
              ? { color: palette.verdict.insufficient, borderColor: palette.verdict.insufficient }
              : { color: palette.verdict.within, borderColor: palette.verdict.within }
          }
        >
          {divergentHours > 0
            ? `models diverge on ${divergentHours} h of this passage`
            : 'models in agreement across this passage'}
        </span>
        <span className="text-ink-soft italic">agreement is not proof</span>
        <span className="text-ink-soft basis-full">
          Global models under-resolve coastal wind acceleration, harbours and tidal races. Ocean-model
          currents are not tidal stream predictions.
        </span>
      </div>
      <details className="mt-3">
        <summary className="font-instrument font-semibold uppercase tracking-wider cursor-pointer py-2.5">Models and coverage</summary>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-6 font-sans text-sm">
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
                  {input.resolution_deg ? <span className="text-ink-soft">{input.resolution_deg}°</span> : null}
                  <span className="text-ink-soft">
                    age {runAge(input.cycle && input.cycle !== 'scenario' ? input.cycle : input.fetched_at, nowMs) ?? 'n/a'}
                  </span>
                </p>
              </li>
            ))}</ul> : <p>Model records unavailable for this briefing.</p>}
            {ecmwfRuns && (
              <p className="mt-3 text-xs">
                <span className="text-ink-soft">Model comparison uses</span>{' '}<span className="font-mono">{ecmwfRuns}</span>
              </p>
            )}
          </section>
          <section aria-label="Recorded coverage">
            <h3 className="eyebrow mb-2">Recorded coverage</h3>
            {coverage.length ? <ul>{coverage.map((item) => (
              <li key={item.capability} className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b hairline py-1">
                <span>{item.capability.replaceAll('_', ' ')}</span>
                <span className={item.status === 'assessed_emulated' ? 'stamp-emulated' : 'text-ink-soft'}>{item.status.replaceAll('_', ' ')}</span>
                {item.detail === CHANNEL_PREPARED_COVERAGE && <p className="basis-full text-ink-soft leading-relaxed">{item.detail}</p>}
              </li>
            ))}</ul> : <p>Coverage records unavailable for this briefing.</p>}
          </section>
        </div>
      </details>
    </section>
  );
}
