import { useEffect, useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import EnsemblePlume from '../components/EnsemblePlume.jsx';
import ModelComparison from '../components/ModelComparison.jsx';
import { EvidenceLink } from '../components/common.jsx';
import { evidenceById, evidenceVariable, worstEnsembleEvidence } from '../lib/evidenceSelectors.js';
import { fmtTime } from '../lib/format.js';
import clsx from 'clsx';

export default function Evidence() {
  const findings = useApp((state) => state.findings);
  const selectedId = useApp((state) => state.selectedEvidenceId);
  const selectEvidence = useApp((state) => state.selectEvidence);
  const selectLeg = useApp((state) => state.selectLeg);
  const selected = evidenceById(findings, selectedId);
  const claims = useMemo(
    () => (findings?.evidence ?? []).filter((item) => item.source_kind === 'ensemble' && item.member_fraction),
    [findings],
  );
  const fallback = worstEnsembleEvidence(findings);

  useEffect(() => {
    if ((!selected || selected.source_kind !== 'ensemble') && fallback) selectEvidence(fallback.evidence_id);
  }, [selected, fallback, selectEvidence]);

  if (!findings) return <p className="p-10 font-instrument text-ink-soft">Open a snapshot first.</p>;
  const evidence = selected?.source_kind === 'ensemble' ? selected : fallback;
  if (!evidence) return <p className="p-10 font-instrument text-ink-soft">No ensemble limit claim is available for this snapshot.</p>;
  const pct = Math.round((evidence.member_fraction.exceed / evidence.member_fraction.total) * 100);
  const variable = evidenceVariable(evidence);
  const leg = findings.legs.find((item) => item.leg_id === evidence.leg_id);
  const plumeLeg = useApp.getState().plume?.legs.find((item) => item.leg_id === evidence.leg_id);

  const choose = (claim) => {
    selectEvidence(claim.evidence_id);
    selectLeg(claim.leg_id);
  };

  return (
    <div className="px-4 sm:px-6 py-5 max-w-[1500px] mx-auto">
      <header className="border-b border-ink/40 pb-4 mb-4">
        <p className="eyebrow">Claim-level evidence · {evidence.rule_id}</p>
        <div className="grid lg:grid-cols-[1fr_auto] gap-4 items-end">
          <h1 className="font-story text-4xl sm:text-5xl leading-[0.98] max-w-4xl">
            <span className="text-verdict-exceeds">{evidence.member_fraction.exceed} of {evidence.member_fraction.total}</span>{' '}
            {`forecast scenarios exceed your ${variable} limit`}
          </h1>
          <div className="lg:text-right">
            <div className="font-mono text-4xl">{pct}%</div>
            <div className="font-instrument text-xs text-ink-soft max-w-56">raw count, not a calibrated probability</div>
          </div>
        </div>
        <p className="font-instrument text-sm mt-3">{evidence.leg_id} · {leg?.name} · limit {evidence.limit} {evidence.units} · <EvidenceLink evidenceId={evidence.evidence_id}>inspect claim</EvidenceLink></p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)] 2xl:grid-cols-[14rem_minmax(0,1fr)_20rem] gap-4">
        <aside className="border-t border-ink/40 xl:border-r xl:border-t-0 xl:pr-3" aria-label="Evidence claims">
          <p className="eyebrow py-2">Choose a claim</p>
          <div className="flex xl:flex-col gap-1 overflow-x-auto pb-2">
            {claims.map((claim) => (
              <button key={claim.evidence_id} type="button" onClick={() => choose(claim)} className={clsx('text-left min-w-40 px-3 py-2 border hairline font-instrument text-xs', claim.evidence_id === evidence.evidence_id ? 'bg-ink text-paper border-ink' : 'bg-white/30 hover:border-ink-soft')}>
                <span className="font-mono block">{claim.leg_id} · {claim.rule_id.includes('GUST') ? 'gust' : 'wind'}</span>
                {claim.member_fraction.exceed}/{claim.member_fraction.total} over · {fmtTime(claim.valid_time)}
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0">
          <div className="chart-frame border border-ink/40 bg-white/25 p-2 sm:p-4">
            <EnsemblePlume evidence={evidence} variable={variable} />
          </div>
          <EvidenceTable leg={plumeLeg} evidence={evidence} variable={variable} />
          <section className="mt-5 border-t border-ink/40 pt-4">
            <div className="flex items-baseline justify-between gap-3 mb-2"><h2 className="font-instrument font-semibold uppercase tracking-wider">Model comparison · same interval</h2><span className="font-instrument text-xs text-ink-soft">agreement is not proof</span></div>
            <ModelComparison />
          </section>
        </main>
        <ClaimPanel evidence={evidence} leg={leg} />
      </div>
    </div>
  );
}

function ClaimPanel({ evidence, leg }) {
  const pct = Math.round((evidence.member_fraction.exceed / evidence.member_fraction.total) * 100);
  return <aside className="hidden 2xl:block border-l border-ink/40 pl-4 sticky top-28 self-start" aria-label="Selected evidence summary"><p className="eyebrow">Selected claim</p><dl className="mt-2 divide-y hairline text-sm"><div className="py-2"><dt className="eyebrow">Rule</dt><dd className="font-mono">{evidence.rule_id}</dd></div><div className="py-2"><dt className="eyebrow">Route window</dt><dd>{evidence.leg_id} · {leg?.name}</dd><dd className="font-mono text-xs">{fmtTime(evidence.valid_time)} UTC</dd></div><div className="py-2"><dt className="eyebrow">Raw fraction</dt><dd className="font-story text-3xl">{evidence.member_fraction.exceed}/{evidence.member_fraction.total}</dd><dd>{pct}% · not calibrated</dd></div><div className="py-2"><dt className="eyebrow">Limit</dt><dd className="font-mono">{evidence.limit} {evidence.units}</dd></div></dl><p className="mt-4 p-3 bg-shoal/50 border hairline text-xs">Agreement is not proof. This panel stays tied to the claim selected at left.</p></aside>;
}

function EvidenceTable({ leg, evidence, variable }) {
  if (!leg) return null;
  const members = variable === 'gust' ? leg.gust_members : leg.wind_members;
  return (
    <details className="mt-3 border-y hairline py-2">
      <summary className="font-instrument text-sm cursor-pointer">Text/table alternative for the plume</summary>
      <div className="overflow-x-auto mt-2">
        <table className="w-full font-mono text-[11px]">
          <thead><tr className="text-left"><th className="py-1">UTC</th><th>median</th><th>maximum</th><th>your limit</th><th>members over</th></tr></thead>
          <tbody>{leg.times.filter((_, index) => index % 3 === 0).map((time) => {
            const i = leg.times.indexOf(time);
            const values = members.map((series) => series[i]).filter(Number.isFinite).sort((a, b) => a - b);
            const median = values[Math.floor(values.length / 2)];
            const over = values.filter((value) => value > evidence.limit).length;
            return <tr key={time} className="border-t hairline"><td className="py-1">{fmtTime(time)}</td><td>{median ?? 'n/a'}</td><td>{values.at(-1) ?? 'n/a'}</td><td>{evidence.limit} {evidence.units}</td><td>{over}/{values.length}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </details>
  );
}
