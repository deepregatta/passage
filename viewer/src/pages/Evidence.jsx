import { useApp } from '../stores/appStore.js';
import EnsemblePlume from '../components/EnsemblePlume.jsx';
import ModelComparison from '../components/ModelComparison.jsx';
import { Panel, EvidenceLink } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';
import clsx from 'clsx';

export default function Evidence() {
  const findings = useApp((s) => s.findings);
  const legId = useApp((s) => s.selectedLegId);
  const selectLeg = useApp((s) => s.selectLeg);
  if (!findings) return <p className="p-10 font-sans text-ink-soft">Open a snapshot first.</p>;

  const headline = worstEnsembleEvidence(findings, legId);

  return (
    <div className="px-6 py-5 max-w-6xl">
      <header className="mb-4">
        <h1 className="font-chart text-3xl">Evidence & uncertainty</h1>
        {headline ? (
          <p className="font-chart text-xl mt-2">
            <span className="text-verdict-exceeds font-semibold">
              {headline.member_fraction.exceed} of {headline.member_fraction.total}
            </span>{' '}
            forecast scenarios exceed your {headline.limit} kt{' '}
            {headline.rule_id === 'W-GUST-03' ? 'gust' : 'wind'} limit on {headline.leg_id} —{' '}
            <EvidenceLink evidenceId={headline.evidence_id}>inspect</EvidenceLink>
          </p>
        ) : (
          <p className="font-sans text-ink-soft mt-2">
            No ensemble scenario exceeds your declared limits on this leg.
          </p>
        )}
        <p className="font-sans text-[13px] text-ink-soft mt-1">
          Raw scenario fractions — not calibrated probabilities. Calibration is earned by
          verification, not claimed.
        </p>
      </header>

      <div className="flex gap-1.5 mb-3" role="tablist" aria-label="Leg">
        {findings.legs.map((leg) => (
          <button
            key={leg.leg_id}
            type="button"
            role="tab"
            aria-selected={legId === leg.leg_id}
            onClick={() => selectLeg(leg.leg_id)}
            className={clsx(
              'font-mono text-[12px] px-2.5 py-1 border rounded-sm',
              legId === leg.leg_id
                ? 'bg-ink text-paper border-ink'
                : 'border-line text-ink-soft hover:border-ink-soft',
            )}
          >
            {leg.leg_id}
          </button>
        ))}
      </div>

      <Panel
        title={`Wind gust · ensemble plume (${plumeSubtitle(findings)})`}
        right={<span className="font-sans text-[12px] text-ink-soft italic">agreement is not proof</span>}
      >
        <EnsemblePlume variable="gust" />
      </Panel>

      <Panel title="Deterministic model comparison (10 m sustained wind)" className="mt-4">
        <ModelComparison />
        <DivergenceNote findings={findings} legId={legId} />
      </Panel>
    </div>
  );
}

function worstEnsembleEvidence(findings, legId) {
  const candidates = findings.evidence.filter(
    (e) => e.source_kind === 'ensemble' && e.member_fraction && (!legId || e.leg_id === legId),
  );
  return candidates.sort(
    (a, b) =>
      b.member_fraction.exceed / b.member_fraction.total -
      a.member_fraction.exceed / a.member_fraction.total,
  )[0];
}

function plumeSubtitle(findings) {
  const meta = findings.inputs.openmeteo.find((m) => m.api === 'ensemble');
  return meta ? `${meta.model} · ${meta.members} members · run ${meta.run_inferred}` : 'ensemble';
}

function DivergenceNote({ findings, legId }) {
  const leg = findings.legs.find((l) => l.leg_id === legId);
  if (!leg?.divergent_hours?.length) {
    return (
      <p className="font-sans text-[13px] text-ink-soft mt-2">
        Models agree on this leg within tolerance.
      </p>
    );
  }
  const first = leg.divergent_hours[0];
  const spread = Math.max(...leg.divergent_hours.map((d) => d.spread_kt));
  return (
    <p className="font-sans text-[13px] text-ink-soft mt-2">
      Models split from {fmtTime(first.valid_time)} UTC (max spread {spread} kt) — that is why
      confidence drops. Divergence mainly says when to wait for the next run.
    </p>
  );
}
