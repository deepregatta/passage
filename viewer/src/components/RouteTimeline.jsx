import ReactECharts from './lazy/EChartsLazy.jsx';
import { useMemo, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { STATUS_HEX, hourStatus, fmtHour } from '../lib/format.js';
import { usePlayback } from '../stores/playbackStore.js';
import useViewport from '../hooks/useViewport.js';

/**
 * Passage timeline. Default = one glanceable condition strip (worst status per
 * hour vs your limits); the three labeled charts (wind / gust / waves) live
 * behind "Show detailed charts".
 */
export default function RouteTimeline() {
  const findings = useApp((s) => s.findings);
  const cursor = usePlayback((state) => state.cursorHours);
  const mobile = useViewport();
  const [detailed, setDetailed] = useState(false);
  const option = useMemo(
    () => (findings && detailed ? buildOption(findings, cursor, mobile) : null),
    [findings, cursor, mobile, detailed],
  );
  if (!findings) return null;
  return (
    <div>
      <ConditionStrip findings={findings} cursor={cursor} />
      <button
        type="button"
        onClick={() => setDetailed(!detailed)}
        aria-expanded={detailed}
        className="mt-2 font-sans text-[13px] text-ink-soft hover:text-ink underline underline-offset-2 min-h-11"
      >
        {detailed ? 'Hide detailed charts ▴' : 'Show wind, gust and wave charts ▾'}
      </button>
      {detailed && option && (
        <>
          <ReactECharts option={option} style={{ height: 330 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
          <div className="flex gap-5 justify-end font-sans text-[11px] text-ink-soft pr-2 -mt-1">
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ background: 'rgba(168,119,24,0.35)' }} />
              close to your limits
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ background: 'rgba(166,59,42,0.35)' }} />
              beyond your limits
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed inline-block" style={{ borderColor: '#A87718' }} />
              the limit you set
            </span>
          </div>
        </>
      )}
      <TimelineTable findings={findings} />
    </div>
  );
}

const STRIP_LABEL = { ok: 'fine', approaching: 'close to your limits', exceeded: 'beyond your limits', unknown: 'not assessed' };

/** One glanceable bar: each stretch of the passage colored by its worst condition status. */
function ConditionStrip({ findings, cursor }) {
  const rows = collectRows(findings);
  if (!rows.length) return null;
  const t0 = rows[0].t;
  const t1 = rows[rows.length - 1].t + 3600_000;
  const pct = (t) => Math.min(100, Math.max(0, ((t - t0) / (t1 - t0)) * 100));

  const merged = [];
  for (const r of rows) {
    const status = hourStatus(r.hour);
    const last = merged[merged.length - 1];
    if (last && last.status === status) last.to = r.t + 3600_000;
    else merged.push({ from: r.t, to: r.t + 3600_000, status });
  }

  // one flag per event kind, max 3
  const seen = new Set();
  const flags = [];
  for (const ev of findings.events ?? []) {
    const label = EVENT_LABEL[ev.kind];
    if (!label || seen.has(ev.kind) || !ev.window?.from) continue;
    seen.add(ev.kind);
    if (flags.length >= 3) break;
    flags.push({ label, at: Date.parse(ev.window.from) });
  }

  const cursorTime = Date.parse(findings.departure_utc) + cursor * 3600_000;
  const ticks = [];
  for (let t = Math.ceil(t0 / (6 * 3600_000)) * 6 * 3600_000; t < t1; t += 6 * 3600_000) ticks.push(t);
  const summary = merged
    .map((m) => `${fmtHour(new Date(m.from).toISOString())}–${fmtHour(new Date(m.to).toISOString())} ${STRIP_LABEL[m.status]}`)
    .join('; ');

  return (
    <div className="mt-3" data-testid="condition-strip">
      <div className={flags.length ? 'relative h-6' : 'hidden'}>
        {flags.map((f, i) => (
          <span
            key={f.label}
            className="absolute -translate-x-1/2 font-sans text-[10px] text-paper px-1.5 py-0.5 rounded-sm whitespace-nowrap"
            style={{ left: `${Math.min(94, Math.max(4, pct(f.at)))}%`, backgroundColor: '#A87718', top: i % 2 ? 2 : 0 }}
          >
            {f.label}
          </span>
        ))}
      </div>
      <div className="relative h-7 rounded-sm overflow-hidden border hairline" role="img" aria-label={`Conditions along your route: ${summary}`}>
        {merged.map((m) => (
          <div
            key={m.from}
            className="absolute top-0 bottom-0"
            style={{
              left: `${pct(m.from)}%`,
              width: `${pct(m.to) - pct(m.from)}%`,
              backgroundColor: STATUS_HEX[m.status],
              opacity: m.status === 'ok' ? 0.45 : 0.8,
            }}
          />
        ))}
        {cursorTime >= t0 && cursorTime <= t1 && (
          <div className="absolute top-0 bottom-0 w-[2px]" style={{ left: `${pct(cursorTime)}%`, backgroundColor: '#176B87' }} aria-hidden />
        )}
      </div>
      <div className="relative h-4" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2 font-mono text-[10px] text-ink-soft" style={{ left: `${pct(t)}%` }}>
            {fmtHour(new Date(t).toISOString())}
          </span>
        ))}
      </div>
      <div className="flex gap-5 justify-end font-sans text-[11px] text-ink-soft pr-2">
        {['ok', 'approaching', 'exceeded'].map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className="w-3.5 h-2.5 inline-block rounded-[2px]"
              style={{ backgroundColor: STATUS_HEX[s], opacity: s === 'ok' ? 0.45 : 0.8 }}
            />
            {STRIP_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function TimelineTable({ findings }) {
  const rows = findings.legs.flatMap((leg) => leg.hours.filter((_, index) => index % 3 === 0).map((hour) => ({ leg: leg.leg_id, ...hour })));
  return <details className="mt-3 border-t hairline pt-2"><summary className="font-instrument text-xs cursor-pointer">Table alternative for route timeline</summary><div className="overflow-x-auto max-h-64 mt-2"><table className="w-full font-mono text-[10px]"><thead><tr className="text-left"><th>UTC</th><th>leg</th><th>wind kt</th><th>gust kt</th><th>waves m</th><th>status</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.leg}-${row.valid_time}`} className="border-t hairline"><td className="py-1">{fmtHour(row.valid_time)}</td><td>{row.leg}</td><td>{row.wind_kt ?? 'n/a'}</td><td>{row.gust_kt ?? 'n/a'}</td><td>{row.waves?.hs_m ?? 'not assessed'}</td><td>{hourStatus(row)}</td></tr>)}</tbody></table></div></details>;
}

const EVENT_LABEL = {
  wind_against_current: 'wind over tide',
  gate_conflict: 'gate closed',
  gate_marginal: 'gate tight',
  official_warning: 'warning',
  model_divergence: 'models split',
  squall_potential: 'squalls?',
};

/** hours inside each leg's nominal occupancy window, time-sorted */
function collectRows(findings) {
  const rows = [];
  for (const leg of findings.legs) {
    const enter = Date.parse(leg.enter_range.nominal);
    const exit = Date.parse(leg.eta_range.nominal);
    for (const hour of leg.hours) {
      const t = Date.parse(hour.valid_time);
      if (t >= enter - 1800_000 && t <= exit + 1800_000) rows.push({ t, hour });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

function buildOption(findings, cursorHours = 0, mobile = false) {
  const rows = collectRows(findings);

  const gustLimit = findings.evidence.find(
    (e) => e.rule_id === 'W-GUST-01' || e.rule_id === 'W-GUST-03',
  )?.limit;
  const cursorTime = Date.parse(findings.departure_utc) + cursorHours * 3600_000;

  const wind = rows.map((r) => [r.t, r.hour.wind_kt]);
  const gust = rows.map((r) => [r.t, r.hour.gust_kt]);
  const hs = rows.map((r) => [r.t, r.hour.waves?.hs_m ?? null]);

  // status bands (approaching amber / exceeded red)
  const bands = [];
  let bandStart = null;
  let bandStatus = null;
  for (const r of rows) {
    const s = hourStatus(r.hour);
    const active = s === 'approaching' || s === 'exceeded' ? s : null;
    if (active !== bandStatus) {
      if (bandStatus) bands.push({ from: bandStart, to: r.t, status: bandStatus });
      bandStart = r.t;
      bandStatus = active;
    }
  }
  if (bandStatus && rows.length) bands.push({ from: bandStart, to: rows[rows.length - 1].t, status: bandStatus });
  const bandAreas = bands.map((b) => [
    {
      xAxis: b.from,
      itemStyle: { color: b.status === 'exceeded' ? 'rgba(166,59,42,0.13)' : 'rgba(168,119,24,0.13)' },
    },
    { xAxis: b.to },
  ]);

  // event flags on the gust row (one per kind, first occurrence, max 3, staggered
  // vertically so clustered events don't overlap)
  const seenKinds = new Set();
  const flags = [];
  for (const ev of findings.events ?? []) {
    const label = EVENT_LABEL[ev.kind];
    if (!label || seenKinds.has(ev.kind) || !ev.window?.from) continue;
    seenKinds.add(ev.kind);
    if (flags.length >= 3) break;
    flags.push({
      name: label,
      xAxis: Date.parse(ev.window.from),
      yAxis: (gustLimit ?? 30) - flags.length * 9,
      label: {
        formatter: label,
        position: flags.length % 2 === 0 ? 'top' : 'right',
        color: '#F3EEE3',
        backgroundColor: '#A87718',
        padding: [2, 5],
        borderRadius: 2,
        fontFamily: 'system-ui',
        fontSize: 10,
      },
      itemStyle: { color: '#A87718' },
    });
  }

  const ink = '#16283E';
  const soft = '#4C5D73';
  const axisBase = {
    axisLine: { lineStyle: { color: 'rgba(22,40,62,0.25)' } },
    axisTick: { show: false },
    axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
    splitLine: { lineStyle: { color: 'rgba(22,40,62,0.07)' } },
  };
  const rowName = (name, sub) => ({
    name: `${name}\n${sub}`,
    nameLocation: 'end',
    nameTextStyle: {
      color: ink,
      fontFamily: 'system-ui',
      fontSize: 11,
      fontWeight: 600,
      align: 'right',
      padding: [0, 6, 0, 0],
      lineHeight: 14,
    },
  });

  const GRID_L = mobile ? 44 : 88;
  const GRID_R = mobile ? 34 : 96;

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#F3EEE3',
      borderColor: ink,
      textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      valueFormatter: (v) => (v == null ? 'n/a' : String(v)),
    },
    grid: [
      { left: GRID_L, right: GRID_R, top: 18, height: 78 },
      { left: GRID_L, right: GRID_R, top: 112, height: 78 },
      { left: GRID_L, right: GRID_R, top: 206, height: 58 },
    ],
    xAxis: [0, 1, 2].map((i) => ({
      type: 'time',
      gridIndex: i,
      ...axisBase,
      axisLabel:
        i === 2
          ? { ...axisBase.axisLabel, formatter: (v) => fmtHour(new Date(v).toISOString()) }
          : { show: false },
    })),
    yAxis: [
      { type: 'value', gridIndex: 0, ...axisBase, ...rowName('Wind', mobile ? 'kt' : 'knots') },
      { type: 'value', gridIndex: 1, ...axisBase, ...rowName('Gusts', mobile ? 'kt' : 'knots') },
      { type: 'value', gridIndex: 2, ...axisBase, ...rowName('Waves', mobile ? 'm' : 'metres') },
    ],
    series: [
      {
        name: 'wind',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: wind,
        showSymbol: false,
        lineStyle: { color: ink, width: 2 },
        markArea: bandAreas.length ? { silent: true, data: bandAreas } : undefined,
      },
      {
        name: 'gusts',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: gust,
        showSymbol: false,
        lineStyle: { color: '#A63B2A', width: 2 },
        markArea: bandAreas.length ? { silent: true, data: bandAreas } : undefined,
        markLine: gustLimit
          ? {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: gustLimit }, { xAxis: cursorTime, label: { formatter: 'NOW', color: '#176B87' }, lineStyle: { color: '#176B87', type: 'solid', width: 1 } }],
              lineStyle: { color: '#A87718', type: 'dashed', width: 1.6 },
              label: {
                formatter: `${gustLimit} kt\nyour limit`,
                position: 'end',
                color: '#A87718',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 10,
                lineHeight: 13,
              },
            }
          : undefined,
        markPoint: flags.length
          ? { symbol: 'pin', symbolSize: 18, data: flags, silent: true }
          : undefined,
      },
      {
        name: 'waves',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: hs,
        showSymbol: false,
        areaStyle: { color: 'rgba(76,93,115,0.18)' },
        lineStyle: { color: soft, width: 1.6 },
      },
    ],
  };
}
