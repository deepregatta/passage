import { useEffect, useState } from 'react';
import { trackOnce } from '../lib/analytics.js';
import { useApp } from '../stores/appStore.js';
import RouteMap from '../components/lazy/LeafletLazy.jsx';
import RouteTimeline from '../components/RouteTimeline.jsx';
import ModelFooter from '../components/ModelFooter.jsx';
import BulletinPanel from '../components/BulletinPanel.jsx';
import ModelsUsed from '../components/ModelsUsed.jsx';
import SynopticHero from '../components/SynopticHero.jsx';
import HeaderBar from './briefing/HeaderBar.jsx';
import DecisionBand from './briefing/DecisionBand.jsx';
import WeatherStoryCard from './briefing/WeatherStoryCard.jsx';
import LegProgressBar from './briefing/LegProgressBar.jsx';

const SECTION_ORDER = ['warnings', 'synoptic_story', 'route_impact', 'decision', 'what_could_change', 'unsupported', 'emulated_disclosure'];

export default function Briefing() {
  const findings = useApp((s) => s.findings);
  const briefing = useApp((s) => s.briefing);
  const synoptic = useApp((s) => s.synoptic);
  const route = useApp((s) => s.route);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const snapshotId = useApp((s) => s.snapshotId);
  const attempt = useApp((s) => s.measurementAttempt);
  const example = useApp((s) => s.snapshot?.demo === true || s.manifest?.snapshots?.find(item => item.snapshot_id === s.snapshotId)?.demo === true);
  const loading = useApp((s) => s.loading);
  const loadError = useApp((s) => s.loadError);
  const ready = !loading && !loadError && Boolean(findings?.verdict?.state && briefing?.sections?.length && findings?.legs?.length);
  useEffect(() => {
    if (!ready || !snapshotId) return;
    const event = attempt ? 'passage_run' : example ? 'passage_example_view' : 'passage_briefing_view';
    trackOnce(`${event}:${attempt || snapshotId}`, event, { verdict: findings.verdict.state, result_rendered: true });
  }, [ready, snapshotId, attempt, example, findings]);
  if (loadError) return <p role="alert" className="p-6 font-sans text-sm text-verdict-exceeds break-words">{loadError}</p>;
  if (loading) return <p role="status" className="p-6 font-instrument text-ink-soft">Loading passage instruments…</p>;
  if (!findings || !briefing) return <EmptyState />;
  const warningEvidence = findings.evidence.find((item) => item.rule_id === 'A-WARN-01');
  // the synoptic chart is the product's differentiator: it renders whenever the
  // snapshot archived one; an empty causal_events list only changes the story on top
  const hasSynopticHero = Boolean(
    synoptic && route && (synoptic.chart_captions?.length || synoptic.systems?.length),
  );

  const sections = [...briefing.sections].sort(
    (a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id),
  );

  return (
    <div>
      <HeaderBar findings={findings} />
      <DecisionBand
        findings={findings}
        example={example}
        synoptic={synoptic}
        warningEvidence={warningEvidence}
        onOpenBulletin={() => setBulletinOpen(true)}
      />
      <div className="px-3 sm:px-5 py-4 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] gap-4">
          <div className="min-w-0">
            {hasSynopticHero ? (
              <SynopticHero />
            ) : (
              <div>
                <p className="font-instrument text-xs text-ink-soft border-l-4 border-line pl-3 py-1 mb-2">
                  No synoptic chart was archived with this briefing, so here is your passage
                  chart. New briefings show the pressure pattern behind your forecast.
                </p>
                <RouteMap height={430} />
              </div>
            )}
          </div>
          <div className="min-w-0 flex flex-col gap-3">
            <WeatherStoryCard findings={findings} sections={sections} />
            {hasSynopticHero && (
              <details open className="border hairline bg-white/25"><summary className="px-3 py-2 font-instrument text-xs cursor-pointer">Passage chart · synced to playback</summary><div className="p-2"><RouteMap height={240} /></div></details>
            )}
          </div>
        </div>

        <div className="mt-4 border-t border-ink/40 pt-3">
          <div className="flex justify-between items-baseline"><h2 className="font-instrument font-semibold uppercase tracking-wider">Along your route · conditions vs your limits</h2><span className="eyebrow">same time cursor</span></div>
          <RouteTimeline />
          <LegProgressBar findings={findings} />
        </div>

        <ModelFooter />
        <ModelsUsed />
      </div>
      {bulletinOpen && <BulletinPanel evidence={warningEvidence} onClose={() => setBulletinOpen(false)} />}
    </div>
  );
}

function EmptyState() {
  const setPage = useApp((s) => s.setPage);
  return (
    <div className="p-10">
      <p className="font-sans text-ink-soft">
        No analysis open.{' '}
        <button type="button" className="underline" onClick={() => setPage('snapshots')}>
          Choose a snapshot
        </button>
        .
      </p>
    </div>
  );
}
