import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import RouteMap from '../components/lazy/LeafletLazy.jsx';
import RouteTimeline from '../components/RouteTimeline.jsx';
import ModelFooter from '../components/ModelFooter.jsx';
import { Panel, EvidenceLink, VerdictChip } from '../components/common.jsx';
import { fmtTime, hourStatus, placeLabel, STATUS_HEX, VERDICT } from '../lib/format.js';
import { Term } from '../lib/glossary.jsx';
import clsx from 'clsx';
import BulletinPanel from '../components/BulletinPanel.jsx';
import { deriveCoverage } from '../lib/evidenceSelectors.js';
import SynopticHero from '../components/SynopticHero.jsx';
import { frameForCursor, usePlayback } from '../stores/playbackStore.js';

/** the Jack layer: what each §7 state means for what you DO next (labels stay exact) */
const NEXT_STEP = {
  within:
    'Nothing in this forecast crosses the limits you set. The final call is always yours — check once more before you leave.',
  approaching:
    'It is close to your limits. Read the two or three points on the right before deciding.',
  exceeds:
    'This forecast goes beyond what you said you would accept. Look at WHEN — a different departure often fixes it (try "Compare departure times" on the Plan page).',
  insufficient:
    'The forecast models tell different stories right now. Wait for the next update before deciding — the time is listed below.',
  warning_active:
    'There is an official marine warning for your area. Start with the bulletin — everything else comes second.',
};

const SECTION_ORDER = ['warnings', 'synoptic_story', 'route_impact', 'decision', 'what_could_change', 'unsupported', 'emulated_disclosure'];

export default function Briefing() {
  const findings = useApp((s) => s.findings);
  const briefing = useApp((s) => s.briefing);
  const synoptic = useApp((s) => s.synoptic);
  const route = useApp((s) => s.route);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  if (!findings || !briefing) return <EmptyState />;
  const warningEvidence = findings.evidence.find((item) => item.rule_id === 'A-WARN-01');
  const hasCausalHero = Boolean(synoptic && route && findings.causal_events?.length);

  const sections = [...briefing.sections].sort(
    (a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id),
  );

  return (
    <div>
      <HeaderBar findings={findings} warningEvidence={warningEvidence} onOpenBulletin={() => setBulletinOpen(true)} />
      <JackStrip findings={findings} warningEvidence={warningEvidence} />
      <div className="px-3 sm:px-5 py-4 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] gap-4">
          <div className="min-w-0">
            {hasCausalHero ? (
              <SynopticHero />
            ) : (
              <div>
                <p className="font-instrument text-xs text-ink-soft border-l-4 border-line pl-3 py-1 mb-2">
                  No weather-system track was saved with this briefing, so here is your passage
                  chart. New briefings show the system moving toward your route.
                </p>
                <RouteMap height={430} />
              </div>
            )}
          </div>
          <div className="min-w-0 flex flex-col gap-3">
            <WeatherStoryCard findings={findings} sections={sections} />
            {hasCausalHero && (
              <details className="border hairline bg-white/25"><summary className="px-3 py-2 font-instrument text-xs cursor-pointer">Passage chart inset</summary><div className="p-2"><RouteMap height={240} /></div></details>
            )}
          </div>
        </div>

        <div className="mt-4 border-t border-ink/40 pt-3">
          <div className="flex justify-between items-baseline"><h2 className="font-instrument font-semibold uppercase tracking-wider">Along your route · conditions vs your limits</h2><span className="eyebrow">same time cursor</span></div>
          <RouteTimeline />
          <LegProgressBar findings={findings} />
        </div>

        <ModelFooter />
      </div>
      {bulletinOpen && <BulletinPanel evidence={warningEvidence} onClose={() => setBulletinOpen(false)} />}
    </div>
  );
}

/** compact dark chart-table header: route + departure left, verdict right (mockup 1) */
function HeaderBar({ findings, warningEvidence, onOpenBulletin }) {
  const warningActive = findings.verdict.warning_override?.active;
  const emulated = warningEvidence?.source_kind === 'emulated';
  const productionRefusal = emulated && import.meta.env.VITE_DW_MODE === 'production';
  const personalState = warningActive ? recomputePersonalState(findings) : findings.verdict.state;
  return (
    <div>
      {warningActive && !emulated && (
        <div
          className="text-white px-6 py-2 font-sans text-[13px] flex items-center gap-2"
          style={{ backgroundColor: VERDICT.warning_active.hex }}
        >
          <span aria-hidden>🚩</span>
          <span className="font-semibold uppercase tracking-[0.12em] text-[11px]">
            Official warning active
          </span>
          <span className="opacity-90">— read the bulletin before anything below</span>
          <button type="button" onClick={onOpenBulletin} className="ml-auto underline underline-offset-2 min-h-11">Open official bulletin</button>
        </div>
      )}
      {warningActive && emulated && (
        <div className="warning-emulated px-6 py-2 font-instrument text-[13px] flex items-center gap-3 flex-wrap bg-shoal border-y border-ink/30">
          <span className="stamp-emulated">EMULATED WARNING SCENARIO</span>
          <span>{productionRefusal ? 'Authority styling refused: this source is synthetic.' : 'Synthetic bulletin evidence — never use for a real passage decision.'}</span>
          <EvidenceLink evidenceId={warningEvidence.evidence_id}>evidence</EvidenceLink>
          <button type="button" onClick={onOpenBulletin} className="ml-auto underline underline-offset-2 min-h-11">Open official bulletin</button>
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

/** one plain sentence, action first — directly under the verdict band */
function JackStrip({ findings, warningEvidence }) {
  const state = findings.verdict.warning_override?.active
    ? 'warning_active'
    : findings.verdict.state;
  const hex = VERDICT[state]?.hex ?? '#16283E';
  return (
    <div
      className="px-6 py-2.5 bg-white/50 border-b hairline font-sans text-[14px]"
      style={{ borderLeft: `4px solid ${hex}` }}
    >
      {state === 'warning_active' && warningEvidence?.source_kind === 'emulated'
        ? 'This is a synthetic warning scenario. Use the weather evidence below to test the workflow, never to make a passage decision.'
        : NEXT_STEP[state]}
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

/** the story as a headline card: one look = the message; prose lives behind "why" */
function WeatherStoryCard({ findings, sections }) {
  const [expanded, setExpanded] = useState(false);
  const verdictHex = VERDICT[findings.verdict.state]?.hex ?? '#16283E';
  const cursor = usePlayback((state) => state.cursorHours);
  const synoptic = useApp((state) => state.synoptic);
  const route = useApp((state) => state.route);
  const playbackFrame = frameForCursor(findings, synoptic, route, cursor);

  const synopticSection = sections.find((s) => s.id === 'synoptic_story');
  const event = findings.causal_events?.[0];
  const headline = event
    ? `${event.name} crosses your passage window`
    : synopticSection
      ? placeLabel(firstSentence(synopticSection.register_plain))
      : 'Causal attribution unavailable for this legacy snapshot.';

  const legPlace = (legId) => {
    const leg = findings.legs.find((l) => l.leg_id === legId);
    return leg ? `near ${shortName(leg.name)}` : legId;
  };

  const driver = findings.evidence.find(
    (e) => e.evidence_id === findings.verdict.driver_evidence_id,
  );
  let keyFact = null;
  if (driver?.member_fraction) {
    keyFact = `${driver.member_fraction.exceed} of ${driver.member_fraction.total} forecast scenarios exceed your ${driver.limit} kt limit ${legPlace(driver.leg_id)}.`;
  } else if (driver && typeof driver.value === 'number') {
    keyFact = `The forecast reaches ${driver.value} ${driver.units} against your ${driver.limit} ${driver.units} limit ${legPlace(driver.leg_id)}.`;
  }

  // three quick-read facts max, in Jack's words (leg id kept as a small cross-reference)
  const bullets = [];
  const worstLeg = [...findings.legs].sort((a, b) => maxOf(b, 'gust_kt') - maxOf(a, 'gust_kt'))[0];
  if (worstLeg) {
    const hs = maxOf(worstLeg, null, (h) => h.waves?.hs_m ?? null);
    bullets.push(
      <>
        Strongest {legPlace(worstLeg.leg_id)}{' '}
        <span className="font-mono text-[11px] text-ink-soft">({worstLeg.leg_id})</span>: wind{' '}
        {Math.round(maxOf(worstLeg, 'wind_kt'))} kt, <Term term="gust">gusts</Term>{' '}
        {Math.round(maxOf(worstLeg, 'gust_kt'))} kt
        {hs ? `, waves ${hs.toFixed(1)} m` : ''}.
      </>,
    );
  }
  const gate = (findings.gates ?? []).find((g) => g.status !== 'ok');
  if (gate)
    bullets.push(
      <>
        The <Term term="tidal gate">{gate.name} gate</Term>{' '}
        {gate.status === 'conflict' ? 'does not fit this departure' : 'only partly fits'} — the
        stream will be against you.
      </>,
    );
  const wac = (findings.events ?? []).find((e) => e.kind === 'wind_against_current');
  if (wac && bullets.length < 3)
    bullets.push(
      <>
        <Term term="wind over tide">Wind over tide</Term> {legPlace(wac.leg_id)} around{' '}
        {fmtTime(wac.window?.from).slice(-5)} UTC — expect short, steep seas.
      </>,
    );
  const change = sections.find((s) => s.id === 'what_could_change');
  if (change && bullets.length < 3) {
    const at = change.register_plain.match(/expected around ([^)]+)\)/)?.[1];
    bullets.push(
      <>
        The forecast updates {at ? `around ${at}` : 'several times a day'} — check again before
        you cast off.
      </>,
    );
  }

  return (
    <div className="bg-white/40 border hairline rounded-sm shadow-panel p-5 h-full flex flex-col">
      <span className="eyebrow">The weather story</span>
      {event && <span className="font-mono text-[10px] text-event mt-2 uppercase">phase · {playbackFrame.phase}</span>}
      <h2 className="font-story text-[30px] leading-tight mt-2">{headline}</h2>
      {event && <p className="font-story text-[18px] leading-snug mt-2 text-event">{placeLabel(event.consequence.register_plain)}</p>}
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
              <StorySection key={section.id} section={section} findings={findings} />
            ))}
            <CoverageMatrix findings={findings} />
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
const shortName = (name) => placeLabel(name.split('→')[1]?.trim().split(',')[0] ?? name.slice(0, 24));

function StorySection({ section, findings }) {
  const coverage = section.id === 'unsupported' ? deriveCoverage(findings) : null;
  const unassessed = coverage?.items.filter((item) => item.status === 'not_assessed') ?? [];
  const plain = coverage
    ? `Not assessed: ${unassessed.map((item) => item.detail ?? item.capability.replaceAll('_', ' ')).join(', ')}. No flag does not mean no risk.${coverage.derived ? ' Coverage derived conservatively from evidence in this legacy snapshot.' : ''}`
    : section.register_plain;
  const tone =
    section.id === 'warnings'
      ? 'border-l-4 border-authority pl-3'
      : section.id === 'unsupported' || section.id === 'emulated_disclosure'
        ? 'border-l-4 border-line pl-3'
        : '';

  return (
    <div className={tone}>
      <h3 className="eyebrow mb-1">{section.title}</h3>
      <p className="font-sans text-[13px] leading-relaxed">{plain}</p>
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

function CoverageMatrix({ findings }) {
  const coverage = deriveCoverage(findings);
  return (
    <section className="border-t hairline pt-3" aria-label="Capability coverage">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="eyebrow">Capability coverage</h3>
        {coverage.derived && <span className="font-mono text-[9px] text-ink-soft">derived from evidence · legacy snapshot</span>}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {coverage.items.map((item) => (
          <li key={item.capability} className="flex items-baseline justify-between gap-2 border-b hairline py-1 font-instrument text-[12px]">
            <span>{item.capability.replaceAll('_', ' ')}</span>
            <span className={clsx('font-mono text-[10px]', item.status === 'not_assessed' ? 'text-verdict-insufficient' : item.status === 'assessed_emulated' ? 'stamp-emulated' : 'text-verdict-within')}>
              {item.status.replaceAll('_', ' ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
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
  const from = placeLabel(first?.name.split('→')[0]?.trim().split(',')[0] ?? findings.route_id);
  const to = placeLabel(last?.name.split('→')[1]?.trim().split(',')[0] ?? '');
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
