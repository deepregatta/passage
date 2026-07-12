import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import RouteMap from '../components/RouteMap.jsx';
import RouteTimeline from '../components/RouteTimeline.jsx';
import ModelFooter from '../components/ModelFooter.jsx';
import { Panel, EvidenceLink, VerdictChip } from '../components/common.jsx';
import { fmtTime, hourStatus, STATUS_HEX, VERDICT } from '../lib/format.js';
import clsx from 'clsx';

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
      <HeaderBar findings={findings} />
      <div className="px-6 py-4 max-w-6xl">
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-3 min-w-0">
            <HeroTabs />
          </div>
          <div className="xl:col-span-2 min-w-0">
            <WeatherStoryCard findings={findings} sections={sections} />
          </div>
        </div>

        <Panel title="Along your route · conditions vs your limits" className="mt-4">
          <RouteTimeline />
          <LegProgressBar findings={findings} />
        </Panel>

        <ModelFooter />
      </div>
    </div>
  );
}

/** compact dark chart-table header: route + departure left, verdict right (mockup 1) */
function HeaderBar({ findings }) {
  const warningActive = findings.verdict.warning_override?.active;
  const personalState = warningActive ? recomputePersonalState(findings) : findings.verdict.state;
  return (
    <div>
      {warningActive && (
        <div
          className="text-white px-6 py-2 font-sans text-[13px] flex items-center gap-2"
          style={{ backgroundColor: VERDICT.warning_active.hex }}
        >
          <span aria-hidden>🚩</span>
          <span className="font-semibold uppercase tracking-[0.12em] text-[11px]">
            Official warning active
          </span>
          <span className="opacity-90">— read the bulletin before anything below</span>
        </div>
      )}
      <div className="bg-ink-deep text-paper px-6 py-3 flex items-center justify-between flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-4 flex-wrap">
          <span className="font-chart text-2xl tracking-wide">{routeTitle(findings)}</span>
          <span className="font-mono text-[12px] opacity-70">
            dep {fmtTime(findings.departure_utc)} UTC
          </span>
        </div>
        <VerdictChip state={personalState} />
      </div>
    </div>
  );
}

function recomputePersonalState(findings) {
  let approaching = false;
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      const statuses = Object.values(hour.limit_status ?? {});
      if (statuses.includes('exceeded')) return 'exceeds';
      if (statuses.includes('approaching')) approaching = true;
    }
  }
  return approaching ? 'approaching' : 'within';
}

/** hero: one big chart area with tabs — the passage chart and the synoptic panels */
function HeroTabs() {
  const [tab, setTab] = useState('route');
  return (
    <div className="bg-white/40 border hairline rounded-sm shadow-panel">
      <div className="flex items-center gap-1 px-3 pt-2">
        {[
          ['route', 'Passage chart'],
          ['synoptic', 'Synoptic situation'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={clsx(
              'font-sans text-[12px] uppercase tracking-[0.12em] px-3 py-1.5 rounded-t-sm border border-b-0',
              tab === id ? 'bg-paper border-ink/30 text-ink' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="p-3 border-t hairline">
        {tab === 'route' ? <RouteMap height={430} /> : <SynopticPanel />}
      </div>
    </div>
  );
}

/** the story as a headline card: one look = the message; prose lives behind "why" */
function WeatherStoryCard({ findings, sections }) {
  const [expanded, setExpanded] = useState(false);
  const verdictHex = VERDICT[findings.verdict.state]?.hex ?? '#16283E';

  const synopticSection = sections.find((s) => s.id === 'synoptic_story');
  const headline = synopticSection
    ? firstSentence(synopticSection.register_plain)
    : 'The forecast at a glance';

  const driver = findings.evidence.find(
    (e) => e.evidence_id === findings.verdict.driver_evidence_id,
  );
  let keyFact = null;
  if (driver?.member_fraction) {
    keyFact = `${driver.member_fraction.exceed} of ${driver.member_fraction.total} forecast scenarios exceed your ${driver.limit} kt limit on ${driver.leg_id}.`;
  } else if (driver && typeof driver.value === 'number') {
    keyFact = `${driver.leg_id} reaches ${driver.value} ${driver.units} against your ${driver.limit} ${driver.units} limit.`;
  }

  // three quick-read facts max
  const bullets = [];
  const worstLeg = [...findings.legs].sort((a, b) => maxOf(b, 'gust_kt') - maxOf(a, 'gust_kt'))[0];
  if (worstLeg) {
    const hs = maxOf(worstLeg, null, (h) => h.waves?.hs_m ?? null);
    bullets.push(
      `Strongest on ${worstLeg.leg_id} (${shortName(worstLeg.name)}): ${Math.round(maxOf(worstLeg, 'wind_kt'))}–${Math.round(maxOf(worstLeg, 'gust_kt'))} kt${hs ? `, seas ${hs.toFixed(1)} m` : ''}.`,
    );
  }
  const gate = (findings.gates ?? []).find((g) => g.status !== 'ok');
  if (gate) bullets.push(`${gate.name}: ${gate.status === 'conflict' ? 'outside' : 'partly outside'} the favorable stream.`);
  const wac = (findings.events ?? []).find((e) => e.kind === 'wind_against_current');
  if (wac && bullets.length < 3) bullets.push(`Wind over tide on ${wac.leg_id} around ${fmtTime(wac.window?.from).slice(-5)} UTC — steeper seas.`);
  const change = sections.find((s) => s.id === 'what_could_change');
  if (change && bullets.length < 3) {
    const at = change.register_plain.match(/expected around ([^)]+)\)/)?.[1];
    bullets.push(`Forecast updates ${at ? `~${at}` : 'several times a day'} — recheck before you go.`);
  }

  return (
    <div className="bg-white/40 border hairline rounded-sm shadow-panel p-5 h-full flex flex-col">
      <span className="eyebrow">The weather story</span>
      <h2 className="font-chart text-[26px] leading-snug mt-2">{headline}</h2>
      {keyFact && (
        <p className="font-chart text-[19px] leading-snug mt-1.5" style={{ color: verdictHex }}>
          {driver ? <EvidenceLink evidenceId={driver.evidence_id}>{keyFact}</EvidenceLink> : keyFact}
        </p>
      )}
      <div className="border-t hairline my-4" />
      <ul className="space-y-2.5">
        {bullets.map((b, i) => (
          <li key={i} className="font-sans text-[14px] leading-relaxed flex gap-2">
            <span className="text-ink-soft" aria-hidden>
              ▸
            </span>
            {b}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="w-full text-left border-t hairline pt-2.5 font-sans text-[13px] text-ink-soft hover:text-ink flex justify-between"
        >
          Why this assessment
          <span aria-hidden>{expanded ? '▴' : '▾'}</span>
        </button>
        {expanded && (
          <div className="mt-3 space-y-4 max-h-[340px] overflow-y-auto pr-1">
            {sections.map((section) => (
              <StorySection key={section.id} section={section} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const maxOf = (leg, key, fn) => {
  const vals = leg.hours
    .map(fn ?? ((h) => h[key]))
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : 0;
};
const firstSentence = (text) => {
  const s = text.split(/(?<=\.)\s/)[0] ?? text;
  if (s.length <= 130) return s;
  const cut = s.slice(0, 130);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};
const shortName = (name) => name.split('→')[1]?.trim().split(',')[0] ?? name.slice(0, 24);

function StorySection({ section }) {
  const tone =
    section.id === 'warnings'
      ? 'border-l-4 border-authority pl-3'
      : section.id === 'unsupported' || section.id === 'emulated_disclosure'
        ? 'border-l-4 border-line pl-3'
        : '';

  return (
    <div className={tone}>
      <h3 className="eyebrow mb-1">{section.title}</h3>
      <p className="font-sans text-[13px] leading-relaxed">{section.register_plain}</p>
      {section.per_leg && (
        <ul className="mt-1.5 space-y-1.5">
          {section.per_leg.map((leg) => (
            <li key={leg.leg_id} className="font-sans text-[13px] leading-relaxed">
              <span className="font-mono text-[11px] text-ink-soft mr-1.5">{leg.leg_id}</span>
              {leg.register_plain}{' '}
              {leg.evidence_ids.length > 0 && (
                <EvidenceLink evidenceId={leg.evidence_ids[0]}>evidence</EvidenceLink>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1">
        <summary className="font-sans text-[12px] text-ink-soft cursor-pointer">
          professional register
        </summary>
        <p className="font-sans text-[12px] leading-relaxed text-ink-soft mt-1">
          {section.register_pro}
        </p>
        {section.evidence_ids.length > 0 && (
          <p className="mt-1 font-mono text-[11px] text-ink-soft">
            evidence:{' '}
            {section.evidence_ids.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <EvidenceLink evidenceId={id}>{id}</EvidenceLink>
              </span>
            ))}
          </p>
        )}
      </details>
    </div>
  );
}

function SynopticPanel() {
  const findings = useApp((s) => s.findings);
  const [state, setState] = useState(null);
  const [routeDoc, setRouteDoc] = useState(null);
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

  useEffect(() => {
    if (!findings) return;
    fetch(`/data/snapshots/${findings.snapshot_id}/route.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setRouteDoc)
      .catch(() => {});
  }, [findings]);

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
  const meta = state.captions.find((c) => c.file === file || chart.endsWith(c.file ?? ''));
  const overlay = buildRouteOverlay(meta, routeDoc);

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
      <div className="relative border hairline rounded-sm overflow-hidden">
        <img src={`/data/${chart}`} alt={`Synoptic chart ${file}`} className="w-full block" />
        {overlay && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox={`0 0 ${overlay.w} ${overlay.h}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <polyline
              points={overlay.points}
              fill="none"
              stroke="#16283E"
              strokeWidth={overlay.w / 340}
              strokeDasharray={`${overlay.w / 300} ${overlay.w / 170}`}
              strokeLinecap="round"
            />
            <circle cx={overlay.start.x} cy={overlay.start.y} r={overlay.w / 190} fill="#16283E" />
            <circle
              cx={overlay.end.x}
              cy={overlay.end.y}
              r={overlay.w / 190}
              fill="#F3EEE3"
              stroke="#16283E"
              strokeWidth={overlay.w / 500}
            />
          </svg>
        )}
      </div>
      {meta?.caption && (
        <p className="font-sans text-[13px] text-ink-soft mt-2 leading-relaxed">{meta.caption}</p>
      )}
      <p className="font-mono text-[10px] text-ink-soft mt-1">
        {state.run} · MSLP isobars{overlay ? ' · your route marked' : ''} · contains modified ECMWF
        open data (CC-BY-4.0)
      </p>
    </div>
  );
}

/** map route lon/lat onto the PNG's published axes geometry */
function buildRouteOverlay(meta, routeDoc) {
  if (!meta?.axes_px || !meta?.geo || !meta?.size_px || !routeDoc?.waypoints?.length) return null;
  const { axes_px: a, geo: g, size_px: s } = meta;
  const toX = (lon) => a.x0 + ((lon - g.lon_min) / (g.lon_max - g.lon_min)) * (a.x1 - a.x0);
  const toY = (lat) => a.y0 + ((g.lat_max - lat) / (g.lat_max - g.lat_min)) * (a.y1 - a.y0);
  const pts = routeDoc.waypoints.map((wp) => ({ x: toX(wp.lon), y: toY(wp.lat) }));
  return {
    w: s.w,
    h: s.h,
    points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    start: pts[0],
    end: pts[pts.length - 1],
  };
}

/** leg progress bar: numbered dots on a line, distances + durations beneath (mockup 1) */
function LegProgressBar({ findings }) {
  const rank = { ok: 0, unknown: 0, approaching: 1, exceeded: 2 };
  const total = findings.legs.reduce((s, l) => s + l.distance_nm, 0);
  let cum = 0;
  const dots = findings.legs.map((leg, i) => {
    cum += leg.distance_nm;
    let worst = 'ok';
    for (const hour of leg.hours) {
      const s = hourStatus(hour);
      if (rank[s] > rank[worst]) worst = s;
    }
    const durH = (Date.parse(leg.eta_range.nominal) - Date.parse(leg.enter_range.nominal)) / 3600000;
    return {
      leg,
      i,
      pct: (cum / total) * 100,
      midPct: ((cum - leg.distance_nm / 2) / total) * 100,
      color: STATUS_HEX[worst],
      durH,
    };
  });
  const [from, to] = routeTitle(findings).split('→').map((s) => s.trim());

  return (
    <div className="mt-4 px-2" aria-label="Legs">
      <div className="relative h-5">
        <div className="absolute left-0 right-0 top-2 border-t-2 border-ink/50" />
        <div className="absolute -left-1 top-0.5 w-3.5 h-3.5 rounded-full bg-ink border-2 border-paper shadow" />
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${d.pct}%` }}
          >
            <div
              className="w-[22px] h-[22px] -mt-0.5 rounded-full text-paper font-sans font-semibold text-[11px] flex items-center justify-center border-2 border-paper"
              style={{ backgroundColor: d.color, boxShadow: `0 0 0 1.5px ${d.color}` }}
            >
              {d.i + 1}
            </div>
          </div>
        ))}
      </div>
      <div className="relative h-9">
        <span className="absolute left-0 font-sans font-medium text-[12px]">{from}</span>
        <span className="absolute right-0 font-sans font-medium text-[12px] text-right">{to}</span>
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute -translate-x-1/2 text-center font-mono text-[10px] text-ink-soft leading-tight pt-1"
            style={{ left: `${d.midPct}%` }}
          >
            {Math.round(d.leg.distance_nm)} NM
            <br />
            {Math.floor(d.durH)}h{String(Math.round((d.durH % 1) * 60)).padStart(2, '0')}
          </div>
        ))}
      </div>
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
