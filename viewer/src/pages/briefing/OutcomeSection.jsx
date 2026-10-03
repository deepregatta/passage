import { useEffect, useState } from 'react';
import { useApp } from '../../stores/appStore.js';
import { EmulatedStamp } from '../../components/common.jsx';
import { fmtTime } from '../../lib/format.js';
import { loadJson, readVerificationCase } from '../../lib/verification.js';

const CLASS_LABEL = {
  verified_near_observation: 'verified near observation',
  partially_observed: 'partially observed',
  reanalysis_referenced: 'reanalysis-referenced',
  not_independently_observed: 'not independently observed',
  emulated: 'emulated observations',
};

/** Print only this report: the rest of the passage page stays on screen. */
function printOutcome() {
  document.body.dataset.print = 'outcome';
  const done = () => { delete document.body.dataset.print; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/** Optional published comparison; browser-private checks have no matcher yet. */
export default function OutcomeSection() {
  const findings = useApp((state) => state.findings);
  const snapshotSource = useApp((state) => state.snapshotSource);
  const setPage = useApp((state) => state.setPage);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!findings || snapshotSource === 'local') return undefined;
    const controller = new AbortController();
    loadJson('/data/verification/cases/index.json', controller.signal).then((index) => {
      const listed = index?.cases?.some((item) => (item.snapshot_id ?? item) === findings.snapshot_id);
      return listed ? loadJson(`/data/verification/cases/${findings.snapshot_id}.json`, controller.signal) : null;
    }).then((loaded) => {
      if (!controller.signal.aborted) setResult({ id: findings.snapshot_id, source: snapshotSource,
        doc: readVerificationCase(loaded, findings.snapshot_id), invalid: loaded !== null });
    });
    return () => controller.abort();
  }, [findings, snapshotSource]);

  if (!findings) return null;
  const current = result?.id === findings.snapshot_id && result?.source === snapshotSource ? result : null;
  const doc = snapshotSource === 'local' ? null : current?.doc;
  const trackRecord = (
    <button type="button" onClick={() => setPage('about')} className="font-instrument text-sm text-event underline underline-offset-4 min-h-11 print:hidden">
      See the Passage track record
    </button>
  );
  if (!doc) {
    return (
      <div>
        <h2 className="font-story text-2xl">Not verified yet</h2>
        <p className="font-instrument text-ink-soft mt-2 max-w-3xl">
          {snapshotSource === 'local'
            ? 'Automatic verification is unavailable for briefings saved only in this browser.'
            : current?.invalid
              ? 'The published verification case is invalid or does not match this briefing.'
              : 'No published observation comparison is available for this briefing.'}
        </p>
        {snapshotSource === 'local' && <p className="font-instrument text-ink-soft mt-2 max-w-3xl">
          Your route stays private. A future opt-in comparison could use shared observations in your browser, or an explicit export and import. This is not available yet.
        </p>}
        {trackRecord}
      </div>
    );
  }
  return (
    <article>
      <header className="border-y-2 border-ink py-5 grid sm:grid-cols-[1fr_auto] gap-4">
        <div>
          <p className="eyebrow">Published verification case · frozen snapshot</p>
          <h2 className="font-story text-3xl sm:text-4xl">What the forecast said, and what happened</h2>
        </div>
        <button type="button" onClick={printOutcome} className="print:hidden self-start min-h-11 px-4 border border-ink font-instrument">Print / save PDF</button>
      </header>
      <section className="py-6 border-b hairline">
        <div className="flex flex-wrap items-center gap-2">
          <div className={doc.observation_source === 'emulated' ? 'stamp-emulated inline-block' : 'font-mono text-xs text-ink-soft'}>{doc.observation_source === 'emulated' ? ('EMULATED DEMO · NOT A SKILL CLAIM') : `OBSERVATION SOURCE · ${doc.observation_source}`}</div>
          {doc.observation_provenance && <span className="font-mono text-xs text-ink-soft"><span>Observation mode</span>: {doc.observation_provenance.mode}</span>}
          {Object.entries(doc.coverage_summary ?? {}).map(([klass, count]) => (
            <span key={klass} className="font-sans text-[12px] border hairline rounded-sm px-2 py-0.5 flex items-center gap-1.5">
              {klass === 'emulated' ? <EmulatedStamp /> : CLASS_LABEL[klass] ?? klass}
              <span className="font-mono">{count}</span>
            </span>
          ))}
        </div>
        <p className="font-story text-2xl mt-3">{doc.pairs.length
          ? 'The table compares the frozen forecast with matched observations. It does not establish event timing or forecast skill.'
          : 'No observations matched this frozen forecast. Its outcome remains unverified.'}</p>
      </section>
      <section className="py-6">
        <h3 className="font-instrument uppercase tracking-wider font-semibold">Error decomposition</h3>
        <div className="verification-table-scroll mt-3" role="region" aria-label="Error decomposition" tabIndex={0}>
          <table className="verification-table w-full text-sm">
            <thead><tr className="border-b border-ink text-left"><th className="py-2">leg · valid UTC</th><th>variable</th><th>frozen forecast</th><th>later observation</th><th>error</th><th>interpretation</th></tr></thead>
            <tbody>{doc.pairs.map((pair, index) => <tr key={index} className="border-b hairline"><td className="py-2 font-mono text-xs">{pair.leg_id} · {fmtTime(pair.valid_time)}
              {doc.schema_version === 2 && <div className="mt-1 space-y-1">
                <div><span>Since check</span>: {pair.check_lead_h ?? 'n/a'} h</div>
                <div><span>Model lead</span>: {pair.model_lead_h ?? 'n/a'} h</div>
              </div>}
            </td><td>{pair.variable}</td><td className="font-mono">{pair.forecast}</td><td className="font-mono">{pair.observed}</td><td className="font-mono">{pair.error > 0 ? '+' : ''}{pair.error}</td><td>{pair.error > 0 ? 'Forecast above observation' : pair.error < 0 ? 'Forecast below observation' : 'Equal at displayed precision'}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="grid sm:grid-cols-2 gap-6 border-t border-ink py-6">
        <div><p className="eyebrow">Original interpretation</p><p className="font-story text-xl mt-2">{findings.causal_events?.[0]?.consequence.register_plain ?? ('Causal attribution was unavailable in the original run.')}</p></div>
        <div><p className="eyebrow">Lesson for the next passage</p><p className="font-story text-xl mt-2">A matched station comparison is limited by distance, time offset and observation coverage. Keep those limits in mind when reading the errors.</p></div>
      </section>
      {trackRecord}
    </article>
  );
}
