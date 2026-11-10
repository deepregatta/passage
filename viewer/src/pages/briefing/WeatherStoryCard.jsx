import { useState } from 'react';
import { capitalize, fmtTextTime, placeLabel, plainEventNoun } from '../../lib/format.js';
import { Term } from '../../lib/glossary.jsx';
import { useApp } from '../../stores/appStore.js';
import { usePlayback } from '../../stores/playbackStore.js';
import AssessmentDetails from './AssessmentDetails.jsx';
import { legLabel } from './routeLabels.jsx';
import { strongestText } from './storyFacts.js';
import { useGoverningReason } from './verdictSentence.js';

/** The weather story under the one verdict sentence in the decision band: the
 * system behind it, a note for the governing leg, and three quick facts. It
 * quotes no scenario count (stated once at the top and once in Evidence).
 * When to recheck is stated once, in the decision band above. */
export default function WeatherStoryCard({ findings, sections }) {
  const [expanded, setExpanded] = useState(false);
  const synoptic = useApp((state) => state.synoptic);
  const reason = useGoverningReason(findings);
  const governingLeg = reason?.result?.leg.leg_id ?? reason?.disagreement?.leg.leg_id ?? reason?.other?.leg.leg_id ?? null;

  const synopticSection = sections.find((s) => s.id === 'synoptic_story');
  const systemEvents = (findings.causal_events ?? []).filter((e) => e.route_intersection);
  // the note under the heading belongs to the leg the verdict sentence names, never just the first leg
  const legEvent = governingLeg ? systemEvents.find((e) => e.route_intersection.leg_id === governingLeg) : null;
  const event = legEvent ?? systemEvents[0] ?? findings.causal_events?.[0];
  const heading = event
    ? `${capitalize(plainEventNoun(event, synoptic))} crosses your passage window`
    : synopticSection
      ? placeLabel(firstSentence(synopticSection.register_plain))
      : 'Causal attribution unavailable for this older check.';

  // three quick-read facts max, in Jack's words
  const bullets = [];
  const strongest = strongestText(findings);
  if (strongest) {
    bullets.push(
      <>
        {strongest.head}{' '}
        <Term term="gust">gusts</Term>
        {strongest.tail}
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
        <Term term="wind over tide">Wind over tide</Term> {legLabel(findings, wac.leg_id)} around{' '}
        {fmtTextTime(wac.window?.from)}. Expect short, steep seas.
      </>,
    );

  return (
    <div className="bg-white/40 border hairline rounded-sm shadow-panel p-5 h-full flex flex-col">
      <span className="eyebrow">The weather story</span>
      {event?.route_intersection && (
        <StoryPhase findings={findings} event={event} />
      )}
      <h2 className="font-story text-[19px] leading-snug mt-2">{heading}</h2>
      {legEvent && (
        <p className="font-sans text-[14px] leading-snug mt-1.5 text-ink" data-testid="leg-note">
          {placeLabel(legEvent.consequence.register_plain)}
        </p>
      )}
      <div className="border-t hairline my-4" />
      <ul className="space-y-2.5">
        {bullets.map((b, i) => (
          <li key={i} className="font-sans text-[14px] leading-relaxed flex gap-2">
            <span className="text-ink-soft" aria-hidden>
              ▸
            </span>
            <span className="min-w-0">{b}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="w-full text-left border-t hairline pt-2.5 min-h-11 font-sans text-[13px] text-ink-soft hover:text-ink flex justify-between"
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
  return <span className="font-mono text-xs text-ink-soft mt-2 uppercase">{PHASE_PLAIN[phase]}</span>;
}

/** plain phase words for the story eyebrow; the pro phase names stay in the hero chart focus line */
const PHASE_PLAIN = {
  cause: 'what sets this up',
  interception: 'while you are out there',
  consequence: 'right after your passage',
  easing: 'easing off',
  unavailable: '',
};

const firstSentence = (text) => {
  const s = text.split(/(?<=\.)\s/)[0] ?? text;
  if (s.length <= 130) return s;
  const cut = s.slice(0, 130);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};
