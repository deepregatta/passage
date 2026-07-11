import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import { STATUS_HEX, hourStatus, fmtHour } from '../lib/format.js';

/**
 * Passage timeline (mockup 1): wind + gusts vs declared gust limit, waves beneath,
 * hours colored by limit status, leg strip along the bottom (nominal schedule).
 */
export default function RouteTimeline() {
  const findings = useApp((s) => s.findings);
  const option = useMemo(() => (findings ? buildOption(findings) : null), [findings]);
  if (!option) return null;
  return (
    <ReactECharts option={option} style={{ height: 380 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
  );
}

function buildOption(findings) {
  // stitch legs into one continuous nominal-schedule series
  const rows = [];
  for (const leg of findings.legs) {
    const enter = Date.parse(leg.enter_range.nominal);
    const exit = Date.parse(leg.eta_range.nominal);
    for (const hour of leg.hours) {
      const t = Date.parse(hour.valid_time);
      if (t >= enter - 1800_000 && t <= exit + 1800_000) {
        rows.push({ t, leg: leg.leg_id, hour });
      }
    }
  }
  rows.sort((a, b) => a.t - b.t);

  const gustLimit = findings.evidence.find((e) => e.rule_id === 'W-GUST-01' || e.rule_id === 'W-GUST-03')
    ?.limit;

  const wind = rows.map((r) => [r.t, r.hour.wind_kt]);
  const gust = rows.map((r) => [r.t, r.hour.gust_kt]);
  const hs = rows.map((r) => [r.t, r.hour.waves?.hs_m ?? null]);
  const statusDots = rows.map((r) => ({
    value: [r.t, r.hour.gust_kt],
    itemStyle: { color: STATUS_HEX[hourStatus(r.hour)] },
  }));

  const legMarks = findings.legs.map((leg) => ({
    name: leg.leg_id,
    xAxis: Date.parse(leg.enter_range.nominal),
  }));

  const ink = '#16283E';
  const soft = '#4C5D73';
  const axis = {
    axisLine: { lineStyle: { color: soft } },
    axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
    splitLine: { lineStyle: { color: 'rgba(22,40,62,0.08)' } },
  };

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
      { left: 52, right: 16, top: 28, height: 190 },
      { left: 52, right: 16, top: 258, height: 70 },
    ],
    xAxis: [
      {
        type: 'time',
        gridIndex: 0,
        ...axis,
        axisLabel: { show: false },
        axisTick: { show: false },
      },
      { type: 'time', gridIndex: 1, ...axis, axisLabel: { ...axis.axisLabel, formatter: (v) => fmtHour(new Date(v).toISOString()) } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: 'kt', nameTextStyle: { color: soft }, ...axis },
      { type: 'value', gridIndex: 1, name: 'Hs m', nameTextStyle: { color: soft }, ...axis },
    ],
    series: [
      {
        name: 'sustained wind',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: wind,
        showSymbol: false,
        lineStyle: { color: ink, width: 1.6 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: legMarks,
          lineStyle: { color: 'rgba(22,40,62,0.35)', type: 'dashed', width: 1 },
          label: {
            formatter: (p) => p.name,
            color: soft,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10,
            position: 'insideEndTop',
          },
        },
      },
      {
        name: 'gusts',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: gust,
        showSymbol: false,
        lineStyle: { color: '#A63B2A', width: 1.2, opacity: 0.85 },
        markLine: gustLimit
          ? {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: gustLimit }],
              lineStyle: { color: '#A87718', type: 'dashed', width: 1.5 },
              label: {
                formatter: `your limit · ${gustLimit} kt`,
                position: 'insideStartTop',
                color: '#A87718',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 10,
              },
            }
          : undefined,
      },
      {
        name: 'limit status',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: statusDots,
        symbolSize: 5,
        tooltip: { show: false },
      },
      {
        name: 'significant wave height',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: hs,
        showSymbol: false,
        areaStyle: { color: 'rgba(220,229,230,0.7)' },
        lineStyle: { color: soft, width: 1.2 },
      },
    ],
  };
}
