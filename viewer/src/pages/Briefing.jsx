import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import VerdictBanner from '../components/VerdictBanner.jsx';
import RouteMap from '../components/RouteMap.jsx';
import RouteTimeline from '../components/RouteTimeline.jsx';
import ModelFooter from '../components/ModelFooter.jsx';
import { Panel, EvidenceLink } from '../components/common.jsx';
import { fmtTime, hourStatus, STATUS_HEX } from '../lib/format.js';

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
        <header className="mb-4 flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-chart text-3xl">{routeTitle(findings)}</h1>
            <p className="font-mono text-[12px] text-ink-soft mt-1">
              departure {fmtTime(findings.departure_utc)} UTC · {findings.profile_id} ·{' '}
              {findings.snapshot_id}
            </p>
          </div>
          <StatStrip findings={findings} />
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-3">
            <RouteMap height={430} />
          </div>
          <Panel title="Synoptic situation" className="xl:col-span-2">
            <SynopticPanel />
          </Panel>
        </div>

        <Panel title="Route timeline · conditions vs your limits" className="mt-4">
          <RouteTimeline />
          <LegStrip findings={findings} />
        </Panel>

        <Panel title="The weather story" className="mt-4">
          <div className="space-y-5">
            {sections.map((section) => (
              <StorySection key={section.id} section={section} />
            ))}
          </div>
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

function StatStrip({ findings }) {
  const hours = findings.legs.flatMap((l) => l.hours);
  const max = (fn) => {
    const vals = hours.map(fn).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    return vals.length ? Math.round(Math.max(...vals) * 10) / 10 : null;
  };
  const wind = max((h) => h.wind_kt);
  const gust = max((h) => h.gust_kt);
  const hs = max((h) => h.waves?.hs_m ?? null);
  const worstFraction = findings.evidence
    .filter((e) => e.member_fraction)
    .sort((a, b) => b.member_fraction.exceed / b.member_fraction.total - a.member_fraction.exceed / a.member_fraction.total)[0];

  const Stat = ({ value, unit, label }) => (
    <div className="text-center px-3 border-l hairline first:border-0">
      <div className="font-mono text-xl leading-tight">
        {value ?? '—'}
        <span className="text-[11px] text-ink-soft ml-0.5">{unit}</span>
      </div>
      <div className="eyebrow">{label}</div>
    </div>
  );

  return (
    <div className="flex items-stretch bg-white/40 border hairline rounded-sm shadow-panel py-2 pr-1">
      <Stat value={wind} unit="kt" label="max wind" />
      <Stat value={gust} unit="kt" label="max gust" />
      <Stat value={hs} unit="m" label="max seas" />
      {worstFraction && (
        <div className="text-center px-3 border-l hairline">
          <div className="font-mono text-xl leading-tight">
            <EvidenceLink evidenceId={worstFraction.evidence_id}>
              {worstFraction.member_fraction.exceed}/{worstFraction.member_fraction.total}
            </EvidenceLink>
          </div>
          <div className="eyebrow">scenarios over limit</div>
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
  const rank = { ok: 0, unknown: 0, approaching: 1, exceeded: 2 };
  return (
    <div className="mt-3 flex items-stretch font-sans" aria-label="Legs">
      {findings.legs.map((leg) => {
        let worst = 'ok';
        for (const hour of leg.hours) {
          const s = hourStatus(hour);
          if (rank[s] > rank[worst]) worst = s;
        }
        return (
          <div
            key={leg.leg_id}
            className="border hairline border-l-0 first:border-l px-2 py-1.5 text-center min-w-0"
            style={{ flexGrow: Math.max(leg.distance_nm, 4), borderTop: `3px solid ${STATUS_HEX[worst]}` }}
          >
            <div className="font-mono text-[11px]">{leg.leg_id}</div>
            <div className="text-[11px] text-ink-soft truncate">{leg.distance_nm} nm</div>
            <div className="font-mono text-[10px] text-ink-soft">
              {fmtTime(leg.eta_range.fast).slice(-5)}–{fmtTime(leg.eta_range.slow).slice(-5)}
            </div>
          </div>
        );
      })}
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
