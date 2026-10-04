import { useEffect, useMemo, useRef, useState } from 'react';
import { GRIB_EXPORT_NOTICE, FORECAST_UPDATED_MESSAGE, gribDataset } from '@deepweather/engine';
import { EmulatedStamp, Panel } from '../components/common.jsx';
import { track } from '../lib/analytics.js';
import { fmtTime } from '../lib/format.js';
import { forecastStore, friendlyForecastError } from '../lib/forecastStore.js';
import { withFreshForecast } from '../lib/forecastFreshness.js';
import {
  GRIB_KINDS,
  GRIB_MAX_EST_BYTES,
  GRIB_PERIODS,
  GRIB_STEPS,
  GRIB_TILES_ARE_FIXTURE,
  describeGribDataset,
  fmtGribArea,
  fmtGribBox,
  fmtGribBytes,
  fmtGribCoverage,
  fmtGribGrid,
  fmtGribSteps,
  fmtGustWindows,
  fmtHorizonShort,
  fmtLatLon,
  fmtTooLarge,
  fmtUtc,
  fmtUtcRange,
  gribAreaFromHash,
  gribAreaHash,
  gribFileWithUrl,
  gribForecastEnd,
  gribKindDataset,
  gribModelName,
  gribModelOrder,
  gribModelSpacing,
  gribPeriodFor,
  gribPeriodWindow,
  gribRunIds,
  gribRunLabel,
  gribSizeBucket,
  gribSpotKeys,
  loadGribManifests,
  planAreaGrib,
  revokeGribFile,
  runDatasetGrib,
  saveGribFile,
} from '../lib/gribExport.js';
import { parseRoute } from '../lib/routes.js';
import { useGrib } from '../stores/gribStore.js';
import GribMap from './grib/GribMap.jsx';

const HOUR_MS = 3_600_000;
// abort reason when the area or settings change under a running file
const SETTINGS_CHANGED = 'settings-changed';

const KIND_BUTTONS = { wind: 'Download wind', currents: 'Download currents', waves: 'Download waves' };

const MODEL_SELECTS = { wind: 'Wind model', currents: 'Currents model' };

const PERIOD_LABELS = {
  1: 'Next 1 day',
  2: 'Next 2 days',
  3: 'Next 3 days',
  5: 'Next 5 days',
  7: 'Next 7 days',
  full: 'Full forecast',
};

const SWITCH_LABELS = {
  1: 'Switch to Next 1 day',
  2: 'Switch to Next 2 days',
  3: 'Switch to Next 3 days',
  5: 'Switch to Next 5 days',
  7: 'Switch to Next 7 days',
  full: 'Switch to Full forecast',
};

const STEP_LABELS = { all: 'Every forecast step', 3: 'Every 3 h', 6: 'Every 6 h' };

const UNAVAILABLE = {
  'no-layer': 'Not in the current forecast runs.',
  'no-tiles': 'No data for this area.',
  'too-large': 'Choose a smaller area for this regional model.',
  'outside-horizon': 'Your dates are beyond this forecast’s range.',
};

const STAGE_LABELS = { tiles: 'Reading forecast tiles', encode: 'Writing the GRIB file' };

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

const sameArea = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Everything the files depend on, so stale downloads are dropped when an input changes. */
function derive({ manifests, area, period, step, nowMs }) {
  const forecastEndIso = manifests ? gribForecastEnd(manifests) : null;
  const timeWindow = gribPeriodWindow({ period, nowMs, forecastEndIso });
  // A file prepared from a run that has since been replaced is not offered again.
  const key = JSON.stringify([area, timeWindow, step, manifests ? gribRunIds(manifests) : []]);
  if (!manifests || !area) return { timeWindow, key, plan: null, planError: null };
  try {
    return { timeWindow, key, plan: planAreaGrib(manifests, { area, window: timeWindow, step }), planError: null };
  } catch (error) {
    return { timeWindow, key, plan: null, planError: error };
  }
}

function Step({ number, title, children }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden="true" className="shrink-0 inline-flex w-6 h-6 items-center justify-center rounded-full bg-ink text-paper font-mono text-xs">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="eyebrow">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function SpotValues({ file }) {
  const keys = gribSpotKeys(file);
  if (!file.checkpoints.length || !keys.length) return null;
  const point = file.checkpoints[0];
  return (
    <div>
      <p className="text-[12px]">
        <span className="font-medium">Centre of the area</span>
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
  );
}

function FileDetails({ file }) {
  const rows = [
    // identifiers sit in <code>, which the French DOM translator leaves alone
    ['Model', <code className="font-mono">{file.model}</code>],
    ['Forecast run', <><span className="block font-mono">{gribRunLabel(file)}</span><code className="block font-mono break-all">{file.run_id}</code></>],
    ['Base time', <span className="font-mono">{fmtUtc(file.cycle)}</span>],
    ['Grid', <span className="font-mono">{fmtGribGrid(file.grid)}</span>],
    ['Area', <span className="font-mono">{fmtGribArea(file.grid)}</span>],
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

/** The kind's models side by side, the chosen one pressed; one click switches. */
function ModelPicker({ kindId, options, selected, disabled, onChoose }) {
  return (
    <div role="radiogroup" aria-label={MODEL_SELECTS[kindId]} className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span aria-hidden="true" className="eyebrow mr-0.5">Model</span>
      {options.map((option) => {
        const checked = option.id === selected;
        const usable = option.availability === 'ok';
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled || !usable}
            title={usable ? undefined : UNAVAILABLE[option.availability]}
            onClick={() => onChoose(option.id)}
            className={`rounded-sm border px-2 py-1 ${checked ? 'border-ink bg-ink text-paper' : 'hairline bg-white/60 hover:bg-white hover:border-ink/50'} disabled:cursor-not-allowed ${!usable ? 'border-dashed text-ink-soft' : ''} ${disabled && !checked ? 'opacity-60' : ''}`}
          >
            <span className="font-medium">{option.name}</span>
            {option.spacing && <span className={`ml-1 font-mono ${checked ? 'opacity-80' : 'text-ink-soft'}`}>{option.spacing}</span>}
          </button>
        );
      })}
    </div>
  );
}

function KindRow({ kindId, dataset, timeWindow, period, result, running, progress, busy, models, shorter, onChoose, onPeriod, onDownload, onCancel }) {
  const info = describeGribDataset(dataset, timeWindow);
  const note = gribDataset(dataset.datasetId)?.note;
  const tooLarge = info.ok && dataset.estBytes > GRIB_MAX_EST_BYTES;
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        {running ? (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="min-w-[11rem] border border-ink/50 rounded-sm px-4 py-2 hover:bg-white/50"
            >
              Cancel
            </button>
            <progress className="w-32" value={progress.done} max={Math.max(1, progress.total)} aria-label="GRIB file progress" />
            <span className="text-[12px] text-ink-soft">{STAGE_LABELS[progress.stage]}</span>
          </>
        ) : (
          <button
            type="button"
            onClick={onDownload}
            disabled={!info.ok || tooLarge || busy}
            className="min-w-[11rem] bg-ink text-paper font-medium rounded-sm px-4 py-2 hover:bg-ink-deep disabled:opacity-40"
          >
            <span aria-hidden="true">⬇ </span>{KIND_BUTTONS[kindId]}
          </button>
        )}
      </div>
      {models.length > 1 && (
        <ModelPicker kindId={kindId} options={models} selected={dataset.datasetId} disabled={busy} onChoose={onChoose} />
      )}
      {shorter && !running && (
        <p className="text-[12px] text-ink-soft">
          <span>Shorter forecast:</span>{' '}<span>{shorter.names.join(', ')}</span>{' · '}
          <button type="button" className="underline disabled:no-underline" disabled={busy} onClick={() => onPeriod(shorter.period)}>
            {SWITCH_LABELS[shorter.period]}
          </button>
        </p>
      )}
      <p className="text-[12px]">
        <span className="font-medium">{dataset.label}</span>
        {info.ok && (
          <span className="block text-ink-soft">
            <span className="font-mono">{fmtUtcRange(info.first, info.last)}</span>
            {' · '}<span>{fmtGribSteps(info.steps)}</span>
            {' · ≈ '}<span>{fmtGribBytes(dataset.estBytes)}</span>
          </span>
        )}
      </p>
      {!info.ok && <p className="text-[12px] text-ink-soft">{UNAVAILABLE[dataset.availability]}</p>}
      {dataset.downloadBytesUpperBound > 0 && dataset.datasetId.startsWith('wind-') && !['wind-gfs', 'wind-ecmwf'].includes(dataset.datasetId) && (
        <p className="text-[12px] text-ink-soft"><span>Forecast tile transfer</span>{' · ≈ '}{fmtGribBytes(dataset.downloadBytesUpperBound)}</p>
      )}
      {tooLarge && <p className="text-[12px] text-verdict-exceeds">{fmtTooLarge(dataset.estBytes)}</p>}
      {info.ok && info.partial && (
        <p className="text-[12px]">
          Partial coverage: this regional model covers only part of the area. The rest of the file is left empty.
        </p>
      )}
      {info.horizonShort && period !== 'full' && <p className="text-[12px]">{fmtHorizonShort(info.last)}</p>}
      {note && <p className="text-[12px] text-ink-soft">{note}</p>}
      {info.gustWindows.length > 0 && <p className="text-[12px] text-ink-soft">{fmtGustWindows(info.gustWindows)}</p>}
      {result && (result.file.url ? (
        <div className="border-l-2 border-verdict-within pl-2">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-medium">Saved</span>
            <code className="font-mono break-all">{result.file.name}</code>
            <span className="text-ink-soft">{fmtGribBytes(result.file.bytes)}</span>
            <a href={result.file.url} download={result.file.name} className="underline">Save again</a>
          </p>
          <FileDetails file={result.file} />
        </div>
      ) : (
        <p className="text-[12px] text-ink-soft">No values in this area for these times, so there is no file.</p>
      ))}
    </li>
  );
}

/**
 * Download GRIB files: draw a box, pick a period, download one GRIB2 file per
 * kind (wind, currents, waves), built in the browser from the pinned forecast
 * runs (docs/grib-export.md → GRIB files page).
 */
export default function Grib() {
  const { area, period, step, models, fitNonce, patch, showArea } = useGrib();
  const [manifestState, setManifestState] = useState({ status: 'loading', manifests: null, attempt: 0 });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [drawing, setDrawing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState({});
  const [error, setError] = useState(null);
  // the running file: { controller, key }
  const jobRef = useRef(null);
  const resultsRef = useRef({});
  const adoptedLink = useRef(false);
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
    // A shared or bookmarked #plan/grib?area=… link wins over the remembered area
    // once; after that the address follows the box, so it can always be bookmarked.
    if (!adoptedLink.current) {
      adoptedLink.current = true;
      const linked = gribAreaFromHash();
      if (linked && !sameArea(linked, area)) {
        showArea(linked);
        return;
      }
    }
    const target = `#${gribAreaHash(area)}`;
    if (parseRoute(location.hash).page === 'grib' && location.hash !== target) {
      history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
    }
  }, [area, showArea]);

  useEffect(() => {
    const follow = () => {
      const linked = gribAreaFromHash();
      if (linked && !sameArea(linked, useGrib.getState().area)) useGrib.getState().showArea(linked);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => () => {
    jobRef.current?.controller.abort(SETTINGS_CHANGED);
    for (const result of Object.values(resultsRef.current)) revokeGribFile(result.file);
  }, []);

  const { timeWindow, key, plan, planError } = useMemo(
    () => derive({ manifests, area, period, step, nowMs }),
    [manifests, area, period, step, nowMs],
  );

  const kinds = plan
    ? GRIB_KINDS.map((kind) => ({ kindId: kind.id, dataset: gribKindDataset(plan, kind.id, area, models[kind.id] ?? null) }))
      .filter(({ dataset }) => dataset)
    : [];
  // Each kind's models for the picker, and the period that brings in the ones
  // whose forecast ends too early.
  const pickers = useMemo(() => {
    if (!plan) return {};
    return Object.fromEntries(GRIB_KINDS.map((kind) => {
      const options = gribModelOrder(kind.id, area, plan)
        .map((id) => plan.datasets.find((dataset) => dataset.datasetId === id))
        .filter((dataset) => dataset && dataset.availability !== 'no-layer')
        .map((dataset) => ({
          id: dataset.datasetId,
          name: gribModelName(dataset.datasetId),
          spacing: gribModelSpacing(manifests, dataset),
          availability: dataset.availability,
        }));
      const later = options
        .filter((option) => option.availability === 'outside-horizon')
        .map((option) => ({ name: option.name, period: gribPeriodFor(manifests, { area, step, nowMs, datasetId: option.id }) }))
        .filter((option) => option.period);
      const shorter = later.length
        ? { names: later.map((option) => option.name), period: later.map((option) => option.period).sort((a, b) => GRIB_PERIODS.indexOf(b) - GRIB_PERIODS.indexOf(a))[0] }
        : null;
      return [kind.id, { options, shorter }];
    }));
  }, [plan, manifests, area, step, nowMs]);
  const kindKey = (kindId, datasetId) => JSON.stringify([key, kindId, datasetId]);
  const liveKeys = new Set(kinds.map(({ kindId, dataset }) => kindKey(kindId, dataset.datasetId)));
  const liveKeysSignature = [...liveKeys].sort().join('|');

  const setResultsBoth = (next) => {
    resultsRef.current = next;
    setResults(next);
  };

  useEffect(() => {
    // The area, period, step or a model changed: a file for the old settings
    // (or one still being prepared for them) is not what the page now shows.
    if (jobRef.current && !liveKeys.has(jobRef.current.key)) jobRef.current.controller.abort(SETTINGS_CHANGED);
    if (!jobRef.current) setError(null);
    const kept = {};
    let dropped = false;
    for (const [kindId, result] of Object.entries(resultsRef.current)) {
      if (liveKeys.has(result.key)) kept[kindId] = result;
      else {
        revokeGribFile(result.file);
        dropped = true;
      }
    }
    if (dropped) setResultsBoth(kept);
    // liveKeys is rebuilt every render; its signature is the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKeysSignature]);

  const running = progress !== null;
  const attributions = [...new Set(kinds.map(({ dataset }) => dataset.spec.attribution))];

  // One file: re-read latest.json first when it is over 10 minutes old; a
  // deleted run refreshes and retries once (lib/forecastFreshness.js).
  const prepare = async (kindId, { changed }) => {
    let current = manifests;
    if (changed.length) {
      // New runs since the page planned: plan on them, and show them.
      const store = forecastStore();
      current = (layer) => store.manifestFor(layer);
      setManifestState((s) => ({ ...s, manifests: current }));
    }
    // A new hour moves the period start; plan from the current hour.
    const now = Date.now();
    const fresh = changed.length || Math.floor(now / HOUR_MS) !== Math.floor(nowMs / HOUR_MS)
      ? derive({ manifests: current, area, period, step, nowMs: now })
      : { key, plan };
    if (fresh.key !== key) setNowMs(now);
    if (!fresh.plan) return;
    const dataset = gribKindDataset(fresh.plan, kindId, area, models[kindId] ?? null);
    if (!dataset || dataset.availability !== 'ok' || dataset.estBytes > GRIB_MAX_EST_BYTES) return;
    const jobKey = JSON.stringify([fresh.key, kindId, dataset.datasetId]);
    const saved = resultsRef.current[kindId];
    if (saved?.key === jobKey && saved.file.url) {
      saveGribFile(saved.file);
      return;
    }
    const controller = new AbortController();
    const job = { controller, key: jobKey };
    jobRef.current = job;
    setError(null);
    setProgress({ kindId, stage: 'tiles', done: 0, total: 1 });
    try {
      const file = await runDatasetGrib(forecastStore(), fresh.plan, dataset, {
        signal: controller.signal,
        onProgress: (update) => setProgress({ ...update, kindId }),
      });
      controller.signal.throwIfAborted();
      const prepared = file.messages > 0 ? gribFileWithUrl(file) : { ...file, parts: undefined };
      revokeGribFile(resultsRef.current[kindId]?.file);
      setResultsBoth({ ...resultsRef.current, [kindId]: { key: jobKey, file: prepared } });
      if (prepared.url) saveGribFile(prepared);
      track('grib_export', {
        datasets: dataset.datasetId,
        window: period === 'full' ? 'full' : `${period}d`,
        size_bucket: gribSizeBucket(file.bytes),
      });
    } catch (e) {
      if (controller.signal.aborted) {
        if (controller.signal.reason !== SETTINGS_CHANGED) setError('Cancelled. No file was saved.');
      } else if (e?.code === 'forecast-updated') throw e; // refreshed and retried once
      else setError(friendlyForecastError(e).message);
    } finally {
      if (jobRef.current === job) {
        jobRef.current = null;
        setProgress(null);
      }
    }
  };

  const download = (kindId) => withFreshForecast((fresh) => prepare(kindId, fresh))
    .catch((e) => setError(e?.code === 'forecast-updated' ? FORECAST_UPDATED_MESSAGE : friendlyForecastError(e).message));

  const savedAny = Object.values(results).some((result) => result.file.url);

  return (
    <div className="px-6 py-5 max-w-[1600px]">
      <h1 className="font-chart text-3xl mb-1">Download GRIB files</h1>
      <p className="font-sans text-sm text-ink-soft mb-4 max-w-[90ch]">
        Forecast files for Adrena, OpenCPN, qtVlm, XyGrib or any GRIB software. Draw a box around your
        sailing area, choose a period, then download each file. Built in your browser from the same forecast
        runs as your briefings.
      </p>
      {GRIB_TILES_ARE_FIXTURE && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-sans mb-3">
          <EmulatedStamp /><span>Local test tiles, not the live forecast.</span>
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GribMap
          area={area}
          fitNonce={fitNonce}
          drawing={drawing}
          disabled={running}
          onStartDraw={() => setDrawing(true)}
          onCancelDraw={() => setDrawing(false)}
          onDrawn={(drawn) => {
            setDrawing(false);
            patch({ area: drawn });
          }}
          onAreaChange={(changed) => patch({ area: changed })}
        />

        <Panel title="Your GRIB files">
          <div className="space-y-5 font-sans text-sm" aria-label="GRIB download" role="region">
            <Step number={1} title="Area">
              {drawing ? (
                <p>Drag across the chart to draw your area.</p>
              ) : area ? (
                <>
                  <p className="font-mono text-[13px]">{fmtGribBox(area)}</p>
                  <p className="text-[12px] text-ink-soft">Drag a corner of the box to adjust it.</p>
                </>
              ) : (
                <p>Move the chart to your sailing area, press Draw a box, then drag across the chart.</p>
              )}
              {planError && <p className="text-verdict-exceeds text-[13px]">This area can’t be exported (it may cross the 180° meridian).</p>}
            </Step>

            <Step number={2} title="Period">
              <select
                value={period}
                onChange={(e) => patch({ period: e.target.value })}
                disabled={running}
                aria-label="Period"
                className="bg-white/60 border hairline rounded-sm px-2 py-1.5"
              >
                {GRIB_PERIODS.map((value) => <option key={value} value={value}>{PERIOD_LABELS[value]}</option>)}
              </select>
              <p className="font-mono text-[12px]">{fmtUtcRange(timeWindow.startIso, timeWindow.endIso)}</p>
            </Step>

            <Step number={3} title="Download">
              <p className="text-[12px] text-ink-soft">One file for each, to open in your GRIB software.</p>
              {!area && <p className="text-ink-soft">Draw your area first.</p>}
              {area && manifestState.status === 'loading' && <p className="text-ink-soft">Loading the forecast runs…</p>}
              {area && manifestState.status === 'error' && (
                <p className="text-ink-soft">
                  <span>The forecast runs are unavailable, so GRIB files can’t be prepared right now.</span>{' '}
                  <button type="button" className="underline" onClick={() => setManifestState((s) => ({ ...s, status: 'loading', attempt: s.attempt + 1 }))}>
                    Try again
                  </button>
                </p>
              )}
              {kinds.length > 0 && (
                <ul className="space-y-4 pt-1" aria-label="GRIB files">
                  {kinds.map(({ kindId, dataset }) => (
                    <KindRow
                      key={kindId}
                      kindId={kindId}
                      dataset={dataset}
                      timeWindow={timeWindow}
                      period={period}
                      result={results[kindId]?.key === kindKey(kindId, dataset.datasetId) ? results[kindId] : null}
                      running={progress?.kindId === kindId}
                      progress={progress}
                      busy={running || drawing}
                      models={pickers[kindId]?.options ?? []}
                      shorter={pickers[kindId]?.shorter ?? null}
                      onChoose={(id) => patch({ models: { ...models, [kindId]: id } })}
                      onPeriod={(value) => patch({ period: value })}
                      onDownload={() => download(kindId)}
                      onCancel={() => jobRef.current?.controller.abort()}
                    />
                  ))}
                </ul>
              )}
              {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
              {savedAny && (
                <p className="text-[12px] text-ink-soft">
                  Your browser saves the files in its Downloads folder. Open them from there in your GRIB software.
                </p>
              )}
            </Step>

            {plan && (
              <details className="border-t hairline pt-3">
                <summary className="cursor-pointer text-[13px]">More options</summary>
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <span className="eyebrow block mb-1">Time step</span>
                    <select
                      value={String(step)}
                      onChange={(e) => patch({ step: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
                      disabled={running}
                      className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5"
                    >
                      {GRIB_STEPS.map((value) => <option key={value} value={String(value)}>{STEP_LABELS[value]}</option>)}
                    </select>
                  </label>
                </div>
              </details>
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
        </Panel>
      </div>
    </div>
  );
}
