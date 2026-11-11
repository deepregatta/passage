import { palette } from '../lib/palette.js';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { frameForCursor, playbackHours, usePlayback } from '../stores/playbackStore.js';
import { chartUrl, chartProjector, nearestCaption } from '../lib/synopticCharts.js';
import { chartFocusPoints, chartStageStyle, PHASE_PLAIN, passageWindowMs, phaseCaption } from '../lib/synopticView.js';
import { governingCausalEvent } from '../lib/governing.js';
import { useElementSize } from '../lib/useElementSize.js';
import { placeLabel, plainEventNoun } from '../lib/format.js';
import { legLabel } from '../pages/briefing/routeLabels.jsx';
import { useGoverningReason } from '../pages/briefing/verdictSentence.js';
import TimeRuler from './TimeRuler.jsx';
import FullscreenChart from './FullscreenChart.jsx';

/** The pressure chart with the passage drawn on it. On the page the passage
 * timeline below drives time; full screen brings its own ruler and caption. */
export default function SynopticHero() {
  const findings = useApp((state) => state.findings);
  const synoptic = useApp((state) => state.synoptic);
  const route = useApp((state) => state.route);
  const selectEvidence = useApp((state) => state.selectEvidence);
  const cursor = usePlayback((state) => state.cursorHours);
  const focusedEventId = usePlayback((state) => state.focusedEventId);
  // the weather story card follows the same event (the one crossing the governing leg), so the first screen names one phase
  const reason = useGoverningReason(findings);
  const eventId = focusedEventId ?? governingCausalEvent(findings, reason)?.event_id ?? null;
  const [fullscreen, setFullscreen] = useState(false);
  const maxHours = playbackHours(findings);
  const frame = useMemo(() => frameForCursor(findings, synoptic, route, cursor, eventId), [findings, synoptic, route, cursor, eventId]);

  useEffect(() => {
    if (frame.focusedEvidenceId) selectEvidence(frame.focusedEvidenceId);
  }, [frame.focusedEvidenceId, selectEvidence]);

  if (!findings?.legs.length || !synoptic || !route?.waypoints?.length) {
    return <div className="min-h-[430px] border border-dashed border-ink/30 bg-shoal/20 grid place-items-center p-8 text-center"><div><p className="font-story text-2xl">Synoptic chart unavailable</p><p className="font-instrument text-sm text-ink-soft mt-2">{findings ? 'This legacy run has route conditions, but no archived synoptic data.' : 'Open a passage briefing first.'}</p></div></div>;
  }

  const canvas = (standalone) => <HeroCanvas findings={findings} synoptic={synoptic} route={route} frame={frame} cursor={cursor} maxHours={maxHours} standalone={standalone} />;
  return <>
    <div className="relative"><button type="button" onClick={() => setFullscreen(true)} className="absolute z-10 right-2 top-2 min-h-11 px-3 bg-paper/90 border border-ink/40 font-instrument text-xs">Full screen</button>{canvas(false)}</div>
    <FullscreenChart open={fullscreen} title="Causal briefing playback" onClose={() => setFullscreen(false)}>{canvas(true)}</FullscreenChart>
  </>;
}

function HeroCanvas({ findings, synoptic, route, frame, cursor, maxHours, standalone }) {
  const event = frame.event ?? null;
  const system = synoptic.systems.find((item) => item.system_id === event?.system_id) ?? synoptic.systems[0] ?? null;
  const chart = nearestCaption(synoptic.chart_captions, cursor);
  const [chartBroken, setChartBroken] = useState(false);
  const [framed, setFramed] = useState(true);
  const projector = chartBroken ? null : chartProjector(chart);
  const url = chartBroken ? null : chartUrl(chart?.file, findings.snapshot_id);

  return <div className={`chart-frame border border-ink/40 bg-shoal/30 p-3${standalone ? ' flex-1 flex flex-col' : ''}`}>
    {projector && url
      ? <ChartCanvas url={url} projector={projector} route={route} system={system} frame={frame} event={event} passageWindow={passageWindowMs(findings)} framed={framed} standalone={standalone} onBroken={() => setChartBroken(true)} caption={chart?.caption} />
      : <SchematicCanvas route={route} system={system} frame={frame} event={event} standalone={standalone} />}
    <Banner frame={frame} event={event} synoptic={synoptic} />
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-2 font-instrument text-xs">
      <span>
        {!event
          ? 'No tracked weather system meets your route in this window.'
          : standalone ? placeLabel(event.consequence.register_plain) : null}
      </span>
      <span className="flex flex-wrap items-center gap-2 sm:justify-end">
        <StatusChip findings={findings} synoptic={synoptic} frame={frame} event={event} />
        {projector && url && (
          <button type="button" onClick={() => setFramed(!framed)} className="min-h-11 px-3 border border-ink/40 whitespace-nowrap" aria-pressed={framed}>
            {framed ? 'Full chart' : 'Zoom to route'}
          </button>
        )}
      </span>
    </div>
    {standalone && <div className="pt-2"><TimeRuler findings={findings} maxHours={maxHours} /></div>}
  </div>;
}

/** overlay drawn in the PNG's own pixel space so positions are geographically true */
function Overlay({ w, xy, route, system, frame }) {
  const routePoints = route.waypoints.map(xy).map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const track = system?.track ?? [];
  const trackPoints = track.map(xy).map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const systemPoint = frame.systemPosition ? xy(frame.systemPosition) : null;
  const boatPoint = frame.boatPosition ? xy(frame.boatPosition) : null;
  const u = w / 340; // hairline unit relative to chart resolution
  return <>
    <polyline points={routePoints} fill="none" stroke={palette.ink.DEFAULT} strokeWidth={u * 1.4} strokeDasharray={`${u * 1.2} ${u * 2}`} strokeLinecap="round" />
    {track.length > 0 && <polyline points={trackPoints} fill="none" stroke={palette.event} strokeWidth={u * 1.6} />}
    {track.map((point) => { const p = xy(point); return <circle key={point.valid_time} cx={p.x} cy={p.y} r={u * 0.9} fill={palette.event} />; })}
    {systemPoint && <g transform={`translate(${systemPoint.x} ${systemPoint.y})`}>
      <circle r={u * 5} fill={palette.paper.DEFAULT} fillOpacity=".92" stroke={palette.event} strokeWidth={u * 1.1} />
      <text textAnchor="middle" y={u * 1.4} fontSize={u * 3.6} fill={palette.event} fontFamily="JetBrains Mono">{Math.round(frame.systemPosition.center_hpa)}</text>
    </g>}
    {boatPoint && <g transform={`translate(${boatPoint.x} ${boatPoint.y})`}>
      <path d={`M0 ${-u * 2.4} L${u * 2} ${u * 2.4} L0 ${u * 1.6} L${-u * 2} ${u * 2.4} Z`} fill={palette.verdict.approaching} stroke={palette.paper.DEFAULT} strokeWidth={u * 0.6} />
      <circle r={u * 3.6} fill="none" stroke={palette.verdict.approaching} strokeWidth={u * 0.55} />
    </g>}
  </>;
}

/** the real synoptic pressure chart with the story drawn on top of it. It opens
 * framed on the route and the system (the "Full chart" control shows the whole
 * chart); the image and overlay share one stage so route and isobars scale
 * together and stay aligned. */
function ChartCanvas({ url, projector, route, system, frame, event, passageWindow, framed, standalone, onBroken, caption }) {
  const [ref, size] = useElementSize();
  const image = { w: projector.w, h: projector.h };
  const stageStyle = chartStageStyle({ size, image, points: chartFocusPoints({ route, system, window: passageWindow }).map(projector.xy), framed });

  return <div ref={ref} className={`relative border border-ink/25 overflow-hidden bg-paper${standalone ? ' flex-1 min-h-[240px]' : ''}`} style={standalone ? undefined : { aspectRatio: `${image.w} / ${image.h}` }}>
    <div className="absolute left-0 top-0" style={stageStyle}>
      <img src={url} alt={caption ?? 'Synoptic pressure chart'} className="w-full h-full block" onError={onBroken} />
      <svg viewBox={`0 0 ${projector.w} ${projector.h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none" role="img" aria-label={`${event?.name ?? 'Synoptic'} track and route occupancy`}>
        <Overlay w={projector.w} xy={projector.xy} route={route} system={system} frame={frame} />
      </svg>
    </div>
  </div>;
}

/** fallback when a chart image or its geometry is missing: bounds-fit schematic */
function SchematicCanvas({ route, system, frame, event, standalone }) {
  const points = [...route.waypoints, ...(system?.track ?? [])];
  const lonMin = Math.min(...points.map((point) => point.lon)) - 1;
  const lonMax = Math.max(...points.map((point) => point.lon)) + 1;
  const latMin = Math.min(...points.map((point) => point.lat)) - .5;
  const latMax = Math.max(...points.map((point) => point.lat)) + .5;
  const xy = (point) => ({ x: 6 + ((point.lon - lonMin) / (lonMax - lonMin)) * 88, y: 7 + ((latMax - point.lat) / (latMax - latMin)) * 76 });
  return <div className={`relative overflow-hidden border border-ink/25 ${standalone ? 'flex-1 min-h-[240px]' : 'min-h-[360px]'}`} style={{ background: palette.sea }}>
    <svg viewBox="0 0 100 90" className="absolute inset-0 w-full h-full" role="img" aria-label={`${event?.name ?? 'Synoptic'} track and route occupancy`}>
      <defs><pattern id="sea-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke={palette.wave} strokeOpacity=".12" strokeWidth=".2"/></pattern></defs>
      <rect width="100" height="90" fill="url(#sea-grid)"/>
      <Overlay w={100} xy={xy} route={route} system={system} frame={frame} />
    </svg>
  </div>;
}

/** The system named in plain words ("low-pressure system", "deepening low"); the engine's ids stay out of the page. */
const systemNoun = (event, synoptic) => plainEventNoun(event, synoptic).replace(/^an? /, '');

/** Static block under the chart, never over it: it cannot cover the chart's own
 * caption, and on a phone it takes no chart area. The phase words are the weather story's. */
function Banner({ frame, event, synoptic }) {
  return <div className="mt-2 bg-paper/90 border-l-4 border-event px-3 py-2"><p data-testid="hero-phase" className="font-instrument text-xs uppercase tracking-[0.18em] text-ink-soft">{event ? `${PHASE_PLAIN[frame.phase]} · ${systemNoun(event, synoptic)}` : 'synoptic situation'}</p><p className="font-story text-lg leading-tight">{phaseCaption(frame.phase)}</p></div>;
}

function StatusChip({ findings, synoptic, frame, event }) {
  const where = frame.activeLegId ? ` · boat ${legLabel(findings, frame.activeLegId)}` : '';
  return <span className="font-mono text-xs">{`${event?.system_id ? systemNoun(event, synoptic) : 'no attributed system'}${where}`}</span>;
}
