import { useEffect, useState } from 'react';
import { trackOnce } from '../lib/analytics.js';
import { useApp } from '../stores/appStore.js';
import RouteTimeline from '../components/RouteTimeline.jsx';
import BulletinPanel from '../components/BulletinPanel.jsx';
import DecisionBand from './briefing/DecisionBand.jsx';
import WeatherStoryCard from './briefing/WeatherStoryCard.jsx';
import LegProgressBar from './briefing/LegProgressBar.jsx';
import PassageChart from './briefing/PassageChart.jsx';
import SectionNav, { scrollToSection } from './briefing/SectionNav.jsx';
import EvidenceSection from './briefing/EvidenceSection.jsx';
import ChangesSection from './briefing/ChangesSection.jsx';
import OutcomeSection from './briefing/OutcomeSection.jsx';

const SECTION_ORDER = ['warnings', 'synoptic_story', 'route_impact', 'decision', 'what_could_change', 'unsupported', 'emulated_disclosure'];

/** One passage, one page: the verdict once, then its story, route, evidence,
 * changes since the last check and how it turned out. */
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
  const section = useApp((s) => s.passageSection);
  const setSection = useApp((s) => s.setPassageSection);
  const ready = !loading && !loadError && Boolean(findings?.verdict?.state && briefing?.sections?.length && findings?.legs?.length);
  useEffect(() => {
    if (!ready || !snapshotId) return;
    const event = attempt ? 'passage_run' : example ? 'passage_example_view' : 'passage_briefing_view';
    trackOnce(`${event}:${attempt || snapshotId}`, event, { verdict: findings.verdict.state, result_rendered: true });
  }, [ready, snapshotId, attempt, example, findings]);
  // a deep link to evidence, changes or outcome lands there once the briefing renders
  useEffect(() => {
    if (!ready || !section) return;
    scrollToSection(section);
    setSection(null);
  }, [ready, section, setSection]);
  if (loadError) return <p role="alert" className="p-6 font-sans text-sm text-verdict-exceeds break-words">{loadError}</p>;
  if (loading) return <p role="status" className="p-6 font-instrument text-ink-soft">Loading passage instruments…</p>;
  if (!findings || !briefing) return <EmptyState />;
  const warningEvidence = findings.evidence.find((item) => item.rule_id === 'A-WARN-01');
  // the synoptic chart is the product's differentiator: it renders whenever the
  // snapshot archived one; an empty causal_events list only changes the story on top
  const hasSynoptic = Boolean(
    synoptic && route && (synoptic.chart_captions?.length || synoptic.systems?.length),
  );

  const sections = [...briefing.sections].sort(
    (a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id),
  );

  return (
    <div>
      <div data-print-hide>
        <DecisionBand
          findings={findings}
          example={example}
          warningEvidence={warningEvidence}
          onOpenBulletin={() => setBulletinOpen(true)}
        />
      </div>
      <SectionNav />
      <div className="px-3 sm:px-5 max-w-[1600px] mx-auto">
        <Section id="story" label="Story">
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] gap-4">
            {/* on narrow screens the why comes before the chart */}
            <div className="min-w-0 order-2 xl:order-1">
              <PassageChart hasSynoptic={hasSynoptic} />
            </div>
            <div className="min-w-0 order-1 xl:order-2">
              <WeatherStoryCard findings={findings} sections={sections} />
            </div>
          </div>
        </Section>

        <Section id="route" label="Along the route">
          <h2 className="font-instrument font-semibold uppercase tracking-wider">Along your route · conditions vs your limits</h2>
          <RouteTimeline />
          <LegProgressBar findings={findings} />
        </Section>

        <Section id="evidence" label="Evidence">
          <EvidenceSection />
        </Section>

        <Section id="changes" label="What changed">
          <ChangesSection />
        </Section>

        <Section id="outcome" label="How it turned out">
          <OutcomeSection />
        </Section>
      </div>
      {bulletinOpen && <BulletinPanel evidence={warningEvidence} onClose={() => setBulletinOpen(false)} />}
    </div>
  );
}

function Section({ id, label, children }) {
  return (
    <section data-section={id} aria-label={label} className="scroll-mt-28 py-6 border-t border-ink/40 first:border-t-0 first:pt-4">
      {children}
    </section>
  );
}

function EmptyState() {
  const setPage = useApp((s) => s.setPage);
  return (
    <div className="p-10">
      <p className="font-sans text-ink-soft">
        No briefing open.{' '}
        <button type="button" className="underline" onClick={() => setPage('passages')}>
          Choose a passage
        </button>
        .
      </p>
    </div>
  );
}
