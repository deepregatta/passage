import { useEffect, useState } from 'react';
import { useApp } from '../../stores/appStore.js';
import { EmulatedStamp } from '../../components/common.jsx';
import { fmtTime } from '../../lib/format.js';
import { loadJson } from '../../lib/verification.js';

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

/** What the frozen forecast said against what was later observed, once the
 * verification job has classified observations for this briefing. */
export default function OutcomeSection() {
  const findings = useApp((state) => state.findings);
  const setPage = useApp((state) => state.setPage);
  const [doc, setDoc] = useState(null);

  useEffect(() => {
    setDoc(null);
    if (!findings) return undefined;
    const controller = new AbortController();
    loadJson('/data/verification/cases/index.json', controller.signal).then((index) => {
      const listed = index?.cases?.some((item) => (item.snapshot_id ?? item) === findings.snapshot_id);
      return listed ? loadJson(`/data/verification/cases/${findings.snapshot_id}.json`, controller.signal) : null;
    }).then((loaded) => {
      if (!controller.signal.aborted) setDoc(loaded);
    });
    return () => controller.abort();
  }, [findings]);

  if (!findings) return null;
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
          After the passage window, the verification job will match this frozen forecast against later observations.
        </p>
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
          <div className={doc.observation_source === 'emulated' ? 'stamp-emulated inline-block' : 'font-mono text-xs text-verdict-within'}>{doc.observation_source === 'emulated' ? ('EMULATED DEMO · NOT A SKILL CLAIM') : `OBSERVATION SOURCE · ${doc.observation_source}`}</div>
          {Object.entries(doc.coverage_summary ?? {}).map(([klass, count]) => (
            <span key={klass} className="font-sans text-[12px] border hairline rounded-sm px-2 py-0.5 flex items-center gap-1.5">
              {klass === 'emulated' ? <EmulatedStamp /> : CLASS_LABEL[klass] ?? klass}
              <span className="font-mono">{count}</span>
            </span>
          ))}
        </div>
        <p className="font-story text-2xl mt-3">The route forecast caught the event direction. The table records its timing and magnitude errors without hindsight edits.</p>
      </section>
      <section className="py-6">
        <h3 className="font-instrument uppercase tracking-wider font-semibold">Error decomposition</h3>
        <div className="verification-table-scroll mt-3" role="region" aria-label="Error decomposition" tabIndex={0}>
          <table className="verification-table w-full text-sm">
            <thead><tr className="border-b border-ink text-left"><th className="py-2">leg · valid UTC</th><th>variable</th><th>frozen forecast</th><th>later observation</th><th>error</th><th>interpretation</th></tr></thead>
            <tbody>{(doc.pairs ?? []).map((pair, index) => <tr key={index} className="border-b hairline"><td className="py-2 font-mono text-xs">{pair.leg_id} · {fmtTime(pair.valid_time)}</td><td>{pair.variable}</td><td className="font-mono">{pair.forecast}</td><td className="font-mono">{pair.observed}</td><td className="font-mono">{pair.error > 0 ? '+' : ''}{pair.error}</td><td>{Math.abs(pair.error) <= 2 ? ('useful magnitude') : ('material miss; widen margin')}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="grid sm:grid-cols-2 gap-6 border-t border-ink py-6">
        <div><p className="eyebrow">Original interpretation</p><p className="font-story text-xl mt-2">{findings.causal_events?.[0]?.consequence.register_plain ?? ('Causal attribution was unavailable in the original run.')}</p></div>
        <div><p className="eyebrow">Lesson for the next passage</p><p className="font-story text-xl mt-2">Treat event timing as a window. Keep your personal limit, then add the measured forecast error as margin.</p></div>
      </section>
      {trackRecord}
    </article>
  );
}
