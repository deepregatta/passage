import ReactECharts from './lazy/EChartsLazy.jsx';
import { useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import { STATUS_HEX, hourStatus, fmtHour } from '../lib/format.js';
import { usePlayback } from '../stores/playbackStore.js';

/**
 * Passage timeline, mockup style: three labeled rows (wind / gust / waves),
 * limit line labeled at the right, amber/red status bands, event flags.
 */
export default function RouteTimeline() {
  const findings = useApp((s) => s.findings);
  const cursor = usePlayback((state) => state.cursorHours);
  const option = useMemo(() => (findings ? buildOption(findings, cursor) : null), [findings, cursor]);
  if (!option) return null;
  return (
    <div>
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
      <TimelineTable findings={findings} />
    </div>
  );
}

function TimelineTable({ findings }) {
  const rows = findings.legs.flatMap((leg) => leg.hours.filter((_, index) => index % 3 === 0).map((hour) => ({ leg: leg.leg_id, ...hour })));
  return <details className="mt-3 border-t hairline pt-2"><summary className="font-instrument text-xs cursor-pointer">Table alternative for route timeline</summary><div className="overflow-x-auto max-h-64 mt-2"><table className="w-full font-mono text-[10px]"><thead><tr className="text-left"><th>UTC</th><th>leg</th><th>wind kt</th><th>gust kt</th><th>waves m</th><th>status</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.leg}-${row.valid_time}`} className="border-t hairline"><td className="py-1">{fmtHour(row.valid_time)}</td><td>{row.leg}</td><td>{row.wind_kt ?? '—'}</td><td>{row.gust_kt ?? '—'}</td><td>{row.waves?.hs_m ?? 'not assessed'}</td><td>{hourStatus(row)}</td></tr>)}</tbody></table></div></details>;
}

const EVENT_LABEL = {
  wind_against_current: 'wind over tide',
  gate_conflict: 'gate closed',
  gate_marginal: 'gate tight',
  official_warning: 'warning',
  model_divergence: 'models split',
  squall_potential: 'squalls?',
};

function buildOption(findings, cursorHours = 0) {
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

  const GRID_L = 88;
  const GRID_R = 96;

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#F3EEE3',
      borderColor: ink,
      textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      valueFormatter: (v) => (v == null ? '—' : String(v)),
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
      { type: 'value', gridIndex: 0, ...axisBase, ...rowName('Wind', 'knots') },
      { type: 'value', gridIndex: 1, ...axisBase, ...rowName('Gusts', 'knots') },
      { type: 'value', gridIndex: 2, ...axisBase, ...rowName('Waves', 'metres') },
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
