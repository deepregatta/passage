import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import ModelsUsed from '../components/ModelsUsed.jsx';
import { Panel } from '../components/common.jsx';
import BoatPicker from '../components/BoatPicker.jsx';
import { fmtLocalTime, toLocalDateTimeValue } from '../lib/format.js';
import DepartureComparison from './planner/DepartureComparison.jsx';
import DepartureField from './planner/DepartureField.jsx';
import GribExport from './planner/GribExport.jsx';
import PlannerMap from './planner/PlannerMap.jsx';
import usePlannerController, { validSpeed } from './planner/usePlannerController.jsx';
import { GRIB_MARGIN_DEFAULT_DEG, gribBbox, gribEtaHours, gribRoutePoints } from '../lib/gribExport.js';

export default function Planner() {
  const {
    mode, waypoints, computed, endpoints, polarId, polarLabel, name, speeds,
    departureLocal, scan, patch, setMode, setWaypoints, setEndpoints, setComputed,
    setName, setSpeeds, setDepartureLocal, busy, error, fitNonce, fileRef,
    route, distance, speedsValid, passageHours, departureUtc, addWaypoint,
    runRouting, onGpx, runScan, run
  } = usePlannerController();
  const [gribOpen, setGribOpen] = useState(false);
  const [gribNonce, setGribNonce] = useState(0);
  const [gribMargin, setGribMargin] = useState(GRIB_MARGIN_DEFAULT_DEG);
  const gribPoints = useMemo(
    () => gribRoutePoints({ mode, waypoints, computed, endpoints }),
    [mode, waypoints, computed, endpoints],
  );
  const gribArea = useMemo(() => gribBbox(gribPoints, gribMargin), [gribPoints, gribMargin]);
  const gribShown = gribOpen && gribArea !== null;
  useEffect(() => {
    // Clearing the route closes the section; a new route starts closed.
    if (!gribPoints) setGribOpen(false);
  }, [gribPoints]);

  return (
    <div className="px-6 py-5 max-w-[1600px]">
      <h1 className="font-chart text-3xl mb-1">Plan a passage</h1>
      <p className="font-sans text-sm text-ink-soft mb-4">
        Click the chart to drop waypoints (drag to adjust), or import a GPX file. The analysis
        runs right here in your browser.
      </p>
      <aside className="mb-5 border-l-4 border-ink bg-white/40 px-4 py-3">
        <a href="#example" className="inline-flex min-h-11 items-center bg-ink text-paper px-4 py-2 font-instrument text-sm rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          See an example briefing
        </a>
        <p className="mt-2 text-sm text-ink-soft">Free · no signup · no route setup</p>
        <p className="mt-1 text-sm text-ink-soft">Synthetic / emulated example. Not a live forecast or a safety decision.</p>
      </aside>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PlannerMap
          mode={mode}
          waypoints={waypoints}
          computed={computed}
          endpoints={endpoints}
          fitNonce={fitNonce}
          addWaypoint={addWaypoint}
          setWaypoints={setWaypoints}
          exportBbox={gribShown ? gribArea : null}
        />

        <Panel title="Passage">
          <div className="space-y-3 font-sans text-sm">
            <div className="flex gap-1.5" role="tablist" aria-label="Route mode">
              {[
                ['draw', 'Draw my route'],
                ['compute', 'Compute a route'],
              ].map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    'px-2.5 py-1 border rounded-sm text-[13px]',
                    mode === m ? 'bg-ink text-paper border-ink' : 'border-line text-ink-soft hover:border-ink-soft',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'draw' && (
              <label className="block">
                <span className="eyebrow block mb-1">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5"
                />
              </label>
            )}

            {mode === 'draw' && (
              <div>
                <span className="eyebrow block mb-1">Boat speed (kt) · slow / usual / fast</span>
                <div className="flex gap-2">
                  {['slow', 'nominal', 'fast'].map((k) => (
                    <input
                      key={k}
                      type="number"
                      step="0.5"
                      value={speeds[k]}
                      onChange={(e) => setSpeeds({ ...speeds, [k]: e.target.value === '' ? '' : Number(e.target.value) })}
                      aria-invalid={!validSpeed(speeds[k])}
                      className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono aria-[invalid=true]:border-verdict-exceeds"
                      aria-label={`${k} speed`}
                    />
                  ))}
                </div>
              </div>
            )}

            {mode === 'compute' && (
              <>
                <BoatPicker
                  polarId={polarId}
                  polarLabel={polarLabel}
                  onSelect={(entry) => patch({ polarId: entry.polar_id, polarLabel: entry.label })}
                />
                <p className="text-[12px] text-ink-soft">
                  Mark a start and finish on the chart. Passage uses the forecast, available
                  currents and your boat polar to find a route.
                </p>
                <button
                  type="button"
                  onClick={runRouting}
                  disabled={endpoints.length !== 2 || !polarId || !departureUtc || busy !== null}
                  className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
                >
                  Compute route
                </button>
                {computed && (
                  <p className="text-[13px]">
                    <span className="font-mono">{computed.distance_nm} nm</span> ·{' '}
                    <span className="font-mono">{computed.duration_h} h</span> · arrives{' '}
                    <span className="font-mono">{fmtLocalTime(computed.arrival_utc)}</span> local time · avg{' '}
                    <span className="font-mono">{computed.avg_sog_kt} kt</span>
                    <span className="block text-[11px] text-ink-soft mt-0.5">
                      Weather-routed · includes polar uncertainty · ready to check
                    </span>
                  </p>
                )}
                {computed?.notes?.length > 0 && (
                  <p className="text-[11px] text-ink-soft -mt-1">{computed.notes.join(' ')}</p>
                )}
              </>
            )}

            <DepartureField value={departureLocal} onChange={setDepartureLocal} />

            <div className="flex items-center justify-between border-t hairline pt-3">
              <span className="text-ink-soft">
                {mode === 'draw' ? `${waypoints.length} waypoints` : `${endpoints.length}/2 endpoints`}
                {mode === 'draw' && distance !== null && (
                  <>
                    {' · '}
                    <span className="font-mono">{distance} nm</span>
                    {passageHours !== null && <>{' · ~'}<span className="font-mono">{passageHours} h</span></>}
                  </>
                )}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    mode === 'draw' ? setWaypoints((w) => w.slice(0, -1)) : setEndpoints((e) => e.slice(0, -1))
                  }
                  className="underline text-ink-soft hover:text-ink"
                >
                  undo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWaypoints([]);
                    setEndpoints([]);
                    setComputed(null);
                  }}
                  className="underline text-ink-soft hover:text-ink"
                >
                  clear
                </button>
              </span>
            </div>

            {mode === 'draw' && (
              <div className="flex gap-2 items-center">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="border border-ink/40 rounded-sm px-3 py-1.5 hover:bg-white/50"
                >
                  Import GPX…
                </button>
                <input ref={fileRef} type="file" accept=".gpx" onChange={onGpx} className="hidden" />
              </div>
            )}

            <button
              type="button"
              onClick={() => run()}
              disabled={!route || !departureUtc || !speedsValid || busy !== null}
              className="w-full bg-ink text-paper font-medium rounded-sm px-3 py-2.5 hover:bg-ink-deep disabled:opacity-40"
            >
              {busy ? `${busy}…` : 'Check this passage against my limits'}
            </button>
            {!route && busy === null && (
              <p className="text-[13px] text-ink-soft">
                {mode === 'draw'
                  ? 'Mark at least two points on the chart: your start and destination.'
                  : 'Mark a start and finish on the chart.'}
              </p>
            )}
            {route && busy === null && (
              <p className="text-[13px] text-ink-soft">
                Checking runs the analysis and saves the briefing to My briefings. Until then
                your draft stays here on this page.
              </p>
            )}
            <button
              type="button"
              onClick={runScan}
              disabled={!route || !departureUtc || !speedsValid || busy !== null}
              className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
            >
              Compare departure times (next 5 days)
            </button>
            <button
              type="button"
              onClick={() => {
                setGribOpen(true);
                setGribNonce((n) => n + 1);
              }}
              disabled={!gribPoints}
              className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
            >
              Download GRIBs…
            </button>
            {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
            {scan && scan.candidates.length > 0 && (
              <p className="text-[12px] text-ink-soft border-t hairline pt-2">
                Departure comparison ready. Choose a time below the chart.
              </p>
            )}
            {scan?.notes?.length > 0 && (
              <p className="text-[11px] text-ink-soft">{scan.notes.join(' ')}</p>
            )}
            <p className="text-[12px] text-ink-soft">
              Runs in your browser · forecasts fetched live · saved as an immutable snapshot.
            </p>
          </div>
        </Panel>
      </div>

      {scan && (
        <DepartureComparison
          scan={scan}
          departureLocal={departureLocal}
          busy={busy}
          disabled={!route || !speedsValid}
          onPick={(candidate) => {
            if (busy !== null || !speedsValid) return;
            setDepartureLocal(toLocalDateTimeValue(candidate.departure_utc));
            const rerouted = scan.routes?.[candidate.departure_utc];
            if (rerouted) setComputed(rerouted);
            // go straight to the briefing for the time just picked
            run({ departureUtc: candidate.departure_utc, route: rerouted?.route ?? route });
          }}
        />
      )}

      {gribShown && (
        <GribExport
          points={gribPoints}
          bbox={gribArea}
          margin={gribMargin}
          onMarginChange={setGribMargin}
          departureUtc={departureUtc}
          etaHours={gribEtaHours({ mode, distance, speeds, computed })}
          openNonce={gribNonce}
          onClose={() => setGribOpen(false)}
        />
      )}

      <ModelsUsed />
    </div>
  );
}
