import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { Panel, EmulatedStamp } from '../components/common.jsx';
import { GLOSSARY } from '../lib/glossary.jsx';
import { loadJson } from '../lib/verification.js';

/** Where the data comes from and how well it has held up: the fleet-wide track
 * record, provider modes and the glossary. Each passage shows its own outcome. */
export default function About() {
  const providers = useApp((s) => s.providers);
  const loadConfig = useApp((s) => s.loadConfig);
  const [calibration, setCalibration] = useState(null);
  const [caseIndex, setCaseIndex] = useState(null);
  const [corpus, setCorpus] = useState(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);
  useEffect(() => {
    const controller = new AbortController();
    const load = (url, setValue) => loadJson(url, controller.signal).then((doc) => {
      if (!controller.signal.aborted) setValue(doc);
    });
    load('/data/verification/calibration.json', setCalibration);
    load('/data/verification/cases/index.json', setCaseIndex);
    load('/data/verification/corpus.json', setCorpus);
    return () => controller.abort();
  }, []);

  return (
    <div className="px-4 sm:px-6 py-5 max-w-5xl space-y-4">
      <header>
        <h1 className="font-chart text-3xl">About the data</h1>
        <p className="font-sans text-sm text-ink-soft mt-1 max-w-2xl">
          How the forecasts in your briefings compared with what actually happened. This is the page where Passage earns your trust. Every number carries its sample size and how independent the observation really was.
        </p>
      </header>

      <section aria-labelledby="track-record" className="space-y-4">
        <h2 id="track-record" className="font-instrument font-semibold uppercase tracking-wider">Track record</h2>
        <div className="border-y border-ink/40 py-3 flex flex-wrap gap-x-6 gap-y-2 font-instrument text-sm">
          <strong>
            {`Skill claims use ${corpus?.cases ?? 0} real ERA5 cases.`}
          </strong>
          <span>
            {corpus
              ? `${corpus.pass} pass · ${corpus.fail} fail · ${corpus.pending} pending`
              : 'Corpus summary unavailable.'}
          </span>
          <span>{emulatedCaseLabel(caseIndex)}</span>
        </div>

        <Panel title={'Calibration record'}>
          {!calibration && (
            <p className="font-sans text-sm text-ink-soft">
              No calibration data yet. Verified analyses will build this record over time. Emulated observations stay labeled and never count as real skill.
            </p>
          )}
          {calibration && (
            <div className="verification-table-scroll" role="region" aria-label="Calibration record" tabIndex={0}>
              <table className="verification-table w-full font-sans text-[13px]">
                <thead>
                  <tr className="text-left border-b hairline">
                    <th className="eyebrow py-1">variable</th>
                    <th className="eyebrow">lead</th>
                    <th className="eyebrow">area</th>
                    <th className="eyebrow">n</th>
                    <th className="eyebrow">bias</th>
                    <th className="eyebrow">spread</th>
                    <th className="eyebrow">coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {calibration.records.map((r, i) => (
                    <tr key={i} className="border-b hairline last:border-0">
                      <td className="py-1">{r.variable}</td>
                      <td className="font-mono">
                        {r.lead_band_h[0]}–{r.lead_band_h[1]} h
                      </td>
                      <td>{r.area}</td>
                      <td className="font-mono">{r.n_pairs}</td>
                      <td className="font-mono">{r.bias ?? 'n/a'}</td>
                      <td className="font-mono">{r.spread ?? 'n/a'}</td>
                      <td>
                        {Object.keys(r.coverage_classes ?? {}).includes('emulated') ? (
                          <EmulatedStamp />
                        ) : (
                          Object.keys(r.coverage_classes ?? {}).join(', ')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="font-sans text-[12px] text-ink-soft mt-3">
            ERA5 comparisons use a reanalysis that assimilates observations but is not independent ground truth (brief §9). Sample sizes are always shown. Passage calls a probability calibrated only when the record supports it.
          </p>
        </Panel>
      </section>

      <Panel title="Data providers">
        <p className="font-sans text-sm text-ink-soft mb-3">
          Feeds marked <EmulatedStamp /> contain synthetic test values. They stay visibly marked
          and must never inform a real passage decision.
        </p>
        <ul className="grid md:grid-cols-2 gap-x-8">
          {providers?.providers &&
            Object.entries(providers.providers).map(([name, p]) => (
              <li key={name} className="flex items-center justify-between py-1.5 border-b hairline">
                <span className="font-mono text-[13px]">{name}</span>
                {p.mode === 'synthetic' ? (
                  <EmulatedStamp />
                ) : (
                  <span className="font-sans text-[12px] text-verdict-within">{p.mode}</span>
                )}
              </li>
            ))}
        </ul>
      </Panel>

      <Panel title="Glossary">
        <dl className="grid md:grid-cols-2 gap-x-8 gap-y-3">
          {Object.entries(GLOSSARY).map(([term, def]) => (
            <div key={term}>
              <dt className="font-sans font-medium text-sm">{term}</dt>
              <dd className="font-sans text-[13px] text-ink-soft leading-relaxed">{def}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

function emulatedCaseLabel(caseIndex) {
  const count = caseIndex?.cases?.filter((item) => item.observation_source === 'emulated').length ?? 0;
  return `${count} emulated ${count === 1 ? 'case' : 'cases'} shown for demo only.`;
}
