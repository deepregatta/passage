import { hourStatus, STATUS_HEX } from '../../lib/format.js';
import { routeTitle } from './routeLabels.jsx';

/** leg progress bar: numbered dots on a line, distances + durations beneath (mockup 1) */
export default function LegProgressBar({ findings }) {
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
  const [from, to] = routeTitle(findings).split('→').map((s) => s.trim());

  return (
    <div className="mt-4 px-2" aria-label="Legs">
      <div className="relative h-5">
        <div className="absolute left-0 right-0 top-2 border-t-2 border-ink/50" />
        <div className="absolute -left-1 top-0.5 w-3.5 h-3.5 rounded-full bg-ink border-2 border-paper shadow" />
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${d.pct}%` }}
          >
            <div
              className="w-[22px] h-[22px] -mt-0.5 rounded-full text-paper font-sans font-semibold text-[11px] flex items-center justify-center border-2 border-paper"
              style={{ backgroundColor: d.color, boxShadow: `0 0 0 1.5px ${d.color}` }}
            >
              {d.i + 1}
            </div>
          </div>
        ))}
      </div>
      <div className="relative h-9">
        <span className="absolute left-0 font-sans font-medium text-[12px]">{from}</span>
        <span className="absolute right-0 font-sans font-medium text-[12px] text-right">{to}</span>
        {dots.map((d) => (
          <div
            key={d.leg.leg_id}
            className="absolute -translate-x-1/2 text-center font-mono text-[10px] text-ink-soft leading-tight pt-1"
            style={{ left: `${d.midPct}%` }}
          >
            {Math.round(d.leg.distance_nm)} NM
            <br />
            {Math.floor(d.durH)}h{String(Math.round((d.durH % 1) * 60)).padStart(2, '0')}
          </div>
        ))}
      </div>
    </div>
  );
}
