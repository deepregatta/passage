import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtHour } from '../lib/format.js';

/**
 * Ensemble plume (mockup 2): 51 thin member lines, median + P10/P90 envelope,
 * declared limit line, exceedance window shading. Raw scenario fractions only.
 */
export default function EnsemblePlume({ variable = 'gust' }) {
  const plume = useApp((s) => s.plume);
  const findings = useApp((s) => s.findings);
  const legId = useApp((s) => s.selectedLegId);

  const option = useMemo(() => {
    if (!plume || !findings || !legId) return null;
    const leg = plume.legs.find((l) => l.leg_id === legId);
    const legFindings = findings.legs.find((l) => l.leg_id === legId);
    if (!leg || !legFindings) return null;
    return buildOption(leg, legFindings, findings, variable);
  }, [plume, findings, legId, variable]);

  if (!option) return <p className="text-sm text-ink-soft">No ensemble data for this leg.</p>;
  return (
    <ReactECharts option={option} style={{ height: 360 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
  );
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

function buildOption(leg, legFindings, findings, variable) {
  const members = variable === 'gust' ? leg.gust_members : leg.wind_members;
  const times = leg.times.map((t) => Date.parse(t));
  const limit = leg.gust_limit_kt;

  const memberSeries = members.map((series, m) => ({
    name: m === 0 ? 'control' : `member ${m}`,
    type: 'line',
    data: series.map((v, i) => [times[i], v]),
    showSymbol: false,
    silent: true,
    lineStyle: { color: 'rgba(22,40,62,0.10)', width: 0.8 },
    emphasis: { disabled: true },
    tooltip: { show: false },
  }));

  const median = [];
  const p10 = [];
  const p90 = [];
  for (let i = 0; i < times.length; i++) {
    const vals = members
      .map((s) => s[i])
      .filter((v) => v !== null && Number.isFinite(v))
      .sort((a, b) => a - b);
    median.push([times[i], vals.length ? Math.round(quantile(vals, 0.5) * 10) / 10 : null]);
    p10.push([times[i], vals.length ? Math.round(quantile(vals, 0.1) * 10) / 10 : null]);
    p90.push([times[i], vals.length ? Math.round(quantile(vals, 0.9) * 10) / 10 : null]);
  }

  // exceedance windows: hours where the raw fraction crosses the declared floor
  const floor = 0.3;
  const windows = [];
  let start = null;
  for (const hour of legFindings.hours) {
    const count = variable === 'gust' ? hour.exceedance?.gust : hour.exceedance?.sustained;
    const above = count && count.exceed / count.total >= floor;
    const t = Date.parse(hour.valid_time);
    if (above && start === null) start = t;
    if (!above && start !== null) {
      windows.push([{ xAxis: start }, { xAxis: t }]);
      start = null;
    }
  }
  if (start !== null) {
    windows.push([{ xAxis: start }, { xAxis: Date.parse(legFindings.hours.at(-1).valid_time) }]);
  }

  const ink = '#16283E';
  const soft = '#4C5D73';

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#F3EEE3',
      borderColor: ink,
      textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
    },
    grid: { left: 48, right: 18, top: 30, bottom: 40 },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: soft } },
      axisLabel: {
        color: soft,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10,
        formatter: (v) => fmtHour(new Date(v).toISOString()),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'kt',
      nameTextStyle: { color: soft },
      axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(22,40,62,0.08)' } },
    },
    series: [
      ...memberSeries,
      {
        name: 'P10',
        type: 'line',
        data: p10,
        showSymbol: false,
        lineStyle: { color: soft, width: 1, type: 'dashed' },
      },
      {
        name: 'P90',
        type: 'line',
        data: p90,
        showSymbol: false,
        lineStyle: { color: soft, width: 1, type: 'dashed' },
      },
      {
        name: 'median (P50)',
        type: 'line',
        data: median,
        showSymbol: false,
        lineStyle: { color: ink, width: 2.2 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: limit }],
          lineStyle: { color: '#A87718', width: 1.8 },
          label: {
            formatter: `YOUR LIMIT · ${limit} kt`,
            position: 'insideStartTop',
            color: '#A87718',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10,
            fontWeight: 'bold',
          },
        },
        markArea: windows.length
          ? {
              silent: true,
              itemStyle: { color: 'rgba(166,59,42,0.10)' },
              label: {
                show: true,
                formatter: 'exceedance window',
                color: '#A63B2A',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 10,
                position: 'insideTop',
              },
              data: windows,
            }
          : undefined,
      },
    ],
  };
}
