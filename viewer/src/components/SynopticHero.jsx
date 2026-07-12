import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { frameForCursor, usePlayback } from '../stores/playbackStore.js';
import TimeRuler from './TimeRuler.jsx';
import FullscreenChart from './FullscreenChart.jsx';

const PHASE = {
  cause: 'The system is organizing west of the passage.',
  interception: 'The low and the boat occupy the same route window.',
  consequence: 'The system has crossed; the strongest route consequence is active.',
  easing: 'The low moves clear and the passage begins to ease.',
  unavailable: 'Causal playback is unavailable for this run.',
};

export default function SynopticHero() {
  const findings = useApp((state) => state.findings);
  const synoptic = useApp((state) => state.synoptic);
  const route = useApp((state) => state.route);
  const selectEvidence = useApp((state) => state.selectEvidence);
  const cursor = usePlayback((state) => state.cursorHours);
  const eventId = usePlayback((state) => state.focusedEventId);
  const departureVariant = usePlayback((state) => state.departureVariant);
  const setDepartureVariant = usePlayback((state) => state.setDepartureVariant);
  const [fullscreen, setFullscreen] = useState(false);
  const maxHours = findings ? Math.ceil((Date.parse(findings.legs.at(-1).eta_range.slow) - Date.parse(findings.departure_utc)) / 3600_000) : 36;
  const frame = useMemo(() => frameForCursor(findings, synoptic, route, cursor, eventId), [findings, synoptic, route, cursor, eventId]);

  useEffect(() => {
    if (frame.focusedEvidenceId) selectEvidence(frame.focusedEvidenceId);
  }, [frame.focusedEvidenceId, selectEvidence]);

  if (!findings || !synoptic || !route || !findings.causal_events?.length) {
    return <div className="min-h-[430px] border border-dashed border-ink/30 bg-shoal/20 grid place-items-center p-8 text-center"><div><p className="font-story text-2xl">Causal attribution unavailable</p><p className="font-instrument text-sm text-ink-soft mt-2">{findings ? 'This legacy run has route conditions, but no archived system track.' : 'Open a passage briefing first.'}</p></div></div>;
  }

  const content = <HeroCanvas findings={findings} synoptic={synoptic} route={route} frame={frame} maxHours={maxHours} departureVariant={departureVariant} setDepartureVariant={setDepartureVariant} />;
  return <>
    <div className="relative"><button type="button" onClick={() => setFullscreen(true)} className="absolute z-10 right-2 top-2 min-h-11 px-3 bg-paper/90 border border-ink/40 font-instrument text-xs">Full screen</button>{content}</div>
    <FullscreenChart open={fullscreen} title="Causal briefing playback" onClose={() => setFullscreen(false)}>{content}</FullscreenChart>
  </>;
}

function HeroCanvas({ findings, synoptic, route, frame, maxHours, departureVariant, setDepartureVariant }) {
  const event = frame.event;
  const system = synoptic.systems.find((item) => item.system_id === event.system_id) ?? synoptic.systems[0];
  const points = [...route.waypoints, ...system.track];
  const lonMin = Math.min(...points.map((point) => point.lon)) - 1;
  const lonMax = Math.max(...points.map((point) => point.lon)) + 1;
  const latMin = Math.min(...points.map((point) => point.lat)) - .5;
  const latMax = Math.max(...points.map((point) => point.lat)) + .5;
  const xy = (point) => ({ x: 6 + ((point.lon - lonMin) / (lonMax - lonMin)) * 88, y: 7 + ((latMax - point.lat) / (latMax - latMin)) * 76 });
  const routePoints = route.waypoints.map(xy).map((point) => `${point.x},${point.y}`).join(' ');
  const trackPoints = system.track.map(xy).map((point) => `${point.x},${point.y}`).join(' ');
  const systemPoint = frame.systemPosition ? xy(frame.systemPosition) : null;
  const boatPoint = frame.boatPosition ? xy(frame.boatPosition) : null;
  const chart = synoptic.chart_captions?.reduce((best, item) => Math.abs((item.step_h ?? 0) - usePlayback.getState().cursorHours) < Math.abs((best?.step_h ?? 0) - usePlayback.getState().cursorHours) ? item : best, synoptic.chart_captions[0]);
  const chartUrl = chart?.file ? `/data/snapshots/${findings.snapshot_id}/${chart.file}` : null;
  return <div className="chart-frame border border-ink/40 bg-shoal/30 p-3">
    <div className="relative min-h-[360px] overflow-hidden bg-[#cbdce0] border border-ink/25">
      {chartUrl && <img src={chartUrl} alt="Synoptic pressure chart" className="absolute inset-0 w-full h-full object-cover opacity-20 mix-blend-multiply" />}
      <svg viewBox="0 0 100 90" className="absolute inset-0 w-full h-full" role="img" aria-label={`${event.name} track and route occupancy`}>
        <defs><pattern id="sea-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#52739e" strokeOpacity=".12" strokeWidth=".2"/></pattern></defs>
        <rect width="100" height="90" fill="url(#sea-grid)"/>
        {departureVariant === 'alternative' && <polyline points={routePoints} fill="none" stroke="#176B87" strokeOpacity=".35" strokeWidth="2" strokeDasharray="2 2" transform="translate(0 -2)"/>}
        <polyline points={routePoints} fill="none" stroke="#16283E" strokeWidth="1.15" strokeDasharray="1 1.8"/>
        <polyline points={trackPoints} fill="none" stroke="#176B87" strokeWidth="1.4"/>
        {system.track.map((point) => { const p = xy(point); return <circle key={point.valid_time} cx={p.x} cy={p.y} r=".7" fill="#176B87"/>; })}
        {systemPoint && <g transform={`translate(${systemPoint.x} ${systemPoint.y})`}><circle r="4.3" fill="#F3EEE3" stroke="#176B87" strokeWidth="1"/><text textAnchor="middle" y="1.2" fontSize="3.2" fill="#176B87" fontFamily="JetBrains Mono">{Math.round(frame.systemPosition.center_hpa)}</text></g>}
        {boatPoint && <g transform={`translate(${boatPoint.x} ${boatPoint.y})`}><path d="M0 -2 L1.7 2 L0 1.3 L-1.7 2 Z" fill="#A87718" stroke="#F3EEE3" strokeWidth=".5"/><circle r="3" fill="none" stroke="#A87718" strokeWidth=".45"/></g>}
      </svg>
      <div className="absolute left-3 top-3 max-w-[70%] bg-paper/90 border-l-4 border-event px-3 py-2"><p className="eyebrow">{frame.phase} · {event.name}</p><p className="font-story text-lg leading-tight">{PHASE[frame.phase]}</p></div>
      <div className="absolute right-3 bottom-3 bg-paper/90 px-2 py-1 font-mono text-[9px]">system {event.system_id} · boat {frame.activeLegId}</div>
    </div>
    <div className="flex items-center justify-between gap-3 py-2 font-instrument text-xs"><span>{event.consequence.register_plain}</span><button type="button" onClick={() => setDepartureVariant(departureVariant === 'alternative' ? 'nominal' : 'alternative')} className="min-h-11 px-3 border border-event text-event whitespace-nowrap">{departureVariant === 'alternative' ? 'Hide safer departure' : 'Compare safer departure'}</button></div>
    <TimeRuler findings={findings} maxHours={maxHours} />
  </div>;
}
