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

  useEffect(() => {
    loadJson('/data/verification/calibration.json').then(setCalibration);
  }, []);
  useEffect(() => {
    if (!findings) return;
    loadJson(`/data/verification/cases/${findings.snapshot_id}.json`).then(setCaseDoc);
  }, [findings]);

  return (
    <div className="px-6 py-5 max-w-5xl space-y-4">
      <header>
        <h1 className="font-chart text-3xl">Verification</h1>
        <p className="font-sans text-sm text-ink-soft mt-1 max-w-2xl">
          Every analysis is snapshotted so it can later be compared against what actually
          happened. Calibration is earned here, not claimed — and every number below carries its
          sample size and coverage class.
        </p>
      </header>

      <Panel title={findings ? `This analysis · ${findings.snapshot_id}` : 'This analysis'}>
        {!findings && <p className="font-sans text-sm text-ink-soft">Open a snapshot first.</p>}
        {findings && !caseDoc && (
          <p className="font-sans text-sm text-ink-soft">
            Not verified yet. After the passage window, run{' '}
            <span className="font-mono text-[12px]">deepweather-analysis verify</span> to match
            this forecast against observations.
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

      <Panel title="Calibration record — the track record this tool must earn">
        {!calibration && (
          <p className="font-sans text-sm text-ink-soft">
            No calibration data yet. It accumulates as verified analyses build up; until real
            observations flow in, entries from emulated sources are labeled and never counted as
            real skill.
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
                  <td className="font-mono">{r.bias ?? '—'}</td>
                  <td className="font-mono">{r.spread ?? '—'}</td>
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
          independent ground truth (brief §9). Sample sizes are always shown; no probability is
          called calibrated until they support it.
        </p>
      </Panel>
    </div>
  );
}
