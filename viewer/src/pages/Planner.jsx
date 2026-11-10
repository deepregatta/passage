import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import BoatPicker from '../components/BoatPicker.jsx';
import { fmtLocalTime, toLocalDateTimeValue } from '../lib/format.js';
import DepartureComparison from './planner/DepartureComparison.jsx';
import ActionBar from './planner/ActionBar.jsx';
import ActionStatus from './planner/ActionStatus.jsx';
import DepartureField from './planner/DepartureField.jsx';
import PlannerMap from './planner/PlannerMap.jsx';
import usePlannerController, { validSpeed } from './planner/usePlannerController.jsx';
import { ACTION, BUSY_BUTTON_LABEL, SOURCE, barStatus, mapHint, revealElement } from './planner/plannerFeedback.js';
import { gribRouteArea, gribRoutePoints } from '../lib/gribExport.js';
import { useApp } from '../stores/appStore.js';
import { useGrib } from '../stores/gribStore.js';

// Computing a route from the forecast and your boat is the primary way in.
const MODES = [
  ['compute', 'Compute a route'],
  ['draw', 'Draw my route'],
];

const SPEED_LABEL = { slow: 'Slow', nominal: 'Usual', fast: 'Fast' };

export default function Planner() {
  const {
    mode, waypoints, computed, endpoints, polarId, polarLabel, name, speeds,
    departureLocal, scan, patch, setMode, setWaypoints, setEndpoints, setComputed,
    setName, setSpeeds, setDepartureLocal, busy, activeAction, failure, notice, staleRoute,
    departureIssue, blocked, retryAction, clearDraft, undoClear, clearedNotice, seededFromCompute, fitNonce, fileRef,
    route, distance, speedsValid, passageHours, addWaypoint,
    runRouting, onGpx, runScan, run
  } = usePlannerController();
  // Every status below takes the same inputs; each one picks out its own action.
  const status = { activeAction, busy, failure, notice, onRetry: () => retryAction(failure?.kind), onSwitchToDraw: () => setMode('draw') };
  const running = (kind) => activeAction?.kind === kind && !activeAction.source;
  const computeBlocked = blocked(ACTION.compute);
  const checkBlocked = blocked(ACTION.check);
  const setPage = useApp((state) => state.setPage);
  const chartArea = useApp((state) => state.plannerArea);
  const openGrib = () => {
    // A route hands its area (± the route margin) to the GRIB page; without one, the sailor draws a box there.
    const points = gribRoutePoints({ mode, waypoints, computed, endpoints });
    if (points) useGrib.getState().showArea(gribRouteArea(points));
    setPage('grib');
  };
  const canCheck = checkBlocked === null && busy === null;
  // The scan button is disabled for the same reasons as Check, except that a departure
  // problem is already stated by the departure field right above it.
  const scanBlocked = departureIssue ? null : checkBlocked;
  const formRef = useRef(null);
  const comparisonHeadingRef = useRef(null);
  const showComparison = () => revealElement(comparisonHeadingRef.current);
  // When a comparison finishes, bring it into view: it opens far below the form.
  const previousAction = useRef(null);
  useEffect(() => {
    if (previousAction.current === ACTION.scan && !activeAction && scan) revealElement(comparisonHeadingRef.current);
    previousAction.current = activeAction?.kind ?? null;
  });
  // On a phone the primary action follows the sailor down the form.
  const primary = mode === 'compute' && !computed ? ACTION.compute : ACTION.check;
  const scanning = activeAction?.kind === ACTION.scan;
  const bar = {
    label: scanning ? BUSY_BUTTON_LABEL.scan
      : activeAction?.kind === primary ? BUSY_BUTTON_LABEL[primary]
      : primary === ACTION.compute ? 'Compute route' : 'Check this passage',
    disabled: busy !== null || (primary === ACTION.compute ? computeBlocked !== null : !canCheck),
    onClick: primary === ACTION.compute ? runRouting : () => run(),
    failed: Boolean(failure),
    status: barStatus({
      failure, busy, blocked: primary === ACTION.compute ? computeBlocked : checkBlocked, mode, computed, waypoints, distance,
    }),
  };
  const undo = () => (mode === 'draw' ? setWaypoints((w) => w.slice(0, -1)) : setEndpoints((e) => e.slice(0, -1)));

  return (
    <div className="px-3 sm:px-5 py-4 max-w-[1600px]">
      <a
        href="#plan-form"
        onClick={(event) => {
          // The fragment belongs to the application router, not in-page navigation.
          event.preventDefault();
          formRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only fixed left-3 top-3 z-[100] bg-paper border border-ink px-3 py-2"
      >
        Skip to the route form
      </a>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        <PlannerMap
          mode={mode}
          waypoints={waypoints}
          computed={computed}
          endpoints={endpoints}
          fitNonce={fitNonce}
          chartArea={chartArea}
          addWaypoint={addWaypoint}
          setWaypoints={setWaypoints}
        >
          <button
            type="button"
            onClick={openGrib}
            className="absolute right-3 top-3 z-[800] min-h-11 flex items-center gap-2 bg-paper/95 border border-ink/40 rounded-sm px-3 font-instrument text-sm shadow-panel hover:bg-paper"
          >
            <svg aria-hidden width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v8M3.5 5.5L7 9l3.5-3.5M2 12h10" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            Export GRIB for this area
          </button>
          <p
            aria-live="polite"
            className="absolute left-3 bottom-7 z-[800] max-w-[calc(100%-1.5rem)] bg-paper/95 border border-ink/40 rounded-sm px-2 py-1 text-[12px] shadow-panel pointer-events-none"
          >
            {mapHint({ mode, endpoints, waypoints, computed, distance })}
          </p>
        </PlannerMap>

        <section ref={formRef} tabIndex={-1} className="bg-white/40 border hairline rounded-sm shadow-panel p-4 sm:p-5 font-sans text-sm focus:outline-hidden" aria-labelledby="plan-title">
          <h1 id="plan-title" className="font-chart text-3xl">Plan a passage</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            Check a planned passage against the forecast and your boat’s limits: an explainable verdict, with the uncertainty shown.
          </p>
          <button type="button" onClick={() => setPage('example')} className="min-h-11 text-event underline underline-offset-4 text-left">
            See an example briefing
          </button>

          <Step n={1} title="Route">
            <div className="grid grid-cols-2 border border-ink/40 rounded-sm overflow-hidden" role="tablist" aria-label="Route mode">
              {MODES.map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx('min-h-11 px-2 text-[14px]', mode === m ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink hover:bg-white/50')}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'compute' ? (
              <p className="text-[12px] text-ink-soft">
                Mark a start and finish on the chart. Passage uses the forecast, available
                currents and your boat polar to find a route.
              </p>
            ) : (
              <p className="text-[12px] text-ink-soft">Add waypoints on the chart (drag to adjust).</p>
            )}
            <label className="flex items-center gap-2">
              <span className="eyebrow shrink-0">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 min-h-11 bg-white/60 border hairline rounded-sm px-2 py-2 text-base sm:text-sm"
              />
            </label>

            <div className="flex items-center justify-between gap-2">
              <span>
                {mode === 'draw' ? `${waypoints.length} waypoints` : `${endpoints.length}/2 endpoints`}
                {mode === 'draw' && distance !== null && (
                  <>
                    {' · '}
                    <span className="font-mono">{distance} nm</span>
                    {passageHours !== null && <>{' · ~'}<span className="font-mono">{passageHours} h</span></>}
                  </>
                )}
              </span>
              <span className="flex gap-3 text-ink-soft">
                {mode === 'draw' && (
                  <>
                    <button type="button" onClick={() => fileRef.current?.click()} className="underline hover:text-ink min-h-11">
                      Import GPX…
                    </button>
                    <input ref={fileRef} type="file" accept=".gpx" onChange={onGpx} className="hidden" />
                  </>
                )}
                <button type="button" onClick={undo} className="underline hover:text-ink min-h-11 min-w-11 px-2">undo</button>
                <button type="button" onClick={clearDraft} className="underline hover:text-ink min-h-11 min-w-11 px-2">clear</button>
              </span>
            </div>
            <div aria-live="polite" className="space-y-1 empty:hidden">
              {clearedNotice && (
                <p className="text-[13px] flex flex-wrap items-center gap-x-3">
                  <span>Route cleared</span>
                  <button type="button" onClick={undoClear} className="underline text-event min-h-11 px-1">Undo clear</button>
                </p>
              )}
              {seededFromCompute && (
                <p className="text-[13px] border-l-2 border-ink/50 pl-2">
                  Started from your Compute start and finish; new points are added after the finish. Clear to begin again.
                </p>
              )}
            </div>
            {mode === 'draw' && <ActionStatus kind={ACTION.gpx} {...status} />}

            {mode === 'compute' && (
              <>
                <button
                  type="button"
                  onClick={runRouting}
                  disabled={computeBlocked !== null || busy !== null}
                  className="w-full min-h-11 border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
                >
                  {running(ACTION.compute) ? BUSY_BUTTON_LABEL.compute : 'Compute route'}
                </button>
                <ActionStatus kind={ACTION.compute} {...status} />
                <div aria-live="polite" className="space-y-1 empty:hidden">
                  {busy === null && computeBlocked && <p className="text-[13px] text-ink-soft">{computeBlocked}</p>}
                  {staleRoute && <p className="text-[13px] border-l-2 border-ink/50 pl-2">{staleRoute}</p>}
                </div>
                {computed && (
                  <p className="text-[13px]">
                    <span className="font-mono">{computed.distance_nm} nm</span> ·{' '}
                    <span className="font-mono">{computed.duration_h} h</span> · arrives{' '}
                    <span className="font-mono">{fmtLocalTime(computed.arrival_utc)}</span> local time · avg{' '}
                    <span className="font-mono">{computed.avg_sog_kt} kt</span>
                    <span className="block text-[12px] text-ink-soft mt-0.5">
                      Weather-routed · includes polar uncertainty · ready to check
                    </span>
                  </p>
                )}
                {computed?.notes?.length > 0 && (
                  <p className="text-[12px] text-ink-soft">{computed.notes.join(' ')}</p>
                )}
              </>
            )}
          </Step>

          <Step n={2} title="Boat">
            {mode === 'compute' ? (
              <BoatPicker
                polarId={polarId}
                polarLabel={polarLabel}
                onSelect={(entry) => patch({ polarId: entry.polar_id, polarLabel: entry.label })}
              />
            ) : (
              <div>
                <span className="eyebrow block mb-1">Speed (kt) · slow / usual / fast</span>
                <div className="flex gap-2">
                  {['slow', 'nominal', 'fast'].map((k) => (
                    <label key={k} className="block flex-1 min-w-0">
                      <span className="block text-[12px] text-ink-soft mb-0.5">{SPEED_LABEL[k]}</span>
                      <input
                        type="number"
                        step="0.5"
                        value={speeds[k]}
                        onChange={(e) => setSpeeds({ ...speeds, [k]: e.target.value === '' ? '' : Number(e.target.value) })}
                        aria-invalid={!validSpeed(speeds[k])}
                        className="w-full min-h-11 bg-white/60 border hairline rounded-sm px-2 py-2 text-base sm:text-sm font-mono aria-[invalid=true]:border-verdict-exceeds"
                        aria-label={`${k} speed`}
                      />
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[12px] text-ink-soft">
                  Draw mode uses these speeds instead of a boat polar; the check shows how the passage time changes between them.
                </p>
              </div>
            )}
          </Step>

          <Step n={3} title="Departure">
            <DepartureField value={departureLocal} onChange={setDepartureLocal} issue={departureIssue} />
            <button
              type="button"
              onClick={runScan}
              disabled={checkBlocked !== null || busy !== null}
              className="text-left text-event underline underline-offset-4 min-h-11 disabled:opacity-40 disabled:no-underline"
            >
              {running(ACTION.scan) ? BUSY_BUTTON_LABEL.scan : 'Compare departure times (next 5 days)'}
            </button>
            <ActionStatus kind={ACTION.scan} {...status} />
            <div aria-live="polite" className="empty:hidden">
              {busy === null && scanBlocked && <p className="text-[13px] text-ink-soft">{scanBlocked}</p>}
              {scan && scan.candidates.length > 0 && (
                <p className="text-[12px] text-ink-soft">
                  Departure comparison ready. Choose a time below the chart.{' '}
                  <button type="button" onClick={showComparison} className="underline text-event min-h-11">Show the comparison</button>
                </p>
              )}
            </div>
            {scan?.notes?.length > 0 && (
              <p className="text-[12px] text-ink-soft">{scan.notes.join(' ')}</p>
            )}
          </Step>

          <div className="border-t hairline pt-4 space-y-2">
            <button
              type="button"
              onClick={() => run()}
              disabled={!canCheck}
              className="w-full min-h-12 bg-ink text-paper font-medium text-[15px] rounded-sm px-3 py-2.5 hover:bg-ink-deep disabled:opacity-40"
            >
              {running(ACTION.check) ? BUSY_BUTTON_LABEL.check : 'Check this passage'}
            </button>
            <ActionStatus kind={ACTION.check} {...status} />
            <div aria-live="polite" className="empty:hidden">
              {busy === null && checkBlocked && <p className="text-[13px] text-ink-soft">{checkBlocked}</p>}
            </div>
            <p className="text-[12px] text-ink-soft">Runs in your browser with live forecasts. Each check is saved to My passages.</p>
          </div>
        </section>
      </div>

      {scan && (
        <DepartureComparison
          scan={scan}
          departureLocal={departureLocal}
          busy={busy}
          disabled={!route || !speedsValid}
          headingRef={comparisonHeadingRef}
          onPick={(candidate) => {
            if (busy !== null || !speedsValid) return;
            setDepartureLocal(toLocalDateTimeValue(candidate.departure_utc));
            const rerouted = scan.routes?.[candidate.departure_utc];
            if (rerouted) setComputed(rerouted);
            // go straight to the briefing for the time just picked
            run({ departureUtc: candidate.departure_utc, route: rerouted?.route ?? route, source: SOURCE.comparison });
          }}
        >
          <ActionStatus kind={ACTION.check} source={SOURCE.comparison} {...status} />
        </DepartureComparison>
      )}
      <ActionBar {...bar} />
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <fieldset className="border-t hairline mt-4 pt-4 first-of-type:mt-3">
      <legend className="sr-only">{title}</legend>
      <div className="flex items-center gap-2.5 mb-3" aria-hidden>
        <span className="w-6 h-6 grid place-items-center border border-ink/50 font-chart text-[13px]">{n}</span>
        <span className="eyebrow">{title}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}
