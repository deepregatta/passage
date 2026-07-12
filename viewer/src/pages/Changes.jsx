import { useEffect, useState } from 'react';
import { diffFindings } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { EvidenceLink, VerdictChip } from '../components/common.jsx';
import SynopticCompare from '../components/SynopticCompare.jsx';
import { deriveChangeStory, ruleLabels } from '../lib/changeStory.js';
import { fmtTime } from '../lib/format.js';

export default function Changes() {
  const findings = useApp((state) => state.findings);
  const briefing = useApp((state) => state.briefing);
  const latestSynoptic = useApp((state) => state.synoptic);
  const manifest = useApp((state) => state.manifest);
  const loadManifest = useApp((state) => state.loadManifest);
  const [state, setState] = useState({ status: 'idle' });
  useEffect(() => { if (!manifest) loadManifest(); }, [manifest, loadManifest]);
  useEffect(() => {
    if (!findings || !manifest) return;
    const previous = manifest.snapshots.filter((item) => item.route_id === findings.route_id && item.departure_utc === findings.departure_utc && item.snapshot_id !== findings.snapshot_id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!previous) return setState({ status: 'first', changes: diffFindings(null, findings) });
    Promise.all([
      fetch(`/data/snapshots/${previous.snapshot_id}/findings.json`).then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))),
      fetch(`/data/snapshots/${previous.snapshot_id}/synoptic.json`).then((response) => response.ok ? response.json() : null),
    ]).then(([previousFindings, previousSynoptic]) => setState({ status: 'ok', previous: previousFindings, previousSynoptic, previousId: previous.snapshot_id, changes: diffFindings(previousFindings, findings) })).catch((error) => setState({ status: 'error', error: error.message }));
  }, [findings, manifest]);
  if (!findings) return <p className="p-10 font-instrument text-ink-soft">Open a snapshot first.</p>;
  if (state.status === 'first') return <div className="p-8"><h1 className="font-story text-4xl">First analysis of this passage</h1><p className="mt-3">Nothing to compare yet. Reassess after the next model run.</p></div>;
  if (state.status === 'error') return <p className="p-8 text-verdict-exceeds">Change ledger error: {state.error}</p>;
  if (state.status !== 'ok') return <p className="p-8 text-ink-soft">Comparing frozen runs…</p>;
  const story = deriveChangeStory(state.changes, briefing);
  return <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto">
    <header className="border-b-2 border-ink pb-5"><p className="eyebrow">Edited change story · previous → latest</p><h1 className="font-story text-4xl sm:text-5xl leading-tight max-w-5xl">{story.headline_plain}</h1><div className="flex items-center gap-3 mt-3"><VerdictChip state={state.changes.verdict_transition.from} small/><span>→</span><VerdictChip state={state.changes.verdict_transition.to} small/></div></header>
    <section className="py-5"><SynopticCompare previous={state.previousSynoptic} latest={latestSynoptic} previousId={state.previousId} latestId={findings.snapshot_id}/></section>
    <section className="grid lg:grid-cols-3 border-y border-ink/40 divide-y lg:divide-y-0 lg:divide-x divide-ink/30">
      {story.material.length ? story.material.map((item, index) => { const entry = state.changes.entries[item.change_ref]; return <article key={item.change_ref} className="p-4"><p className="eyebrow">material change {index + 1} · {ruleLabels[entry?.rule_id] ?? entry?.kind}</p><p className="font-story text-xl mt-2">{entry?.description}</p><p className="font-instrument text-sm text-ink-soft mt-3">{item.why_it_matters}</p>{item.evidence_ids.length > 0 && <p className="font-mono text-[10px] mt-2">{item.evidence_ids.map((id) => <EvidenceLink key={id} evidenceId={id}>{id} </EvidenceLink>)}</p>}</article>; }) : <p className="p-5 text-ink-soft">No material change; steadiness is recorded.</p>}
    </section>
    <footer className="py-5 flex flex-wrap justify-between gap-3 border-b border-ink/40"><p className="font-story text-xl">Reassess after the next run at {story.next_run ? fmtTime(story.next_run.expected_at) : 'the published update time'} UTC.</p><details><summary className="font-instrument cursor-pointer">Full change ledger · {state.changes.entries.length} entries</summary><ul className="mt-3 max-w-3xl divide-y hairline">{state.changes.entries.map((entry, index) => <li key={index} className="py-2 font-instrument text-sm">{entry.description}</li>)}</ul></details></footer>
  </div>;
}
