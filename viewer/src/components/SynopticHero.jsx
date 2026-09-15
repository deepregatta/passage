import { palette } from '../lib/palette.js';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { frameForCursor, usePlayback } from '../stores/playbackStore.js';
import { chartUrl, chartProjector, nearestCaption } from '../lib/synopticCharts.js';
import { placeLabel } from '../lib/format.js';
import TimeRuler from './TimeRuler.jsx';
import FullscreenChart from './FullscreenChart.jsx';

const PHASE = {
  cause: 'The system is organizing west of the passage.',
  interception: 'The low and the boat occupy the same route window.',
  consequence: 'The system has crossed. Its strongest effect on your route is active.',
  easing: 'The low moves clear and the passage begins to ease.',
  unavailable: 'No tracked system crosses your route window. The wider pattern still sets your wind.',
};

export default function SynopticHero() {
  const findings = useApp((state) => state.findings);
  const synoptic = useApp((state) => state.synoptic);
  const route = useApp((state) => state.route);
  const selectEvidence = useApp((state) => state.selectEvidence);
  const cursor = usePlayback((state) => state.cursorHours);
  const eventId = usePlayback((state) => state.focusedEventId);
  const [fullscreen, setFullscreen] = useState(false);
  const arrival = findings?.legs.at(-1)?.eta_range.slow;
  const maxHours = arrival ? Math.ceil((Date.parse(arrival) - Date.parse(findings.departure_utc)) / 3600_000) : 36;
  const frame = useMemo(() => frameForCursor(findings, synoptic, route, cursor, eventId), [findings, synoptic, route, cursor, eventId]);

  useEffect(() => {
    if (frame.focusedEvidenceId) selectEvidence(frame.focusedEvidenceId);
  }, [frame.focusedEvidenceId, selectEvidence]);

  if (!findings?.legs.length || !synoptic || !route?.waypoints?.length) {
    return <div className="min-h-[430px] border border-dashed border-ink/30 bg-shoal/20 grid place-items-center p-8 text-center"><div><p className="font-story text-2xl">Synoptic chart unavailable</p><p className="font-instrument text-sm text-ink-soft mt-2">{findings ? 'This legacy run has route conditions, but no archived synoptic data.' : 'Open a passage briefing first.'}</p></div></div>;
  }

  const content = <HeroCanvas findings={findings} synoptic={synoptic} route={route} frame={frame} cursor={cursor} maxHours={maxHours} />;
  return <>
    <div className="relative"><button type="button" onClick={() => setFullscreen(true)} className="absolute z-10 right-2 top-2 min-h-11 px-3 bg-paper/90 border border-ink/40 font-instrument text-xs">Full screen</button>{content}</div>
    <FullscreenChart open={fullscreen} title="Causal briefing playback" onClose={() => setFullscreen(false)}>{content}</FullscreenChart>
  </>;
}

function HeroCanvas({ findings, synoptic, route, frame, cursor, maxHours }) {
  const event = frame.event ?? null;
  const system = synoptic.systems.find((item) => item.system_id === event?.system_id) ?? synoptic.systems[0] ?? null;
  const chart = nearestCaption(synoptic.chart_captions, cursor);
  const [chartBroken, setChartBroken] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const projector = chartBroken ? null : chartProjector(chart);
  const url = chartBroken ? null : chartUrl(chart?.file, findings.snapshot_id);

  return <div className="chart-frame border border-ink/40 bg-shoal/30 p-3">
    {projector && url
      ? <ChartCanvas url={url} projector={projector} route={route} system={system} frame={frame} event={event} zoomed={zoomed} onBroken={() => setChartBroken(true)} caption={chart?.caption} />
      : <SchematicCanvas route={route} system={system} frame={frame} event={event} />}
    <div className="flex items-center justify-between gap-3 py-2 font-instrument text-xs">
      <span>
        {event
          ? placeLabel(event.consequence.register_plain)
          : 'No tracked weather system meets your route in this window.'}
      </span>
      <span className="flex gap-2 whitespace-nowrap">
        {projector && url && (
          <button type="button" onClick={() => setZoomed(!zoomed)} className="min-h-11 px-3 border border-ink/40" aria-pressed={zoomed}>
            {zoomed ? 'Full chart' : 'Zoom to route'}
          </button>
        )}
      </span>
    </div>
    <TimeRuler findings={findings} maxHours={maxHours} />
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

/** the real synoptic pressure chart with the story drawn on top of it */
function ChartCanvas({ url, projector, route, system, frame, event, zoomed, onBroken, caption }) {
  // zoom about the route's center in the chart's own pixel space; the overlay
  // shares the wrapper so route and isobars scale together and stay aligned
  const points = route.waypoints.map(projector.xy);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const originX = ((Math.min(...xs) + Math.max(...xs)) / 2 / projector.w) * 100;
  const originY = ((Math.min(...ys) + Math.max(...ys)) / 2 / projector.h) * 100;
  const span = Math.max(
    (Math.max(...xs) - Math.min(...xs)) / projector.w,
    (Math.max(...ys) - Math.min(...ys)) / projector.h,
    0.08,
  );
  const scale = zoomed ? Math.min(5, Math.max(2, 0.45 / span)) : 1;

  return <div className="relative border border-ink/25 overflow-hidden bg-paper">
    <div style={{ transform: `scale(${scale})`, transformOrigin: `${originX}% ${originY}%`, transition: 'transform .35s ease' }}>
      <img src={url} alt={caption ?? 'Synoptic pressure chart'} className="w-full block" onError={onBroken} />
      <svg viewBox={`0 0 ${projector.w} ${projector.h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none" role="img" aria-label={`${event?.name ?? 'Synoptic'} track and route occupancy`}>
        <Overlay w={projector.w} xy={projector.xy} route={route} system={system} frame={frame} />
      </svg>
    </div>
    <Banner frame={frame} event={event} />
    <StatusChip frame={frame} event={event} />
  </div>;
}

/** fallback when a chart image or its geometry is missing: bounds-fit schematic */
function SchematicCanvas({ route, system, frame, event }) {
  const points = [...route.waypoints, ...(system?.track ?? [])];
  const lonMin = Math.min(...points.map((point) => point.lon)) - 1;
  const lonMax = Math.max(...points.map((point) => point.lon)) + 1;
  const latMin = Math.min(...points.map((point) => point.lat)) - .5;
  const latMax = Math.max(...points.map((point) => point.lat)) + .5;
  const xy = (point) => ({ x: 6 + ((point.lon - lonMin) / (lonMax - lonMin)) * 88, y: 7 + ((latMax - point.lat) / (latMax - latMin)) * 76 });
  return <div className="relative min-h-[360px] overflow-hidden border border-ink/25" style={{ background: palette.sea }}>
    <svg viewBox="0 0 100 90" className="absolute inset-0 w-full h-full" role="img" aria-label={`${event?.name ?? 'Synoptic'} track and route occupancy`}>
      <defs><pattern id="sea-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke={palette.wave} strokeOpacity=".12" strokeWidth=".2"/></pattern></defs>
      <rect width="100" height="90" fill="url(#sea-grid)"/>
      <Overlay w={100} xy={xy} route={route} system={system} frame={frame} />
    </svg>
    <Banner frame={frame} event={event} />
    <StatusChip frame={frame} event={event} />
  </div>;
}

function Banner({ frame, event }) {
  return <div className="absolute left-3 top-3 max-w-[70%] bg-paper/90 border-l-4 border-event px-3 py-2"><p className="eyebrow">{event ? `${frame.phase} · ${event.name}` : 'synoptic situation'}</p><p className="font-story text-lg leading-tight">{PHASE[frame.phase]}</p></div>;
}

function StatusChip({ frame, event }) {
  return <div className="absolute right-3 bottom-3 bg-paper/90 px-2 py-1 font-mono text-[9px]">{event?.system_id ? `system ${event.system_id}` : 'no attributed system'} · boat {frame.activeLegId}</div>;
}
