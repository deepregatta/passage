import { useEffect, useMemo, useRef, useState } from 'react';
import { GRIB_EXPORT_NOTICE, FORECAST_UPDATED_MESSAGE, gribDataset } from '@deepweather/engine';
import { EmulatedStamp } from '../../components/common.jsx';
import { track } from '../../lib/analytics.js';
import { fmtTime } from '../../lib/format.js';
import { forecastStore, friendlyForecastError } from '../../lib/forecastStore.js';
import {
  GRIB_DEFAULT_DATASETS,
  GRIB_MARGIN_OPTIONS,
  GRIB_MAX_EST_BYTES,
  GRIB_STEPS,
  GRIB_TILES_ARE_FIXTURE,
  describeGribDataset,
  fmtGribArea,
  fmtGribBytes,
  fmtGribCoverage,
  fmtGribGrid,
  fmtGribSteps,
  fmtHorizonShort,
  fmtLatLon,
  fmtLonConvention,
  fmtTooLarge,
  fmtUtc,
  fmtUtcRange,
  gribEstimatedBytes,
  gribFilesWithUrls,
  gribLonConvention,
  gribSizeBucket,
  gribSpotKeys,
  gribWindow,
  loadGribManifests,
  planRouteGrib,
  revokeGribFiles,
  runRouteGrib,
  selectedGribPlan,
} from '../../lib/gribExport.js';

const HOUR_MS = 3_600_000;
// abort reason when the route or settings change under a running export
const SETTINGS_CHANGED = 'settings-changed';

const STEP_LABELS = { all: 'Every forecast step', 3: 'Every 3 h', 6: 'Every 6 h' };

const UNAVAILABLE = {
  'no-layer': 'Not in the current forecast runs.',
  'no-tiles': 'No data for this area.',
  'outside-horizon': 'Your dates are beyond this forecast’s range.',
};

const STAGE_LABELS = { tiles: 'Reading forecast tiles', encode: 'Writing GRIB files' };

const SPOT_LABELS = {
  wind_kt: 'Wind (kt)',
  wind_from_deg: 'From (°)',
  gust_kt: 'Gust (kt)',
  current_kt: 'Current (kt)',
  current_set_deg: 'Set, towards (°)',
  hs_m: 'Hs (m)',
  period_s: 'Period (s)',
  dir_deg: 'From (°)',
  wind_wave_h_m: 'Wind waves (m)',
  wind_wave_period_s: 'Wind-wave period (s)',
  wind_wave_dir_deg: 'Wind waves from (°)',
  swell_h_m: 'Swell (m)',
  swell_period_s: 'Swell period (s)',
  swell_dir_deg: 'Swell from (°)',
};

/** Everything the files depend on, so stale Save links are dropped when an input changes. */
function derive({ manifests, bbox, points, departureUtc, etaHours, nowMs, step, lonConvention, selected }) {
  const timeWindow = gribWindow({ departureUtc, etaHours, nowMs });
  const key = JSON.stringify([bbox, timeWindow, step, lonConvention, points[0], points[points.length - 1], [...selected].sort()]);
  if (!manifests) return { timeWindow, key, plan: null, planError: null };
  try {
    const plan = planRouteGrib(manifests, { bbox, window: timeWindow, step, lonConvention, points });
    return { timeWindow, key, plan, planError: null };
  } catch (error) {
    // e.g. a box across the antimeridian, which the export does not support
    return { timeWindow, key, plan: null, planError: error };
  }
}

function SpotValues({ file }) {
  const keys = gribSpotKeys(file);
  if (!file.checkpoints.length || !keys.length) return null;
  return (
    <div className="space-y-3">
      {file.checkpoints.map((point, index) => (
        <div key={index}>
          <p className="text-[12px]">
            <span className="font-medium">{index === 0 ? 'Start' : 'Finish'}</span>
            {' · '}<span className="font-mono">{fmtLatLon(point.lat, point.lon)}</span>
            {' · '}<span>grid point</span>{' '}<span className="font-mono">{fmtLatLon(point.grid_lat, point.grid_lon, 3)}</span>
          </p>
          <div className="overflow-x-auto">
            <table className="text-[12px] mt-1 border-collapse">
              <thead>
                <tr className="text-left text-ink-soft">
                  <th scope="col" className="pr-3 font-normal">Time (UTC)</th>
                  {keys.map((key) => <th key={key} scope="col" className="pr-3 font-normal">{SPOT_LABELS[key] ?? key}</th>)}
                </tr>
              </thead>
              <tbody className="font-mono">
                {point.steps.map((row) => (
                  <tr key={row.time}>
                    <td className="pr-3">{fmtTime(row.time)}</td>
                    {keys.map((key) => <td key={key} className="pr-3">{row.values[key] ?? '–'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function FileDetails({ file }) {
  const rows = [
    // identifiers sit in <code>, which the French DOM translator leaves alone
    ['Model', <code className="font-mono">{file.model}</code>],
    ['Forecast run', <code className="font-mono break-all">{file.run_id}</code>],
    ['Base time', <span className="font-mono">{fmtUtc(file.cycle)}</span>],
    ['Grid', <span className="font-mono">{fmtGribGrid(file.grid)}</span>],
    ['Area', <span className="font-mono">{fmtGribArea(file.grid)}</span>],
    ['Longitude convention', <span className="font-mono">{fmtLonConvention(file.grid.lon_convention)}</span>],
    ['GRIB messages', <span className="font-mono">{file.messages}</span>],
    ['Points with data', <span className="font-mono">{fmtGribCoverage(file.coverage)}</span>],
    ['Checksum (FNV-1a 64)', <code className="font-mono">{file.fnv64}</code>],
  ];
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[12px] text-ink-soft">File details</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-soft">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <dt className="text-ink-soft">Times (UTC)</dt>
        <dd className="font-mono max-h-24 overflow-y-auto">{file.times.map((time) => fmtTime(time)).join(', ')}</dd>
      </dl>
      <p className="eyebrow mt-3 mb-1">Spot values</p>
      <SpotValues file={file} />
    </details>
  );
}

/**
 * Download GRIBs: GRIB2 files of the pinned forecast runs for the route area,
 * built in the browser (docs/grib-export.md). Shown below the planner grid
 * while open; the map draws the same area as a dashed rectangle.
 */
export default function GribExport({ points, bbox, margin, onMarginChange, departureUtc, etaHours, openNonce, onClose }) {
  const sectionRef = useRef(null);
  const [manifestState, setManifestState] = useState({ status: 'loading', manifests: null, attempt: 0 });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [step, setStep] = useState('all');
  const [selected, setSelected] = useState(() => new Set(GRIB_DEFAULT_DATASETS));
  const [lonConvention, setLonConvention] = useState(() => gribLonConvention());
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // the running export and the settings key it was planned for
  const jobRef = useRef(null);
  const resultRef = useRef(null);
  const manifests = manifestState.manifests;

  useEffect(() => {
    let current = true;
    loadGribManifests(forecastStore()).then(
      (loaded) => current && setManifestState((s) => ({ ...s, status: 'ready', manifests: loaded })),
      (e) => {
        if (!current) return;
        friendlyForecastError(e);
        setManifestState((s) => ({ ...s, status: 'error', manifests: null }));
      },
    );
    return () => { current = false; };
  }, [manifestState.attempt]);

  useEffect(() => {
    // Each Download GRIBs… click refreshes "now" and brings the section into view.
    setNowMs(Date.now());
    sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [openNonce]);

  useEffect(() => {
    const sync = () => setLonConvention(gribLonConvention());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => () => {
    jobRef.current?.controller.abort(SETTINGS_CHANGED);
    revokeGribFiles(resultRef.current?.files);
  }, []);

  const { timeWindow, key, plan, planError } = useMemo(
    () => derive({ manifests, bbox, points, departureUtc, etaHours, nowMs, step, lonConvention, selected }),
    [manifests, bbox, points, departureUtc, etaHours, nowMs, step, lonConvention, selected],
  );

  const replaceResult = (next) => {
    revokeGribFiles(resultRef.current?.files);
    resultRef.current = next;
    setResult(next);
  };

  useEffect(() => {
    // The route or departure changed: files for the old settings (or still
    // being prepared for them) are not what the form now shows.
    if (jobRef.current && jobRef.current.key !== key) jobRef.current.controller.abort(SETTINGS_CHANGED);
    if (!jobRef.current) setError(null);
    if (resultRef.current && resultRef.current.key !== key) {
      revokeGribFiles(resultRef.current.files);
      resultRef.current = null;
      setResult(null);
    }
  }, [key]);

  const chosen = plan ? selectedGribPlan(plan, selected) : null;
  const estimate = chosen ? gribEstimatedBytes(chosen) : 0;
  const tooLarge = estimate > GRIB_MAX_EST_BYTES;
  const running = progress !== null;
  const attributions = [...new Set((plan?.datasets ?? [])
    .filter((dataset) => selected.has(dataset.datasetId))
    .map((dataset) => dataset.spec.attribution))];

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const prepare = async () => {
    // A new hour moves the window start; plan from the current hour.
    const now = Date.now();
    const fresh = Math.floor(now / HOUR_MS) !== Math.floor(nowMs / HOUR_MS)
      ? derive({ manifests, bbox, points, departureUtc, etaHours, nowMs: now, step, lonConvention, selected })
      : { key, plan };
    if (fresh.key !== key) setNowMs(now);
    if (!fresh.plan) return;
    const runPlan = selectedGribPlan(fresh.plan, selected);
    if (!runPlan.datasets.length || gribEstimatedBytes(runPlan) > GRIB_MAX_EST_BYTES) return;
    const controller = new AbortController();
    const job = { controller, key: fresh.key };
    jobRef.current = job;
    replaceResult(null);
    setError(null);
    setProgress({ datasetId: runPlan.datasets[0].datasetId, stage: 'tiles', done: 0, total: 1 });
    try {
      const files = await runRouteGrib(forecastStore(), runPlan, { signal: controller.signal, onProgress: setProgress });
      controller.signal.throwIfAborted();
      replaceResult({ key: fresh.key, files: gribFilesWithUrls(files) });
      track('grib_export', {
        datasets: files.map((file) => file.datasetId).join(','),
        size_bucket: gribSizeBucket(files.reduce((sum, file) => sum + file.bytes, 0)),
      });
    } catch (e) {
      if (controller.signal.aborted) {
        if (controller.signal.reason !== SETTINGS_CHANGED) setError('Cancelled. No files were prepared.');
      } else if (e?.code === 'forecast-updated') setError(FORECAST_UPDATED_MESSAGE);
      else setError(friendlyForecastError(e).message);
    } finally {
      if (jobRef.current === job) {
        jobRef.current = null;
        setProgress(null);
      }
    }
  };

  return (
    <section ref={sectionRef} className="mt-6 border-t border-ink/40 pt-3 scroll-mt-4" aria-label="GRIB download">
      <div className="flex justify-between items-baseline flex-wrap gap-2">
        <h2 className="font-instrument font-semibold uppercase tracking-wider">Download GRIBs</h2>
        <button type="button" onClick={onClose} className="font-sans text-sm underline text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
      <div className="font-sans text-sm mt-2 space-y-3 max-w-[90ch]">
        <p className="text-ink-soft">
          GRIB2 files of the forecast for your route area, built in your browser from the same forecast
          runs as your briefings. For GRIB viewers and routing software such as Adrena, OpenCPN, qtVlm or XyGrib.
        </p>
        {GRIB_TILES_ARE_FIXTURE && (
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <EmulatedStamp /><span>Local test tiles, not the live forecast.</span>
          </p>
        )}
        {lonConvention === 'signed' && (
          <p className="text-[13px] text-ink-soft">Longitude test setting: −180 to 180° (signed).</p>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
          <label className="block">
            <span className="eyebrow block mb-1">Margin around the route</span>
            <select
              value={margin}
              onChange={(e) => onMarginChange(Number(e.target.value))}
              disabled={running}
              className="bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono"
            >
              {GRIB_MARGIN_OPTIONS.map((value) => <option key={value} value={value}>{`${value}°`}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow block mb-1">Time step</span>
            <select
              value={String(step)}
              onChange={(e) => setStep(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              disabled={running}
              className="bg-white/60 border hairline rounded-sm px-2 py-1.5"
            >
              {GRIB_STEPS.map((value) => <option key={value} value={String(value)}>{STEP_LABELS[value]}</option>)}
            </select>
          </label>
          <div>
            <span className="eyebrow block mb-1">Window</span>
            <span className="font-mono text-[13px]">{fmtUtcRange(timeWindow.startIso, timeWindow.endIso)}</span>
          </div>
        </div>
        <p className="text-[12px] text-ink-soft">
          From your departure (or now, if later) to the estimated arrival plus 24 h. The dashed box on the chart is the area.
        </p>

        {manifestState.status === 'loading' && <p className="text-ink-soft">Loading the forecast runs…</p>}
        {manifestState.status === 'error' && (
          <p className="text-ink-soft">
            <span>The forecast runs are unavailable, so GRIB files can’t be prepared right now.</span>{' '}
            <button type="button" className="underline" onClick={() => setManifestState((s) => ({ ...s, status: 'loading', attempt: s.attempt + 1 }))}>
              Try again
            </button>
          </p>
        )}
        {planError && <p className="text-verdict-exceeds text-[13px]">This area can’t be exported (it may cross the 180° meridian).</p>}

        {plan && (
          <fieldset>
            <legend className="eyebrow mb-1">Datasets</legend>
            <ul className="space-y-2">
              {plan.datasets.map((dataset) => {
                const info = describeGribDataset(dataset, timeWindow);
                const note = gribDataset(dataset.datasetId)?.note;
                return (
                  <li key={dataset.datasetId}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={info.ok && selected.has(dataset.datasetId)}
                        disabled={!info.ok || running}
                        onChange={() => toggle(dataset.datasetId)}
                      />
                      <span>
                        <span className="font-medium">{dataset.label}</span>
                        {info.ok ? (
                          <span className="block text-[12px] text-ink-soft">
                            <span className="font-mono">{fmtUtcRange(info.first, info.last)}</span>
                            {' · '}<span>{fmtGribSteps(info.steps)}</span>
                            {' · ≈ '}<span>{fmtGribBytes(dataset.estBytes)}</span>
                          </span>
                        ) : (
                          <span className="block text-[12px] text-ink-soft">{UNAVAILABLE[dataset.availability]}</span>
                        )}
                        {info.partial && info.ok && (
                          <span className="block text-[12px]">
                            Partial coverage: this regional model covers only part of the area. The rest of the file is left empty.
                          </span>
                        )}
                        {info.horizonShort && <span className="block text-[12px]">{fmtHorizonShort(info.last)}</span>}
                        {note && <span className="block text-[12px] text-ink-soft">{note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {plan && (
          <div className="space-y-2">
            {tooLarge && <p className="text-verdict-exceeds text-[13px]">{fmtTooLarge(estimate)}</p>}
            {running ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => jobRef.current?.controller.abort()}
                  className="border border-ink/50 rounded-sm px-4 py-2 hover:bg-white/50"
                >
                  Cancel
                </button>
                <progress className="w-48" value={progress.done} max={Math.max(1, progress.total)} aria-label="GRIB export progress" />
                <span className="text-[12px] text-ink-soft">
                  <span>{STAGE_LABELS[progress.stage]}</span>
                  {' · '}<span>{gribDataset(progress.datasetId)?.label}</span>
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={prepare}
                disabled={!chosen?.datasets.length || tooLarge}
                className="bg-ink text-paper font-medium rounded-sm px-4 py-2 hover:bg-ink-deep disabled:opacity-40"
              >
                Prepare files
              </button>
            )}
            {!running && chosen && !chosen.datasets.length && (
              <p className="text-[12px] text-ink-soft">Tick at least one available dataset.</p>
            )}
            {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
          </div>
        )}

        {result && (
          <ul className="space-y-3 border-t hairline pt-3" aria-label="Prepared GRIB files">
            {result.files.map((file) => (
              <li key={file.datasetId}>
                <p className="font-medium">{gribDataset(file.datasetId)?.label}</p>
                {file.messages > 0 ? (
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <a
                      href={file.url}
                      download={file.name}
                      aria-describedby={`grib-file-${file.datasetId}`}
                      className="underline font-medium"
                    >
                      Save
                    </a>
                    <code id={`grib-file-${file.datasetId}`} className="font-mono text-[12px] break-all">{file.name}</code>
                    <span className="text-[12px] text-ink-soft">{fmtGribBytes(file.bytes)}</span>
                  </p>
                ) : (
                  <p className="text-[12px] text-ink-soft">No values in this area for these times, so there is no file.</p>
                )}
                <FileDetails file={file} />
              </li>
            ))}
          </ul>
        )}

        <div className="text-[12px] text-ink-soft space-y-1 border-t hairline pt-2">
          <p className="font-medium text-ink">{GRIB_EXPORT_NOTICE}</p>
          {attributions.length > 0 && (
            <p>
              <span>Data sources:</span>{' '}
              {attributions.map((line, index) => (
                <span key={line}>{index > 0 && ' · '}<span>{line}</span></span>
              ))}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
