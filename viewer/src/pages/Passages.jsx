import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { usePlanner } from '../stores/plannerStore.js';
import { useApp } from '../stores/appStore.js';
import { VerdictChip } from '../components/common.jsx';
import { fmtLocalTime, localTimeZoneName } from '../lib/format.js';
import { palette } from '../lib/palette.js';
import { translateText } from '../i18n.js';
import { fetchSnapshotJson } from '../lib/localSnapshots.js';
import { groupPassages, routeName } from '../lib/passages.js';
import { loadJson } from '../lib/verification.js';

/** Every passage you have checked: its latest verdict, what changed since the
 * previous check, and where it is between planning and verification. */
export default function Passages() {
  const manifest = useApp((s) => s.manifest);
  const manifestError = useApp((s) => s.manifestError);
  const loadManifest = useApp((s) => s.loadManifest);
  const setPage = useApp((s) => s.setPage);
  const loadError = useApp((s) => s.loadError);
  const [verified, setVerified] = useState(new Set());

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);
  useEffect(() => {
    const controller = new AbortController();
    loadJson('/data/verification/cases/index.json', controller.signal).then((index) => {
      if (!controller.signal.aborted) setVerified(new Set((index?.cases ?? []).map((item) => item.snapshot_id ?? item)));
    });
    return () => controller.abort();
  }, []);

  const passages = useMemo(() => groupPassages(manifest?.snapshots), [manifest]);
  const hasExample = passages.some((passage) => passage.demo);

  return (
    <div className="px-4 sm:px-6 py-5 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
        <h1 className="font-chart text-3xl">My passages</h1>
        <button type="button" onClick={() => { usePlanner.getState().reset(); setPage('planner'); }} className="min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
          + New passage
        </button>
      </div>
      <p className="font-sans text-sm text-ink-soft mb-5 max-w-3xl">
        Each check is frozen when you make it. A passage keeps its checks together, with what
        changed between them and, after you sail, how the forecast held up.
      </p>

      {manifestError && (
        <p className="font-sans text-sm text-verdict-exceeds">manifest error: {manifestError}</p>
      )}
      {loadError && <p role="alert" className="font-sans text-sm text-verdict-exceeds mb-3 break-words">{loadError}</p>}

      {manifest && passages.length === 0 && (
        <div className="border border-dashed hairline rounded-sm p-6 bg-white/30">
          <p className="font-story text-xl">No passages yet.</p>
          <p className="font-sans text-sm text-ink-soft mt-1">
            Plan a passage, set a departure time and check it against your limits.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {passages.map((passage) => <PassageRow key={passage.key} passage={passage} verified={verified} />)}
      </ul>

      {manifest && !hasExample && (
        <button type="button" onClick={() => setPage('example')} className="mt-6 flex items-center gap-3 border hairline bg-white/30 px-4 py-3 hover:border-ink-soft text-left">
          <span className="font-story text-lg">See an example briefing</span>
          <span className="stamp-emulated">emulated</span>
        </button>
      )}
    </div>
  );
}

function PassageRow({ passage, verified }) {
  const openSnapshot = useApp((s) => s.openSnapshot);
  const deleteSnapshot = useApp((s) => s.deleteSnapshot);
  const loading = useApp((s) => s.loading);
  const [route, setRoute] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const { latest, previous, checks } = passage;

  useEffect(() => {
    let current = true;
    fetchSnapshotJson(latest.snapshot_id, 'route.json').then((doc) => current && setRoute(doc), () => {});
    return () => { current = false; };
  }, [latest.snapshot_id]);

  const title = route?.name ?? routeName(passage.route_id);
  const departed = Date.parse(passage.departure_utc) < Date.now();
  const isVerified = checks.some((check) => verified.has(check.snapshot_id));
  const remove = async () => {
    const departure = fmtLocalTime(passage.departure_utc);
    const message = checks.length === 1
      ? `Delete the briefing "${title}" departing ${departure} local time (${localTimeZoneName()})? This cannot be undone.`
      : `Delete the passage "${title}" departing ${departure} local time (${localTimeZoneName()}) and its ${checks.length} checks? This cannot be undone.`;
    if (!window.confirm(translateText(message, document.documentElement.lang))) return;
    try {
      for (const check of checks) await deleteSnapshot(check.snapshot_id);
    } catch (e) {
      setDeleteError(e.message);
    }
  };

  return (
    <li className="flex items-stretch gap-1.5">
      <article className="flex-1 min-w-0 bg-white/40 border hairline rounded-sm shadow-panel">
        <button
          type="button"
          disabled={loading}
          onClick={() => openSnapshot(latest.snapshot_id)}
          title={latest.snapshot_id}
          className="w-full text-left p-3 flex items-start gap-4 hover:bg-white/40"
        >
          <RouteSketch route={route} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-chart text-xl sm:text-2xl leading-tight">{title}</span>
              {passage.demo && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft border border-line px-1.5 py-0.5 rounded-sm">
                  example
                </span>
              )}
              {passage.legacy && <span className="font-sans text-[12px] text-ink-soft">Saved check · separate history</span>}
              {latest.verdict_state && <VerdictChip state={latest.verdict_state} small />}
            </span>
            <span className="font-mono text-[12px] text-ink-soft block mt-1">
              <span>dep</span> {fmtLocalTime(passage.departure_utc)} · <span>last checked</span> {fmtLocalTime(latest.created_at)}
            </span>
            {previous && (
              <span className="font-sans text-[13px] text-event flex flex-wrap items-center gap-1.5 mt-1.5">
                {previous.verdict_state && latest.verdict_state && previous.verdict_state !== latest.verdict_state ? (
                  <>
                    <span>Changed since last check:</span>
                    <VerdictChip state={previous.verdict_state} small /><span aria-hidden>→</span><VerdictChip state={latest.verdict_state} small />
                  </>
                ) : (
                  <span>Rechecked · verdict unchanged</span>
                )}
              </span>
            )}
          </span>
        </button>
        <Lifecycle checks={checks} latestId={latest.snapshot_id} departure={passage.departure_utc} departed={departed} verified={isVerified} onOpen={openSnapshot} disabled={loading} />
        {deleteError && <p className="px-3 pb-2 font-sans text-sm text-verdict-exceeds">{deleteError}</p>}
      </article>
      <button
        type="button"
        aria-label="Delete this passage"
        title="Delete this passage"
        disabled={loading}
        onClick={remove}
        className="shrink-0 px-3 border hairline rounded-sm text-ink-soft hover:text-verdict-exceeds hover:border-verdict-exceeds min-h-11"
      >
        ✕
      </button>
    </li>
  );
}

/** Checks → departure → verification, as stations along one line. */
function Lifecycle({ checks, latestId, departure, departed, verified, onOpen, disabled }) {
  // long histories keep their first and last two checks
  const shown = checks.length > 4 ? [checks[0], null, ...checks.slice(-2)] : checks;
  return (
    <ol className="flex items-start px-3 pb-3 pt-1 overflow-x-auto" aria-label="Passage progress">
      {shown.map((check, index) => check ? (
        <Station key={check.snapshot_id} filled current={check.snapshot_id === latestId}>
          <button type="button" disabled={disabled} onClick={() => onOpen(check.snapshot_id)} className="underline-offset-2 hover:underline text-left">
            <span>Check</span> <span>{checks.indexOf(check) + 1}</span>
          </button>
          <span className="block font-mono text-[10px] text-ink-soft">{fmtLocalTime(check.created_at)}</span>
        </Station>
      ) : (
        <Station key={`more-${index}`} filled>
          <span className="font-mono">+{checks.length - 3}</span>
        </Station>
      ))}
      <Station filled={departed}>
        <span>Departure</span>
        <span className="block font-mono text-[10px] text-ink-soft">{fmtLocalTime(departure)}</span>
      </Station>
      <Station filled={verified} last>
        <span>{verified ? 'Verified' : 'Verify'}</span>
      </Station>
    </ol>
  );
}

function Station({ filled, current, last, children }) {
  return (
    <li className={clsx('relative shrink-0 min-w-[7.5rem] pr-3 font-sans text-[12px]', last && 'min-w-0')}>
      <span className="flex items-center h-5" aria-hidden>
        <span
          className={clsx('w-3.5 h-3.5 rounded-full border-2 shrink-0', current && 'ring-2 ring-event ring-offset-2 ring-offset-paper')}
          style={{ borderColor: current ? palette.event : palette.ink.DEFAULT, backgroundColor: filled ? (current ? palette.event : palette.ink.DEFAULT) : palette.paper.DEFAULT }}
        />
        {!last && <span className="flex-1 border-t border-ink/40 ml-1" />}
      </span>
      <span className={clsx('block mt-1', current && 'text-event font-medium')}>{children}</span>
    </li>
  );
}

/** A thumbnail of the route on sea-wash: start filled, finish open. */
function RouteSketch({ route }) {
  const box = 'w-24 h-16 sm:w-40 sm:h-24 shrink-0 border hairline rounded-sm';
  const points = route?.waypoints?.filter((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lon)) ?? [];
  if (points.length < 2) return <span className={clsx(box, 'bg-shoal/60')} aria-hidden />;
  const W = 160, H = 96, pad = 14;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const w = Math.max((maxLon - minLon) * kx, 1e-3), h = Math.max(maxLat - minLat, 1e-3);
  const scale = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
  const x = (lon) => pad + ((W - 2 * pad) - w * scale) / 2 + (lon - minLon) * kx * scale;
  const y = (lat) => pad + ((H - 2 * pad) - h * scale) / 2 + (maxLat - lat) * scale;
  const line = points.map((p) => `${x(p.lon).toFixed(1)},${y(p.lat).toFixed(1)}`).join(' ');
  const start = points[0], end = points.at(-1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={box} aria-hidden>
      <rect width={W} height={H} fill={palette.sea} />
      {[1, 2, 3].map((i) => <line key={i} x1={(W * i) / 4} x2={(W * i) / 4} y1="0" y2={H} stroke={palette.wave} strokeOpacity=".15" strokeWidth=".6" />)}
      {[1, 2].map((i) => <line key={i} y1={(H * i) / 3} y2={(H * i) / 3} x1="0" x2={W} stroke={palette.wave} strokeOpacity=".15" strokeWidth=".6" />)}
      <polyline points={line} fill="none" stroke={palette.ink.DEFAULT} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(start.lon)} cy={y(start.lat)} r="3.5" fill={palette.ink.DEFAULT} />
      <circle cx={x(end.lon)} cy={y(end.lat)} r="3.5" fill={palette.paper.DEFAULT} stroke={palette.ink.DEFAULT} strokeWidth="1.6" />
    </svg>
  );
}
