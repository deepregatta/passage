import { useEffect, useMemo, useState } from 'react';
import { scenarioSpread } from '@deepweather/engine';
import { useApp } from '../../stores/appStore.js';
import EnsemblePlume from '../../components/EnsemblePlume.jsx';
import ModelComparison from '../../components/ModelComparison.jsx';
import ModelsUsed from '../../components/ModelsUsed.jsx';
import { EvidenceLink } from '../../components/common.jsx';
import { evidenceById, evidenceVariable, worstEnsembleEvidence } from '../../lib/evidenceSelectors.js';
import { fmtHour, fmtTextTime, fmtUtcClock } from '../../lib/format.js';
import { isScenarioId } from '../../lib/sourceNames.js';
import { ruleLabel } from '../../lib/ruleLabels.js';
import { legLabel } from './routeLabels.jsx';
import { scenarioSpreadSentences } from '../../lib/scenarioSpreadSentence.js';
import { governingClaim, useGoverningReason } from './verdictSentence.js';
import clsx from 'clsx';

/** Claim-level evidence: the ensemble behind each limit claim, then the models
 * and coverage the whole briefing rests on. */
export default function EvidenceSection() {
  const findings = useApp((state) => state.findings);
  const selectedId = useApp((state) => state.selectedEvidenceId);
  const selectEvidence = useApp((state) => state.selectEvidence);
  const selectLeg = useApp((state) => state.selectLeg);
  const plume = useApp((state) => state.plume);
  const claims = useMemo(
    () => (findings?.evidence ?? []).filter((item) => item.source_kind === 'ensemble' && item.member_fraction),
    [findings],
  );
  // From the saved findings and plume only, so a passage saved before this existed gets it too.
  const spread = useMemo(() => (findings ? scenarioSpread(findings, plume) : null), [findings, plume]);
  // Emulated scenarios are named as such, by the verdict sentence's rule: an unnamed ensemble counts as emulated.
  const emulated = !plume?.model || isScenarioId(plume.model);
  // Follow an ensemble claim chosen anywhere on the page, but never overwrite
  // the page's selection: the inspector may be showing a non-ensemble claim.
  const [claimId, setClaimId] = useState(null);
  useEffect(() => {
    const selected = evidenceById(findings, selectedId);
    if (selected?.source_kind === 'ensemble' && selected.member_fraction) setClaimId(selected.evidence_id);
  }, [findings, selectedId]);

  // by default, the claim the verdict sentence at the top quotes, so both cite the same count
  const reason = useGoverningReason(findings);
  const chosen = evidenceById(findings, claimId);
  const evidence = chosen?.source_kind === 'ensemble' && chosen.member_fraction
    ? chosen
    : governingClaim(findings, reason) ?? worstEnsembleEvidence(findings);
  if (!findings) return null;
  if (!evidence) {
    return (
      <>
        {/* Names only the limits the scenarios were counted against: a plume can carry wind without gusts. */}
        {spread?.wind && spread?.gust ? (
          <p className="font-instrument text-ink-soft">No forecast scenario exceeds your wind or gust limit at the points checked, so there is no ensemble limit claim to show.</p>
        ) : spread?.wind ? (
          <p className="font-instrument text-ink-soft">No forecast scenario exceeds your wind limit at the points checked, so there is no ensemble limit claim to show.</p>
        ) : spread?.gust ? (
          <p className="font-instrument text-ink-soft">No forecast scenario exceeds your gust limit at the points checked, so there is no ensemble limit claim to show.</p>
        ) : (
          <p className="font-instrument text-ink-soft">No ensemble limit claim is available for this check.</p>
        )}
        <ScenarioSpread spread={spread} emulated={emulated} className="mt-3" />
        <ModelsUsed />
      </>
    );
  }
  const pct = Math.round((evidence.member_fraction.exceed / evidence.member_fraction.total) * 100);
  const variable = evidenceVariable(evidence);
  const plumeLeg = plume?.legs.find((item) => item.leg_id === evidence.leg_id);

  const choose = (claim) => {
    setClaimId(claim.evidence_id);
    selectEvidence(claim.evidence_id);
    selectLeg(claim.leg_id);
  };

  return (
    <div>
      <header className="border-b border-ink/40 pb-4 mb-4">
        <p className="eyebrow">Claim-level evidence · {ruleLabel(evidence.rule_id)}</p>
        <div className="grid lg:grid-cols-[1fr_auto] gap-4 items-end">
          <h2 className="font-story text-3xl sm:text-4xl leading-[1.02] sm:leading-10 max-w-4xl">
            <span className="text-verdict-exceeds">{evidence.member_fraction.exceed} of {evidence.member_fraction.total}</span>{' '}
            {`forecast scenarios exceed your ${variable} limit`}
          </h2>
          <div className="lg:text-right">
            <div className="font-mono text-4xl">{pct}%</div>
            <div className="font-instrument text-xs text-ink-soft max-w-56">raw count, not a calibrated probability</div>
          </div>
        </div>
        <p className="font-instrument text-sm mt-3">{legLabel(findings, evidence.leg_id, { bare: true })} · forecast hour {fmtTextTime(evidence.valid_time)} · limit {evidence.limit} {evidence.units} · <EvidenceLink evidenceId={evidence.evidence_id} title={evidence.evidence_id} className="inline-flex items-center min-h-11 sm:min-h-0">inspect claim</EvidenceLink></p>
      </header>

      <ScenarioSpread spread={spread} emulated={emulated} className="mb-4" />

      <div className="grid grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)] 2xl:grid-cols-[14rem_minmax(0,1fr)_20rem] gap-4">
        <aside className="border-t border-ink/40 xl:border-r xl:border-t-0 xl:pr-3" aria-label="Evidence claims">
          <p className="eyebrow py-2">Choose a claim</p>
          <div className="flex flex-wrap xl:flex-col gap-1 pb-2">
            {claims.map((claim) => (
              <button key={claim.evidence_id} type="button" onClick={() => choose(claim)} aria-pressed={claim.evidence_id === evidence.evidence_id} className={clsx('text-left min-w-40 min-h-11 px-3 py-2 border hairline font-instrument text-xs', claim.evidence_id === evidence.evidence_id ? 'bg-ink text-paper border-ink' : 'bg-white/30 hover:border-ink-soft')}>
                <span className="block">{legLabel(findings, claim.leg_id, { bare: true })}</span>
                <span className="block opacity-80">{evidenceVariable(claim)}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="chart-frame border border-ink/40 bg-white/25 p-2 sm:p-4">
            <EnsemblePlume evidence={evidence} variable={variable} />
          </div>
          <EvidenceTable leg={plumeLeg} evidence={evidence} variable={variable} />
          <section className="mt-5 border-t border-ink/40 pt-4">
            <h3 className="font-instrument font-semibold uppercase tracking-wider mb-2">Model comparison · same interval</h3>
            <ModelComparison />
          </section>
          <ModelsUsed />
        </div>
        <ClaimPanel evidence={evidence} />
      </div>
    </div>
  );
}

/** How the forecast scenarios spread over the whole passage: a count of scenarios, never a probability.
 * Shown with or without a limit claim; renders nothing when the saved plume cannot support it. */
function ScenarioSpread({ spread, emulated, className }) {
  const sentences = scenarioSpreadSentences(spread, { emulated });
  if (!sentences.length) return null;
  return (
    <div className={clsx('font-instrument text-sm space-y-1', className)} data-testid="scenario-spread">
      {sentences.map(({ variable, text }) => <p key={variable}>{text}</p>)}
    </div>
  );
}

/** Side summary (2xl only). The count, place and limit are in the headline above; this adds the
 * claim's rule and its time with a marked UTC secondary for cross-reference to the chart axis. */
function ClaimPanel({ evidence }) {
  return <aside className="hidden 2xl:block border-l border-ink/40 pl-4 sticky top-28 self-start" aria-label="Selected evidence summary"><p className="eyebrow">Selected claim</p><dl className="mt-2 divide-y-legacy hairline text-sm"><div className="py-2"><dt className="eyebrow">Rule</dt><dd>{ruleLabel(evidence.rule_id)}</dd></div><div className="py-2"><dt className="eyebrow">Forecast hour</dt><dd>{fmtTextTime(evidence.valid_time)}</dd><dd className="font-mono text-xs text-ink-soft">{fmtUtcClock(evidence.valid_time)}</dd></div></dl><p className="mt-4 p-3 bg-shoal/50 border hairline text-xs">Agreement is not proof. This panel stays tied to the claim selected at left.</p></aside>;
}

function EvidenceTable({ leg, evidence, variable }) {
  if (!leg) return null;
  const members = variable === 'gust' ? leg.gust_members : leg.wind_members;
  return (
    <details className="mt-3 border-y hairline py-2">
      <summary className="font-instrument text-sm cursor-pointer">Text/table alternative for the plume</summary>
      <div className="overflow-x-auto mt-2">
        <table className="w-full font-mono text-xs">
          <caption className="text-left text-ink-soft pb-1">limit {evidence.limit} {evidence.units}</caption>
          <thead><tr className="text-left"><th className="py-1">local time</th><th>UTC</th><th>median</th><th>maximum</th><th>members over</th></tr></thead>
          <tbody>{leg.times.filter((_, index) => index % 3 === 0).map((time) => {
            const i = leg.times.indexOf(time);
            const values = members.map((series) => series[i]).filter(Number.isFinite).sort((a, b) => a - b);
            const median = values[Math.floor(values.length / 2)];
            const over = values.filter((value) => value > evidence.limit).length;
            return <tr key={time} className="border-t hairline"><td className="py-1">{fmtTextTime(time)}</td><td>{fmtHour(time)}</td><td>{median ?? 'n/a'}</td><td>{values.at(-1) ?? 'n/a'}</td><td>{over}/{values.length}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </details>
  );
}
