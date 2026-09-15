import clsx from 'clsx';
import { EvidenceLink } from '../../components/common.jsx';
import { isEmulatedWarning } from '../../components/BulletinPanel.jsx';
import { capitalize, fmtTime, toLocalDateTimeValue, hazardNoun, placeLabel, plainEventNoun, scenarioShare, VERDICT } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { usePlanner } from '../../stores/plannerStore.js';
import { legPlace } from './routeLabels.jsx';

/** the plain-language layer: what each verdict state means for what you DO next (labels stay exact) */
const NEXT_STEP = {
  within:
    'The forecast stays inside the limits you set. Check the latest run once more before you leave.',
  approaching:
    'It is close to your limits. Read the two or three points on the right before deciding.',
  exceeds:
    'This forecast crosses your limits. Compare departure times before changing the route.',
  insufficient:
    'The models disagree near your limits. Wait for the next update before deciding.',
  warning_active:
    'A marine warning covers your area. Read the official bulletin first.',
};

/**
 * The 10-second layer: can I go, why, what to do instead; before any chart.
 * One plain sentence, one limit, no decimals, no codenames.
 */
export default function DecisionBand({ findings, synoptic, warningEvidence, onOpenBulletin, example }) {
  const setPage = useApp((s) => s.setPage);
  const route = useApp((s) => s.route);
  const warnings = useApp((s) => s.warnings);
  const warningActive = findings.verdict.warning_override?.active;
  const emulated = warningActive && isEmulatedWarning(warningEvidence, warnings);
  const state = warningActive ? 'warning_active' : findings.verdict.state;
  const verdict = VERDICT[state];
  const event = findings.causal_events?.[0];
  const driver = findings.evidence.find(
    (e) => e.evidence_id === findings.verdict.driver_evidence_id,
  );

  // one plain cause sentence; a single limit, whole numbers only
  let cause = null;
  if (warningActive) {
    cause = emulated
      ? 'A synthetic warning scenario covers part of your route. It tests the workflow and must not inform a real passage decision.'
      : 'An official marine warning covers part of your route. Read the bulletin before anything else.';
  } else if (driver && (state === 'exceeds' || state === 'approaching')) {
    const prefix = event ? `${capitalize(plainEventNoun(event, synoptic))} crosses your route. ` : '';
    const where = legPlace(findings, driver.leg_id);
    if (driver.member_fraction) {
      const clause = `${scenarioShare(driver.member_fraction)} ${hazardNoun(driver.rule_id)} over your ${driver.limit} kt limit ${where}`;
      cause = `${prefix}${prefix ? clause : capitalize(clause)}.`;
    } else if (typeof driver.value === 'number') {
      const relation = driver.value > driver.limit ? 'over' : 'close to';
      const clause = `${hazardNoun(driver.rule_id)} reach ${Math.round(driver.value)} ${driver.units ?? 'kt'} ${where}, ${relation} your ${driver.limit} ${driver.units ?? 'kt'} limit`;
      cause = `${prefix}${prefix ? clause : capitalize(clause)}.`;
    }
  }

  // when to look again; same source as the story-card bullet
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

  const buttonClass = emulated
    ? 'border border-ink/50 px-3.5 py-2 min-h-11 font-sans text-[14px] hover:bg-ink/5'
    : 'border border-white/70 px-3.5 py-2 min-h-11 font-sans text-[14px] hover:bg-white/10';

  return (
    <section
      aria-label="Decision"
      data-testid="decision-band"
      className={emulated ? 'bg-shoal text-ink border-y border-ink/30' : 'text-white'}
      style={emulated ? undefined : { backgroundColor: verdict.hex }}
    >
      <div className="px-6 py-5 max-w-[1600px] mx-auto flex flex-col gap-2.5">
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
          <span className="text-3xl sm:text-4xl leading-none" aria-hidden>
            {verdict.glyph}
          </span>
          <h1 className="font-chart text-[30px] sm:text-[38px] leading-none tracking-wide">
            {verdict.label.split(': ')[0]}
          </h1>
          {emulated && <span className="stamp-emulated">EMULATED WARNING SCENARIO</span>}
        </div>
        {cause && (
          <p className="font-story text-[18px] sm:text-[20px] leading-snug max-w-[72ch]">
            {placeLabel(cause)}
          </p>
        )}
        <p className={clsx('font-sans text-[14px] max-w-[72ch]', emulated ? 'text-ink-soft' : 'opacity-90')}>
          {NEXT_STEP[state]}
        </p>
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap pt-0.5">
          {offerScan && (
            <button type="button" onClick={findDeparture} className={buttonClass}>
              Find a departure that fits
            </button>
          )}
          {warningActive && (
            <button type="button" onClick={onOpenBulletin} className={buttonClass}>
              {example ? 'Inspect example bulletin' : emulated ? 'Inspect emulated bulletin' : 'Open official bulletin'}
            </button>
          )}
          {emulated && warningEvidence && (
            <EvidenceLink evidenceId={warningEvidence.evidence_id}>evidence</EvidenceLink>
          )}
          {nextUpdate && (
            <span className={clsx('font-mono text-[12px] sm:ml-auto', emulated ? 'text-ink-soft' : 'opacity-85')}>
              next forecast ~{nextUpdate} UTC · recheck before departure
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
