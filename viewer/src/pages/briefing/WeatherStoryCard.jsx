import { palette } from '../../lib/palette.js';
import { useState } from 'react';
import { EvidenceLink } from '../../components/common.jsx';
import { capitalize, fmtTime, hazardNoun, placeLabel, plainEventNoun, VERDICT } from '../../lib/format.js';
import { Term } from '../../lib/glossary.jsx';
import { useApp } from '../../stores/appStore.js';
import { usePlayback } from '../../stores/playbackStore.js';
import AssessmentDetails from './AssessmentDetails.jsx';
import { legPlace } from './routeLabels.jsx';

/** the story as a headline card: one look = the message; prose lives behind "why" */
export default function WeatherStoryCard({ findings, sections }) {
  const [expanded, setExpanded] = useState(false);
  const nextRun = useApp((s) => s.briefing?.next_run ?? s.briefing?.next_runs?.[0]);
  const verdictHex = VERDICT[findings.verdict.state]?.hex ?? palette.ink.DEFAULT;
  const synoptic = useApp((state) => state.synoptic);

  const synopticSection = sections.find((s) => s.id === 'synoptic_story');
  const event = findings.causal_events?.[0];
  const headline = event
    ? `${capitalize(plainEventNoun(event, synoptic))} crosses your passage window`
    : synopticSection
      ? placeLabel(firstSentence(synopticSection.register_plain))
      : 'Causal attribution unavailable for this legacy snapshot.';

  const driver = findings.evidence.find(
    (e) => e.evidence_id === findings.verdict.driver_evidence_id,
  );
  let keyFact = null;
  if (driver?.member_fraction) {
    const { exceed, total } = driver.member_fraction;
    const count = exceed === total ? `All ${total}` : `${exceed} of ${total}`;
    keyFact = `${count} forecast scenarios exceed your ${driver.limit} kt ${hazardNoun(driver.rule_id).replace(/s$/, '')} limit ${legPlace(findings, driver.leg_id)}.`;
  } else if (driver && typeof driver.value === 'number') {
    keyFact = `The forecast reaches ${Math.round(driver.value)} ${driver.units} against your ${driver.limit} ${driver.units} limit ${legPlace(findings, driver.leg_id)}.`;
  }

  // three quick-read facts max, in Jack's words (leg id kept as a small cross-reference)
  const bullets = [];
  const worstLeg = [...findings.legs].sort((a, b) => maxOf(b, 'gust_kt') - maxOf(a, 'gust_kt'))[0];
  if (worstLeg) {
    const hs = maxOf(worstLeg, null, (h) => h.waves?.hs_m ?? null);
    bullets.push(
      <>
        Strongest {legPlace(findings, worstLeg.leg_id)}{' '}
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
        {gate.status === 'conflict' ? 'does not fit this departure' : 'only partly fits'}. The
        stream will be against you.
      </>,
    );
  const wac = (findings.events ?? []).find((e) => e.kind === 'wind_against_current');
  if (wac && bullets.length < 3)
    bullets.push(
      <>
        <Term term="wind over tide">Wind over tide</Term> {legPlace(findings, wac.leg_id)} around{' '}
        {fmtTime(wac.window?.from).slice(-5)} UTC. Expect short, steep seas.
      </>,
    );
  const change = sections.find((s) => s.id === 'what_could_change');
  if (change && bullets.length < 3) {
    bullets.push(
      <>{nextRun
        ? `Next forecast update estimated around ${fmtTime(nextRun.expected_at)} UTC. Check again before departure.`
        : 'Next forecast update time unavailable. Check the published forecast before departure.'}</>,
    );
  }

  return (
    <div className="bg-white/40 border hairline rounded-sm shadow-panel p-5 h-full flex flex-col">
      <span className="eyebrow">The weather story</span>
      {event && (
        <StoryPhase findings={findings} event={event} />
      )}
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
          <AssessmentDetails sections={sections} findings={findings} />
        )}
      </div>
    </div>
  );
}

/** Subscribe to the displayed phase, which changes only at event boundaries. */
function StoryPhase({ findings, event }) {
  const start = Date.parse(event.route_intersection?.window_start ?? findings.departure_utc);
  const end = Date.parse(event.route_intersection?.window_end ?? findings.departure_utc);
  const departure = Date.parse(findings.departure_utc);
  const phase = usePlayback((state) => {
    const time = departure + state.cursorHours * 3600_000;
    return time < start ? 'cause' : time <= end ? 'interception' : time <= end + 6 * 3600_000 ? 'consequence' : 'easing';
  });
  return <span className="font-mono text-[10px] text-event mt-2 uppercase">{PHASE_PLAIN[phase]}</span>;
}

/** plain phase words for the story eyebrow; the pro phase names stay in the hero chart focus line */
const PHASE_PLAIN = {
  cause: 'what sets this up',
  interception: 'while you are out there',
  consequence: 'right after your passage',
  easing: 'easing off',
  unavailable: '',
};

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
