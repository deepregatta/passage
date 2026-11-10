import { hourStatus, STATUS_HEX } from '../../lib/format.js';
import { routeTitle } from './routeLabels.jsx';
import { useElementSize } from '../../lib/useElementSize.js';
import { spreadMarkers } from '../../lib/ruler.js';

/** leg progress bar: numbered dots on a line, distances + durations beneath (mockup 1) */
export default function LegProgressBar({ findings }) {
  const [barRef, barSize] = useElementSize();
  const width = barSize?.w ?? 320; // jsdom / first paint: assume a phone-width bar
  const rank = { ok: 0, unknown: 0, approaching: 1, exceeded: 2 };
  const total = findings.legs.reduce((s, l) => s + l.distance_nm, 0);
  let cum = 0;
  const dots = findings.legs.map((leg, i) => {
    cum += leg.distance_nm;
    let worst = 'ok';
    for (const hour of leg.hours) {
      const s = hourStatus(hour);
      if (rank[s] > rank[worst]) worst = s;
    }
    const durH = (Date.parse(leg.eta_range.nominal) - Date.parse(leg.enter_range.nominal)) / 3600000;
    return {
      leg,
      i,
      pct: (cum / total) * 100,
      midPct: ((cum - leg.distance_nm / 2) / total) * 100,
      color: STATUS_HEX[worst],
      durH,
    };
  });
  // 22px markers never touch (28px apart at least); a label that would touch its neighbour drops to a second row
  const spread = spreadMarkers(dots.map((d) => d.pct), (28 / width) * 100);
  const labelPct = (44 / width) * 100;
  let staggered = false;
  dots.forEach((d, i) => {
    const prev = i ? spread[i - 1] : 0;
    d.pos = spread[i];
    d.labelPct = (prev + spread[i]) / 2;
    if (spread[i] - prev < labelPct) staggered = true;
  });
  const [from, to] = routeTitle(findings).split('→').map((s) => s.trim());

  return (
    <div className="mt-4 px-4" aria-label="Legs">
      <div ref={barRef} className="relative h-5">
        <div className="absolute left-0 right-0 top-2 border-t-2 border-ink/50" />
        <div className="absolute -left-1 top-0.5 w-3.5 h-3.5 rounded-full bg-ink border-2 border-paper shadow" />
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${d.pos}%` }}
          >
            <div
              className="w-[22px] h-[22px] -mt-0.5 rounded-full text-paper font-sans font-semibold text-xs flex items-center justify-center border-2 border-paper"
              style={{ backgroundColor: d.color, boxShadow: `0 0 0 1.5px ${d.color}` }}
            >
              {d.i + 1}
            </div>
          </div>
        ))}
      </div>
      <div className={`relative ${staggered ? 'h-[72px]' : 'h-9'}`}>
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute -translate-x-1/2 text-center whitespace-nowrap font-mono text-xs text-ink-soft leading-tight pt-1"
            style={{ left: `${d.labelPct}%`, top: staggered && d.i % 2 ? 36 : 0 }}
          >
            {Math.round(d.leg.distance_nm)} NM
            <br />
            {Math.floor(d.durH)}h{String(Math.round((d.durH % 1) * 60)).padStart(2, '0')}
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-4 font-sans font-medium text-[12px]">
        <span>{from}</span>
        <span className="text-right">{to}</span>
      </div>
    </div>
  );
}
