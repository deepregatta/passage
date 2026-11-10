import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { usePlanner } from '../stores/plannerStore.js';
import { useApp } from '../stores/appStore.js';
import { VerdictChip } from '../components/common.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { fmtLocalTime, localTimeZoneName } from '../lib/format.js';
import { palette } from '../lib/palette.js';
import { translateText } from '../i18n.js';
import { fetchSnapshotJson } from '../lib/localSnapshots.js';
import { OWNED, groupPassages, localTime, passageText, routeChanges, routeName } from '../lib/passages.js';
import { MAX_LABEL_LENGTH, passageLabels } from '../lib/passageLabels.js';
import { loadJson } from '../lib/verification.js';

/** Every passage you have checked: its latest verdict, what changed since the
 * previous check, and where it is between planning and verification. */
export default function Passages() {
  const manifest = useApp((s) => s.manifest);
  const manifestError = useApp((s) => s.manifestError);
  const loadManifest = useApp((s) => s.loadManifest);
  const setPage = useApp((s) => s.setPage);
  const loadError = useApp((s) => s.loadError);
  const language = useApp((s) => s.language);
  const [publishedCases, setPublishedCases] = useState(new Set());
  const [labels, setLabels] = useState(() => passageLabels.all());
  const [note, setNote] = useState('');
  const heading = useRef(null);

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);
  useEffect(() => {
    const controller = new AbortController();
    loadJson('/data/verification/cases/index.json', controller.signal).then((index) => {
      if (!controller.signal.aborted) setPublishedCases(new Set((index?.cases ?? []).map((item) => item.snapshot_id ?? item)));
    });
    return () => controller.abort();
  }, []);

  const passages = useMemo(() => groupPassages(manifest?.snapshots), [manifest]);
  const hasExample = passages.some((passage) => passage.demo);

  // Renaming sets a display label for this browser; no saved check is rewritten.
  const rename = (key, name, defaultTitle) => {
    const typed = passageLabels.clean(name);
    const restore = !typed || typed === defaultTitle;
    const { labels: next, persisted } = passageLabels.set(key, restore ? '' : typed);
    setLabels(next);
    setNote(restore
      ? passageText('Original name restored.', {}, language)
      : passageText(persisted
        ? 'Passage renamed to {name}.'
        : 'Passage renamed to {name}. This browser could not save the name, so it lasts only until you leave this page.', { name: typed }, language));
  };
  // The deleted card held focus; the page title is the next sensible place.
  const deleted = (key) => {
    setLabels(passageLabels.remove(key).labels);
    heading.current?.focus();
  };

  return (
    <div className="px-4 sm:px-6 py-5 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
        <h1 ref={heading} tabIndex={-1} className="font-chart text-3xl focus:outline-hidden">My passages</h1>
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
        {passages.map((passage) => (
          <PassageRow
            key={passage.key} passage={passage} publishedCases={publishedCases} label={labels[passage.key]}
            language={language} onRename={rename} onDeleted={deleted}
          />
        ))}
      </ul>
      <p role="status" aria-live="polite" className="sr-only" {...OWNED}>{note}</p>

      {manifest && !hasExample && (
        <button type="button" onClick={() => setPage('example')} className="mt-6 flex items-center gap-3 border hairline bg-white/30 px-4 py-3 hover:border-ink-soft text-left">
          <span className="font-story text-lg">See an example briefing</span>
          <span className="stamp-emulated text-xs!">emulated</span>
        </button>
      )}
    </div>
  );
}

function PassageRow({ passage, publishedCases, label, language, onRename, onDeleted }) {
  const openSnapshot = useApp((s) => s.openSnapshot);
  const deleteSnapshot = useApp((s) => s.deleteSnapshot);
  const loading = useApp((s) => s.loading);
  const [route, setRoute] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(null); // null = not renaming
  const renameButton = useRef(null);
  const refocusRename = useRef(false);
  const { latest, previous, checks } = passage;

  useEffect(() => {
    let current = true;
    fetchSnapshotJson(latest.snapshot_id, 'route.json').then((doc) => current && setRoute(doc), () => {});
    return () => { current = false; };
  }, [latest.snapshot_id]);
  useEffect(() => {
    if (draft === null && refocusRename.current) { refocusRename.current = false; renameButton.current?.focus(); }
  }, [draft]);

  // The label is display only; the name inside the saved check is never touched.
  const defaultTitle = translateText(route?.name ?? routeName(passage.route_id), language);
  const title = label ?? defaultTitle;
  const departed = Date.parse(passage.departure_utc) < Date.now();
  const hasPublishedCase = !latest.local && publishedCases.has(latest.snapshot_id);
  const departure = localTime(passage.departure_utc, language);
  const change = routeChanges(checks);
  const name = { name: title };
  const finishRename = (save) => {
    if (save) onRename(passage.key, draft, defaultTitle);
    refocusRename.current = true;
    setDraft(null);
  };
  const remove = async () => {
    setConfirming(false);
    setDeleteError(null);
    try {
      for (const check of checks) await deleteSnapshot(check.snapshot_id);
      onDeleted(passage.key);
    } catch (e) {
      setDeleteError(e.message);
    }
  };

  return (
    <li>
      <article className="relative bg-white/40 border hairline rounded-sm shadow-panel hover:bg-white/60">
        {draft === null && (
          <button
            type="button"
            disabled={loading}
            onClick={() => openSnapshot(latest.snapshot_id)}
            aria-label={passageText('Open {name}, departing {time}', { ...name, time: departure }, language)}
            data-snapshot-id={latest.snapshot_id}
            className="absolute inset-0 w-full h-full rounded-sm cursor-pointer focus-visible:outline-2 focus-visible:outline-event disabled:cursor-wait"
            {...OWNED}
          />
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 sm:gap-x-4 gap-y-2 p-3">
          <RouteSketch route={route} />
          <div className="min-w-0">
            {draft === null ? (
              <h2 className="font-chart text-xl sm:text-2xl leading-tight sm:leading-8 break-words" {...OWNED}>{title}</h2>
            ) : (
              <form
                onSubmit={(e) => { e.preventDefault(); finishRename(true); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); finishRename(false); } }}
              >
                <input
                  autoFocus
                  aria-label="Passage name"
                  value={draft}
                  maxLength={MAX_LABEL_LENGTH}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  className="w-full min-h-11 border hairline bg-paper rounded-sm px-3 font-sans text-base"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="submit" className="min-h-11 min-w-11 px-4 rounded-sm bg-ink text-paper font-medium hover:bg-ink-deep">Save</button>
                  <button type="button" onClick={() => finishRename(false)} className="min-h-11 min-w-11 px-4 rounded-sm border hairline font-medium hover:border-ink-soft">Cancel</button>
                </div>
              </form>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
              {passage.demo && (
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-ink-soft border border-line px-1.5 py-0.5 rounded-sm">
                  example
                </span>
              )}
              {passage.legacy && <span className="font-sans text-xs text-ink-soft">Saved check · separate history</span>}
              {latest.verdict_state && <span className="inline-flex [&>span]:text-xs"><VerdictChip state={latest.verdict_state} small /></span>}
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1 sm:col-start-2 min-w-0 space-y-0.5">
            <p className="font-sans text-[13px] text-ink-soft"><span>Departs</span> <span className="font-mono text-xs">{fmtLocalTime(passage.departure_utc)}</span></p>
            <p className="font-sans text-[13px] text-ink-soft"><span>Last checked</span> <span className="font-mono text-xs">{fmtLocalTime(latest.created_at)}</span></p>
            {previous && (
              <p className="font-sans text-[13px] text-ink flex flex-wrap items-center gap-1.5 pt-1 before:content-[''] before:w-1.5 before:h-1.5 before:rounded-full before:bg-event before:shrink-0">
                {previous.verdict_state && latest.verdict_state && previous.verdict_state !== latest.verdict_state ? (
                  <>
                    <span>Changed since last check:</span>
                    <span className="inline-flex items-center gap-1.5 [&>span]:text-xs"><VerdictChip state={previous.verdict_state} small /><span aria-hidden>→</span><VerdictChip state={latest.verdict_state} small /></span>
                  </>
                ) : (
                  <span>Rechecked · verdict unchanged</span>
                )}
              </p>
            )}
            {change.kind && (
              <p className="font-sans text-[13px] text-ink pt-1">
                {change.kind === 'route'
                  ? 'Route changed between checks. The thumbnail shows the latest route.'
                  : 'Route or departure changed between checks. The thumbnail shows the latest route.'}
              </p>
            )}
          </div>
        </div>
        <Lifecycle
          checks={checks} latestId={latest.snapshot_id} departure={passage.departure_utc} departed={departed}
          hasPublishedCase={hasPublishedCase} localOnly={latest.local} onOpen={openSnapshot} disabled={loading}
          title={title} language={language} differing={change.differing}
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-2 border-t hairline">
          {draft === null && (
            <button
              ref={renameButton}
              type="button"
              onClick={() => setDraft(title)}
              aria-label={passageText('Rename {name}', name, language)}
              className="relative z-10 min-h-11 min-w-11 px-3 inline-flex items-center gap-2 border hairline rounded-sm font-sans text-sm text-ink hover:border-ink-soft"
              {...OWNED}
            >
              {passageText('Rename', {}, language)}
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={() => setConfirming(true)}
            aria-label={passageText('Delete {name}, departing {time}', { ...name, time: departure }, language)}
            className="relative z-10 min-h-11 min-w-11 px-3 inline-flex items-center gap-2 border hairline rounded-sm font-sans text-sm text-ink-soft hover:text-verdict-exceeds hover:border-verdict-exceeds"
            {...OWNED}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6l.7-9M6.5 6.5v4.5M9.5 6.5v4.5" />
            </svg>
            {passageText('Delete', {}, language)}
          </button>
        </div>
        {deleteError && <p role="alert" className="px-3 pb-3 font-sans text-sm text-verdict-exceeds break-words">{deleteError}</p>}
      </article>
      {confirming && (
        <ConfirmDialog
          heading={passageText('Delete "{name}"?', name, language)}
          headingProps={OWNED}
          confirmLabel={checks.length === 1 ? 'Delete briefing' : 'Delete passage'}
          cancelLabel="Cancel"
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        >
          <p>{passageText('Departing {time} local time ({tz}).', { time: departure, tz: localTimeZoneName() }, language)}</p>
          {checks.length > 1 && <p>{passageText('This will also delete its {count} saved checks.', { count: checks.length }, language)}</p>}
          <p className="font-medium">This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

/** Checks → departure → verification, as stations along one line (a column on phones). */
function Lifecycle({ checks, latestId, departure, departed, hasPublishedCase, localOnly, onOpen, disabled, title, language, differing }) {
  // long histories keep their first and last two checks
  const shown = checks.length > 4 ? [checks[0], null, ...checks.slice(-2)] : checks;
  return (
    <ol className="flex flex-col sm:flex-row sm:flex-wrap px-3 pb-2 pt-1" aria-label="Passage progress">
      {shown.map((check, index) => {
        if (!check) {
          return (
            <Station key={`more-${index}`} filled>
              <span {...OWNED}>{passageText('+{n} more checks', { n: checks.length - 3 }, language)}</span>
            </Station>
          );
        }
        const n = checks.indexOf(check) + 1;
        const made = localTime(check.created_at, language);
        const different = differing.get(check.snapshot_id);
        const label = passageText(
          different === 'route' ? 'Open check {n} of {name}, made {time}, on a different route'
            : different ? 'Open check {n} of {name}, made {time}, on a different route or departure'
              : 'Open check {n} of {name}, made {time}',
          { n, name: title, time: made }, language);
        return (
          <Station key={check.snapshot_id} filled current={check.snapshot_id === latestId}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onOpen(check.snapshot_id)}
              aria-label={label}
              className="relative z-10 min-h-11 min-w-11 text-left underline-offset-2 hover:underline pr-2"
              {...OWNED}
            >
              <span className="block">{passageText('Check {n}', { n }, language)}</span>
              <span className="block font-mono text-xs text-ink-soft">{made}</span>
            </button>
            {different && (
              <span data-route-differs className="block text-xs text-ink-soft">
                {different === 'route' ? 'Different route' : 'Different route or departure'}
              </span>
            )}
          </Station>
        );
      })}
      <Station filled={departed}>
        <span>Departure</span>
        <span className="block font-mono text-xs text-ink-soft">{fmtLocalTime(departure)}</span>
      </Station>
      <Station filled={hasPublishedCase} last>
        <span>{localOnly ? 'Local only' : hasPublishedCase ? 'Published case' : 'No published case'}</span>
      </Station>
    </ol>
  );
}

function Station({ filled, current, last, children }) {
  return (
    <li className={clsx('flex gap-3 sm:block sm:min-w-[7.5rem] sm:pr-3 font-sans text-xs', last && 'sm:min-w-0')}>
      <span className="flex flex-col items-center shrink-0 pt-[5px] sm:flex-row sm:h-5 sm:w-full sm:pt-0" aria-hidden>
        <span
          className={clsx('w-3.5 h-3.5 rounded-full border-2 shrink-0', current && 'ring-2 ring-event ring-offset-2 ring-offset-paper')}
          style={{ borderColor: current ? palette.event : palette.ink.DEFAULT, backgroundColor: filled ? (current ? palette.event : palette.ink.DEFAULT) : palette.paper.DEFAULT }}
        />
        {!last && <span className="flex-1 w-0 border-l border-ink/40 mt-1 sm:mt-0 sm:w-auto sm:border-l-0 sm:border-t sm:ml-1" />}
      </span>
      <span className={clsx('block min-w-0 pb-2 sm:pb-0 sm:mt-1 text-[13px] sm:text-xs', current && 'text-ink font-semibold', last && 'pb-0')}>{children}</span>
    </li>
  );
}

/** A thumbnail of the route on sea-wash: start filled, finish open. */
function RouteSketch({ route }) {
  const box = 'w-16 h-10 sm:w-40 sm:h-24 sm:row-span-2 shrink-0 border hairline rounded-sm';
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
