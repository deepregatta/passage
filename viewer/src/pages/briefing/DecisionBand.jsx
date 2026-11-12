import { useMemo } from 'react';
import clsx from 'clsx';
import { EvidenceLink, VerdictChip } from '../../components/common.jsx';
import { isEmulatedWarning } from '../../components/BulletinPanel.jsx';
import { ShareAnalysisButton } from '../../components/FooterActions.jsx';
import { fmtLocalTime, localTimeZoneName, toLocalDateTimeValue, VERDICT } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { newPassageId } from '../../lib/passageIdentity.js';
import { usePlanner } from '../../stores/plannerStore.js';
import { routeTitle } from './routeLabels.jsx';
import { OWNED, passageKeyOf, userRouteName } from '../../lib/passages.js';
import { passageLabels } from '../../lib/passageLabels.js';
import { nextRunText } from './nextRunText.js';
import { useGoverningReason, verdictSentences } from './verdictSentence.js';
import useNowMs from '../../hooks/useNowMs.js';
import { missingForecastHours } from '../../lib/missingForecastHours.js';

/** the action line: what each verdict state means for what you DO next. The numbers are in the
 * verdict sentence above it, never repeated here. */
const NEXT_STEP = {
  within:
    'The forecast stays inside the limits you set. Check the latest run once more before you leave.',
  approaching:
    'It is close to your limits. Read the weather story below before deciding.',
  exceeds:
    'This forecast crosses your limits. Compare departure times before changing the route.',
  insufficient: 'Wait for the next run before deciding.',
};

/** "within" when hours of the arrival range have no forecast value: only the hours with values are inside. */
const WITHIN_PARTIAL_STEP = 'Where the forecast has values, it stays inside the limits you set. Check the latest run once more before you leave.';

/**
 * The 10-second layer, before any chart: which passage, ONE verdict sentence
 * (the governing reason: warning, disagreement and/or the limit result) with the
 * verdict chip beside it, and what to do next. The chip shows the verdict state
 * itself, so chip and sentence always describe the same state.
 */
export default function DecisionBand({ findings, warningEvidence, onOpenBulletin, example }) {
  const setPage = useApp((s) => s.setPage);
  const route = useApp((s) => s.route);
  const warnings = useApp((s) => s.warnings);
  // a name the sailor gave on My passages is a display label for the whole passage: it leads here too
  const snapshots = useApp((s) => s.manifest?.snapshots);
  const snapshotId = useApp((s) => s.snapshotId);
  const label = useMemo(() => passageLabels.all()[passageKeyOf(snapshots, snapshotId)] ?? null, [snapshots, snapshotId]);
  const warningActive = findings.verdict.warning_override?.active;
  const emulated = warningActive && isEmulatedWarning(warningEvidence, warnings);
  const state = warningActive ? 'warning_active' : findings.verdict.state;
  const reason = useGoverningReason(findings);
  const sentences = verdictSentences(findings, reason, { emulatedWarning: emulated });
  // the verdict ignores hours missing a value a limit needs: say how many, whatever the verdict
  const missingHours = useMemo(() => missingForecastHours(findings), [findings]);

  // when to look again; the single place the page states it, read at display time
  const briefing = useApp((s) => s.briefing);
  const nowMs = useNowMs();
  const nextRun = nextRunText(briefing, nowMs);

  const offerScan = !example && ['exceeds', 'approaching', 'warning_active'].includes(state) && route;
  const continuePassage = (autoScan = false) => {
    usePlanner.getState().patch({
      passageId: findings.identity_version === 2 && findings.passage_id ? findings.passage_id : newPassageId(),
      mode: 'draw',
      name: route.name ?? findings.route_id,
      waypoints: route.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lon })),
      speeds: route.speeds_kt ? { ...route.speeds_kt } : usePlanner.getState().speeds,
      departureLocal: toLocalDateTimeValue(findings.departure_utc),
      computed: null,
      scan: null,
      autoScan,
    });
    setPage('planner');
  };

  const buttonClass = 'border border-ink/50 bg-paper/60 px-3.5 py-2 min-h-11 font-sans text-[14px] hover:bg-paper';

  return (
    <section aria-label="Decision" data-testid="decision-band" className="bg-shoal/70 border-b border-ink/30">
      <div className="px-4 sm:px-6 py-5 max-w-[1600px] mx-auto flex flex-col gap-3">
        <div className="min-w-0">
          <p className="font-chart text-[20px] sm:text-[24px] leading-tight" {...(label ? OWNED : {})}>{label ?? userRouteName(route) ?? routeTitle(findings)}</p>
          <p className="font-mono text-[12px] text-ink-soft mt-1">
            <span>dep</span> {fmtLocalTime(findings.departure_utc)} · <span>times in</span> {localTimeZoneName()}
          </p>
        </div>
        <div className="flex flex-col md:flex-row md:items-start gap-x-5 gap-y-3">
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <VerdictChip state={state} large />
            {emulated && <span className="stamp-emulated">EMULATED WARNING SCENARIO</span>}
          </div>
          {/* an older check with nothing structured to quote: the chip label is the answer, no invented numbers */}
          {sentences.length === 0 && <h1 className="sr-only">{VERDICT[state]?.label}</h1>}
          {sentences.length > 0 && (
            <div className={clsx('min-w-0 max-w-[62ch]', warningActive && (emulated ? 'border-l-4 border-dashed border-ink/60 pl-3' : 'border-l-4 border-authority pl-3'))}>
              {/* one sentence: the governing reason; its support directly below, still stated once */}
              <h1 data-testid="verdict-sentence" className="font-story text-[22px] sm:text-[28px] leading-snug">{sentences[0]}</h1>
              {sentences.length > 1 && (
                <p data-testid="verdict-detail" className="font-story text-[16px] sm:text-[18px] leading-snug mt-1.5">
                  {sentences.slice(1).map((sentence, i) => (
                    <span key={i}>{i > 0 && ' '}<span>{sentence}</span></span>
                  ))}
                </p>
              )}
            </div>
          )}
        </div>
        {missingHours > 0 && (
          <p data-testid="missing-hours" className="font-sans text-[14px] max-w-[72ch]">
            {`A forecast value one of your limits needs is missing for ${missingHours} h of your arrival range: this check cannot say whether those hours stay inside your limits.`}
          </p>
        )}
        <p className="font-sans text-[14px] text-ink-soft max-w-[72ch]">
          {warningActive
            ? (
              <span>
                {emulated
                  ? 'A synthetic warning scenario covers part of your route. It tests the workflow and must not inform a real passage decision.'
                  : 'Read the official bulletin before anything else.'}
              </span>
            )
            : <span>{state === 'within' && missingHours > 0 ? WITHIN_PARTIAL_STEP : NEXT_STEP[state]}</span>}
          {/* models disagree: the action is the next run, so it is stated right here */}
          {state === 'insufficient' && <>{' '}<span data-testid="next-run" aria-live="polite">{nextRun.text}</span></>}
        </p>
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
          {warningActive && (
            <button type="button" onClick={onOpenBulletin} className={buttonClass}>
              {example ? 'Inspect example bulletin' : emulated ? 'Inspect emulated bulletin' : 'Open official bulletin'}
            </button>
          )}
          {!example && findings.identity_version === 2 && route && <button type="button" onClick={() => continuePassage()} className={buttonClass}>Revise this passage</button>}
          {offerScan && (
            <button type="button" onClick={() => continuePassage(true)} className={buttonClass}>
              Find a departure that fits
            </button>
          )}
          {emulated && warningEvidence && (
            <EvidenceLink evidenceId={warningEvidence.evidence_id} title={warningEvidence.evidence_id} className="inline-flex items-center min-h-11 px-1 text-[14px]">evidence</EvidenceLink>
          )}
          <ShareAnalysisButton onNavigate={setPage} className="font-instrument text-sm text-event underline underline-offset-4 min-h-11 disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline" />
          {state !== 'insufficient' && (
            <span className="font-mono text-[12px] text-ink-soft sm:ml-auto" data-testid="next-run" aria-live="polite">{nextRun.text}</span>
          )}
        </div>
      </div>
    </section>
  );
}
