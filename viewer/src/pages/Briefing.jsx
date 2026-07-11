import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import VerdictBanner from '../components/VerdictBanner.jsx';
import RouteTimeline from '../components/RouteTimeline.jsx';
import ModelFooter from '../components/ModelFooter.jsx';
import { Panel, EvidenceLink } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';

const SECTION_ORDER = ['warnings', 'synoptic_story', 'route_impact', 'decision', 'what_could_change', 'unsupported', 'emulated_disclosure'];

export default function Briefing() {
  const findings = useApp((s) => s.findings);
  const briefing = useApp((s) => s.briefing);
  if (!findings || !briefing) return <EmptyState />;

  const sections = [...briefing.sections].sort(
    (a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id),
  );

  return (
    <div>
      <VerdictBanner />
      <div className="px-6 py-5 max-w-6xl">
        <header className="mb-5 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h1 className="font-chart text-3xl">{routeTitle(findings)}</h1>
            <p className="font-mono text-[13px] text-ink-soft mt-1">
              departure {fmtTime(findings.departure_utc)} UTC · profile {findings.profile_id} ·
              snapshot {findings.snapshot_id}
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <Panel title="Synoptic situation" className="xl:col-span-2">
            <SynopticPanel />
          </Panel>

          <Panel title="The weather story" className="xl:col-span-3">
            <div className="space-y-5">
              {sections.map((section) => (
                <StorySection key={section.id} section={section} />
              ))}
            </div>
          </Panel>
        </div>

        <Panel title="Route timeline · conditions vs your limits" className="mt-4">
          <RouteTimeline />
          <LegStrip findings={findings} />
        </Panel>

        <ModelFooter />
      </div>
    </div>
  );
}

function StorySection({ section }) {
  const [expanded, setExpanded] = useState(false);
  const tone =
    section.id === 'warnings'
      ? 'border-l-4 border-authority pl-3'
      : section.id === 'unsupported' || section.id === 'emulated_disclosure'
        ? 'border-l-4 border-line pl-3'
        : '';

  return (
    <div className={tone}>
      <h3 className="eyebrow mb-1">{section.title}</h3>
      <p className="font-chart text-[17px] leading-relaxed">{section.register_plain}</p>

      {section.per_leg && (
        <ul className="mt-2 space-y-2">
          {section.per_leg.map((leg) => (
            <li key={leg.leg_id} className="font-sans text-[14px] leading-relaxed">
              <span className="font-mono text-[12px] text-ink-soft mr-1.5">{leg.leg_id}</span>
              {leg.register_plain}{' '}
              {leg.evidence_ids.length > 0 && (
                <EvidenceLink evidenceId={leg.evidence_ids[0]}>evidence</EvidenceLink>
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="mt-1.5 font-sans text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? 'hide the professional reasoning' : 'why this assessment ▸'}
      </button>
      {expanded && (
        <div className="mt-2 bg-shoal/30 border hairline rounded-sm p-3">
          <p className="font-sans text-[13px] leading-relaxed">{section.register_pro}</p>
          {section.per_leg && (
            <ul className="mt-2 space-y-1.5">
              {section.per_leg.map((leg) => (
                <li key={leg.leg_id} className="font-sans text-[13px] leading-relaxed text-ink-soft">
                  {leg.register_pro}
                </li>
              ))}
            </ul>
          )}
          {section.evidence_ids.length > 0 && (
            <p className="mt-2 font-mono text-[11px] text-ink-soft">
              evidence:{' '}
              {section.evidence_ids.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <EvidenceLink evidenceId={id}>{id}</EvidenceLink>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SynopticPanel() {
  const [state, setState] = useState(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const latest = await fetch('/data/runs/latest.json').then((r) => (r.ok ? r.json() : null));
        const charts = latest?.artifacts?.synoptic_charts;
        if (!charts?.length) return setState({ missing: true });
        const features = latest.artifacts.synoptic_features
          ? await fetch(`/data/${latest.artifacts.synoptic_features}`).then((r) => (r.ok ? r.json() : null))
          : null;
        setState({ charts, captions: features?.chart_captions ?? [], run: latest.run_id });
      } catch {
        setState({ missing: true });
      }
    })();
  }, []);

  if (!state) return <p className="font-sans text-sm text-ink-soft">Loading chart…</p>;
  if (state.missing) {
    return (
      <div className="text-center py-10 bg-shoal/30 border border-dashed hairline rounded-sm">
        <p className="font-chart text-lg text-ink-soft">Synoptic chart</p>
        <p className="font-sans text-sm text-ink-soft mt-1">
          Run <span className="font-mono text-[12px]">deepweather-analysis prepare-run</span> to
          render it from the latest model cycle.
        </p>
      </div>
    );
  }

  const chart = state.charts[step];
  const file = chart.split('/').pop();
  const caption = state.captions.find((c) => c.file === file || chart.endsWith(c.file ?? ''))?.caption;
  return (
    <div>
      <div className="flex gap-1.5 mb-2">
        {state.charts.map((c, i) => (
          <button
            key={c}
            type="button"
            onClick={() => setStep(i)}
            className={
              'font-mono text-[11px] px-2 py-0.5 border rounded-sm ' +
              (i === step ? 'bg-ink text-paper border-ink' : 'border-line text-ink-soft hover:border-ink-soft')
            }
          >
            T+{(c.match(/t(\d+)\.png/)?.[1] ?? '0').replace(/^0+(?=\d)/, '')}
          </button>
        ))}
      </div>
      <img src={`/data/${chart}`} alt={`Synoptic chart ${file}`} className="w-full border hairline rounded-sm" />
      {caption && <p className="font-sans text-[13px] text-ink-soft mt-2 leading-relaxed">{caption}</p>}
      <p className="font-mono text-[10px] text-ink-soft mt-1">
        {state.run} · MSLP isobars · contains modified ECMWF open data (CC-BY-4.0)
      </p>
    </div>
  );
}

function LegStrip({ findings }) {
  return (
    <div className="mt-3 flex items-stretch font-sans" aria-label="Legs">
      {findings.legs.map((leg) => (
        <div
          key={leg.leg_id}
          className="border hairline border-l-0 first:border-l px-2 py-1.5 text-center min-w-0"
          style={{ flexGrow: Math.max(leg.distance_nm, 4) }}
        >
          <div className="font-mono text-[11px]">{leg.leg_id}</div>
          <div className="text-[11px] text-ink-soft truncate">{leg.distance_nm} nm</div>
          <div className="font-mono text-[10px] text-ink-soft">
            {fmtTime(leg.eta_range.fast).slice(-5)}–{fmtTime(leg.eta_range.slow).slice(-5)}
          </div>
        </div>
      ))}
    </div>
  );
}

function routeTitle(findings) {
  const first = findings.legs[0];
  const last = findings.legs[findings.legs.length - 1];
  const from = first?.name.split('→')[0]?.trim().split(',')[0] ?? findings.route_id;
  const to = last?.name.split('→')[1]?.trim().split(',')[0] ?? '';
  return to ? `${from} → ${to}` : from;
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
