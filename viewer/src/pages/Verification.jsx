import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { Panel, EmulatedStamp } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';

const CLASS_LABEL = {
  verified_near_observation: 'verified near observation',
  partially_observed: 'partially observed',
  reanalysis_referenced: 'reanalysis-referenced',
  not_independently_observed: 'not independently observed',
  emulated: 'emulated observations',
};

async function loadJson(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

export default function Verification() {
  const findings = useApp((s) => s.findings);
  const [caseDoc, setCaseDoc] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [caseIndex, setCaseIndex] = useState(null);
  const [corpus, setCorpus] = useState(null);

  useEffect(() => {
    Promise.all([
      loadJson('/data/verification/calibration.json').then(setCalibration),
      loadJson('/data/verification/cases/index.json').then(setCaseIndex),
      loadJson('/data/verification/corpus.json').then(setCorpus),
    ]);
  }, []);
  useEffect(() => {
    if (!findings) return;
    if (!caseIndex) return;
    const exists = caseIndex.cases?.some((item) => (item.snapshot_id ?? item) === findings.snapshot_id);
    if (!exists) return setCaseDoc(null);
    loadJson(`/data/verification/cases/${findings.snapshot_id}.json`).then(setCaseDoc);
  }, [findings, caseIndex]);

  return (
    <div className="px-6 py-5 max-w-5xl space-y-4">
      <header>
        <h1 className="font-chart text-3xl">Track record</h1>
        <p className="font-sans text-sm text-ink-soft mt-1 max-w-2xl">
          How the forecasts in your briefings compared with what actually happened. This is the
          page where Passage earns your trust. Every number carries its sample size
          and how independent the observation really was.
        </p>
      </header>

      <div className="border-y border-ink/40 py-3 flex flex-wrap gap-x-6 gap-y-2 font-instrument text-sm">
        <strong>Skill claims use {corpus?.cases ?? 0} real ERA5 cases.</strong>
        <span>{corpus ? `${corpus.pass} pass · ${corpus.fail} fail · ${corpus.pending} pending` : 'Corpus summary unavailable.'}</span>
        <span>{caseIndex?.cases?.filter((item) => item.observation_source === 'emulated').length ?? 0} emulated cases shown for demo only.</span>
      </div>

      <Panel title={findings ? `This analysis · ${findings.snapshot_id}` : 'This analysis'}>
        {!findings && <p className="font-sans text-sm text-ink-soft">Open a snapshot first.</p>}
        {findings && !caseDoc && (
          <p className="font-sans text-sm text-ink-soft">
            Not verified yet. After the passage window, the verification job will match this
            frozen forecast against later observations.
          </p>
        )}
        {caseDoc && (
          <>
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(caseDoc.coverage_summary ?? {}).map(([klass, count]) => (
                <span
                  key={klass}
                  className="font-sans text-[12px] border hairline rounded-sm px-2 py-0.5 flex items-center gap-1.5"
                >
                  {klass === 'emulated' ? <EmulatedStamp /> : CLASS_LABEL[klass] ?? klass}
                  <span className="font-mono">{count}</span>
                </span>
              ))}
            </div>
            <table className="w-full font-sans text-[13px]">
              <thead>
                <tr className="text-left border-b hairline">
                  <th className="eyebrow py-1">leg · hour</th>
                  <th className="eyebrow">variable</th>
                  <th className="eyebrow">forecast</th>
                  <th className="eyebrow">observed</th>
                  <th className="eyebrow">error</th>
                </tr>
              </thead>
              <tbody>
                {(caseDoc.pairs ?? []).slice(0, 24).map((p, i) => (
                  <tr key={i} className="border-b hairline last:border-0">
                    <td className="py-1 font-mono text-[12px]">
                      {p.leg_id} · {fmtTime(p.valid_time)}
                    </td>
                    <td>{p.variable}</td>
                    <td className="font-mono">{p.forecast}</td>
                    <td className="font-mono">{p.observed}</td>
                    <td className="font-mono">
                      {p.error > 0 ? '+' : ''}
                      {p.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      <Panel title="Calibration record">
        {!calibration && (
          <p className="font-sans text-sm text-ink-soft">
            No calibration data yet. Verified analyses will build this record over time. Emulated
            observations stay labeled and never count as real skill.
          </p>
        )}
        {calibration && (
          <table className="w-full font-sans text-[13px]">
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
        )}
        <p className="font-sans text-[12px] text-ink-soft mt-3">
          Reanalysis-referenced comparisons use ERA5, which assimilates observations but is not
          independent ground truth (brief §9). Sample sizes are always shown. Passage calls a
          probability calibrated only when the record supports it.
        </p>
      </Panel>
    </div>
  );
}
