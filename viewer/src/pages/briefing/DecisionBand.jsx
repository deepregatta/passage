import clsx from 'clsx';
import { EvidenceLink, VerdictChip } from '../../components/common.jsx';
import { isEmulatedWarning } from '../../components/BulletinPanel.jsx';
import { ShareAnalysisButton } from '../../components/FooterActions.jsx';
import { fmtLocalTime, fmtTime, localTimeZoneName, toLocalDateTimeValue, VERDICT } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { usePlanner } from '../../stores/plannerStore.js';
import { routeTitle } from './routeLabels.jsx';

/** the plain-language layer: what each verdict state means for what you DO next (labels stay exact) */
const NEXT_STEP = {
  within:
    'The forecast stays inside the limits you set. Check the latest run once more before you leave.',
  approaching:
    'It is close to your limits. Read the weather story below before deciding.',
  exceeds:
    'This forecast crosses your limits. Compare departure times before changing the route.',
  insufficient:
    'The models disagree near your limits. Wait for the next update before deciding.',
};

/**
 * The 10-second layer, before any chart: which passage, the verdict against your
 * limits, any official warning, and what to do next. The why lives in the weather
 * story right below; the verdict appears here once.
 */
export default function DecisionBand({ findings, warningEvidence, onOpenBulletin, example }) {
  const setPage = useApp((s) => s.setPage);
  const route = useApp((s) => s.route);
  const warnings = useApp((s) => s.warnings);
  const warningActive = findings.verdict.warning_override?.active;
  const emulated = warningActive && isEmulatedWarning(warningEvidence, warnings);
  const state = warningActive ? 'warning_active' : findings.verdict.state;
  // An official warning is a separate decision; the pill stays about your limits.
  const personalState = warningActive ? recomputePersonalState(findings) : findings.verdict.state;

  // when to look again; the single place the briefing states it
  const nextRun = useApp((s) => s.briefing?.next_run ?? s.briefing?.next_runs?.[0]);
  const nextUpdate = nextRun ? fmtTime(nextRun.expected_at) : null;

  const offerScan = !example && ['exceeds', 'approaching', 'warning_active'].includes(state) && route;
  const findDeparture = () => {
    usePlanner.getState().patch({
      mode: 'draw',
      name: route.name ?? findings.route_id,
      waypoints: route.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lon })),
      speeds: route.speeds_kt ? { ...route.speeds_kt } : usePlanner.getState().speeds,
      departureLocal: toLocalDateTimeValue(findings.departure_utc),
      computed: null,
      scan: null,
      autoScan: true,
    });
    setPage('planner');
  };

  const buttonClass = 'border border-ink/50 bg-paper/60 px-3.5 py-2 min-h-11 font-sans text-[14px] hover:bg-paper';

  return (
    <section aria-label="Decision" data-testid="decision-band" className="bg-shoal/70 border-b border-ink/30">
      <div className="px-4 sm:px-6 py-5 max-w-[1600px] mx-auto flex flex-col gap-3">
        <div className="flex items-start justify-between gap-x-6 gap-y-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="font-chart text-[30px] sm:text-[40px] leading-tight">{routeTitle(findings)}</h1>
            <p className="font-mono text-[12px] text-ink-soft mt-1">
              <span>dep</span> {fmtLocalTime(findings.departure_utc)} · <span>times in</span> {localTimeZoneName()}
            </p>
          </div>
          <VerdictChip state={personalState} large />
        </div>
        {warningActive && (
          <div className={clsx('border-l-4 pl-3 py-1 flex flex-col gap-1.5', emulated ? 'border-dashed border-ink/60' : 'border-authority')}>
            <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
              <span className="text-2xl leading-none" aria-hidden>{VERDICT.warning_active.glyph}</span>
              <h2 className={clsx('font-chart text-[24px] sm:text-[28px] leading-none', !emulated && 'text-authority')}>
                {VERDICT.warning_active.label}
              </h2>
              {emulated && <span className="stamp-emulated">EMULATED WARNING SCENARIO</span>}
            </div>
            <p className="font-story text-[17px] sm:text-[19px] leading-snug max-w-[72ch]">
              {emulated
                ? 'A synthetic warning scenario covers part of your route. It tests the workflow and must not inform a real passage decision.'
                : 'An official marine warning covers part of your route. Read the bulletin before anything else.'}
            </p>
          </div>
        )}
        {!warningActive && <p className="font-sans text-[14px] text-ink-soft max-w-[72ch]">{NEXT_STEP[state]}</p>}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
          {warningActive && (
            <button type="button" onClick={onOpenBulletin} className={buttonClass}>
              {example ? 'Inspect example bulletin' : emulated ? 'Inspect emulated bulletin' : 'Open official bulletin'}
            </button>
          )}
          {offerScan && (
            <button type="button" onClick={findDeparture} className={buttonClass}>
              Find a departure that fits
            </button>
          )}
          {emulated && warningEvidence && (
            <EvidenceLink evidenceId={warningEvidence.evidence_id}>evidence</EvidenceLink>
          )}
          <ShareAnalysisButton onNavigate={setPage} className="font-instrument text-sm text-event underline underline-offset-4 min-h-11 disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline" />
          <span className="font-mono text-[12px] text-ink-soft sm:ml-auto">
            {nextUpdate
              ? <>next forecast ~{nextUpdate} UTC · recheck before departure</>
              : 'Next forecast update time unavailable. Check the published forecast before departure.'}
          </span>
        </div>
      </div>
    </section>
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
