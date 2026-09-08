import { useEffect, useState } from 'react';
import { diffFindings } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { EvidenceLink, VerdictChip } from '../components/common.jsx';
import SynopticCompare from '../components/SynopticCompare.jsx';
import { deriveChangeStory, kindLabels, ruleLabels } from '../lib/changeStory.js';
import { fmtTime } from '../lib/format.js';
import { fetchSnapshotJson } from '../lib/localSnapshots.js';

export default function Changes() {
  const findings = useApp((state) => state.findings);
  const briefing = useApp((state) => state.briefing);
  const latestSynoptic = useApp((state) => state.synoptic);
  const manifest = useApp((state) => state.manifest);
  const loadManifest = useApp((state) => state.loadManifest);
  const [state, setState] = useState({ status: 'idle' });
  useEffect(() => { if (!manifest) loadManifest(); }, [manifest, loadManifest]);
  useEffect(() => {
    setState({ status: 'idle' });
    if (!findings || !manifest) return;
    // Snapshot reads can come from IndexedDB; ignore completions after cleanup.
    let cancelled = false;
    const previous = manifest.snapshots.filter((item) => item.route_id === findings.route_id && item.departure_utc === findings.departure_utc && item.snapshot_id !== findings.snapshot_id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!previous) return setState({ status: 'first', changes: diffFindings(null, findings) });
    Promise.all([
      fetchSnapshotJson(previous.snapshot_id, 'findings.json'),
      fetchSnapshotJson(previous.snapshot_id, 'synoptic.json').catch(() => null),
    ]).then(([previousFindings, previousSynoptic]) => {
      if (!cancelled) setState({ status: 'ok', previous: previousFindings, previousSynoptic, previousId: previous.snapshot_id, changes: diffFindings(previousFindings, findings, briefing?.next_run ?? briefing?.next_runs?.[0]) });
    }).catch((error) => {
      if (!cancelled) setState({ status: 'error', error: error.message });
    });
    return () => { cancelled = true; };
  }, [findings, manifest, briefing]);
  if (!findings) return <p className="p-10 font-instrument text-ink-soft">Open a snapshot first.</p>;
  if (state.status === 'first') return <div className="p-8"><h1 className="font-story text-4xl">First analysis of this passage</h1><p className="mt-3">Nothing to compare yet. Reassess after the next model run.</p></div>;
  if (state.status === 'error') return <p className="p-8 text-verdict-exceeds">Change ledger error: {state.error}</p>;
  if (state.status !== 'ok') return <p className="p-8 text-ink-soft">Comparing frozen runs…</p>;
  const story = deriveChangeStory(state.changes, briefing);
  const emulatedWarning = findings.evidence.some((item) => item.rule_id === 'A-WARN-01' && item.source_kind === 'emulated');
  return <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto">
    <header className="border-b-2 border-ink pb-5"><p className="eyebrow">Edited change story · previous → latest</p><h1 className="font-story text-4xl sm:text-5xl leading-tight max-w-5xl">{story.headline_plain}</h1><div className="flex items-center gap-3 mt-3"><TransitionChip state={state.changes.verdict_transition.from} emulated={emulatedWarning}/><span>→</span><TransitionChip state={state.changes.verdict_transition.to} emulated={emulatedWarning}/></div></header>
    <section className="py-5"><SynopticCompare previous={state.previousSynoptic} latest={latestSynoptic} previousId={state.previousId} latestId={findings.snapshot_id}/></section>
    <OnsetShift previous={state.previous} latest={findings} />
    <section className="grid lg:grid-cols-3 border-y border-ink/40 divide-y lg:divide-y-0 lg:divide-x divide-ink/30">
      {story.material.length ? story.material.map((item, index) => { const entry = state.changes.entries[item.change_ref]; return <article key={item.change_ref} className="p-4"><p className="eyebrow">material change {index + 1} · {ruleLabels[entry?.rule_id] ?? kindLabels[entry?.kind] ?? 'change'}</p><p className="font-story text-xl mt-2">{entry?.description}</p><p className="font-instrument text-sm text-ink-soft mt-3">{item.why_it_matters}</p>{item.evidence_ids.length > 0 && <p className="font-mono text-[10px] mt-2">{item.evidence_ids.map((id) => <EvidenceLink key={id} evidenceId={id}>{id} </EvidenceLink>)}</p>}</article>; }) : <p className="p-5 text-ink-soft">No material change. The forecast held steady.</p>}
    </section>
    <footer className="py-5 flex flex-wrap justify-between gap-3 border-b border-ink/40"><p className="font-story text-xl">{story.next_run ? `Next forecast update estimated around ${fmtTime(story.next_run.expected_at)} UTC. Check again before departure.` : 'Next forecast update time unavailable. Check the published forecast before departure.'}</p><details><summary className="font-instrument cursor-pointer">Full change ledger · {state.changes.entries.length} entries</summary><ul className="mt-3 max-w-3xl divide-y hairline">{state.changes.entries.map((entry, index) => <li key={index} className="py-2 font-instrument text-sm">{entry.description}</li>)}</ul></details></footer>
  </div>;
}

/** Authority magenta is reserved for real authority; an emulated warning gets the test-pattern stamp. */
function TransitionChip({ state, emulated }) {
  if (state === 'warning_active' && emulated) {
    return <span className="stamp-emulated">emulated warning scenario</span>;
  }
  return <VerdictChip state={state} small />;
}

function OnsetShift({ previous, latest }) {
  const current = latest.causal_events?.find((event) => event.route_intersection);
  const prior = previous.causal_events?.find((event) => event.event_key && event.event_key === current?.event_key && event.route_intersection) ?? previous.causal_events?.find((event) => event.route_intersection);
  if (!current?.route_intersection || !prior?.route_intersection) return null;
  const delta = Math.round((Date.parse(current.route_intersection.window_start) - Date.parse(prior.route_intersection.window_start)) / 3600_000);
  return <section className="border-y border-ink/40 py-3 mb-5"><div className="flex justify-between gap-3"><p className="eyebrow">Event onset at the route</p><p className="font-mono text-xs text-event">{Math.abs(delta)} h {delta < 0 ? 'earlier' : 'later'}</p></div><div className="relative h-10 mt-2"><div className="absolute left-0 right-0 top-5 border-t border-ink/40"/><span className="absolute left-[28%] top-0 -translate-x-1/2 font-mono text-[10px]">previous · {fmtTime(prior.route_intersection.window_start)}</span><span className="absolute left-[64%] top-5 -translate-x-1/2 font-mono text-[10px] text-event">latest · {fmtTime(current.route_intersection.window_start)}</span><span className="absolute left-[28%] top-4 w-2 h-2 rounded-full bg-ink"/><span className="absolute left-[64%] top-4 w-2 h-2 rounded-full bg-event"/></div></section>;
}
