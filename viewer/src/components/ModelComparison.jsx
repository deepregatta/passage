import ReactECharts from './lazy/EChartsLazy.jsx';
import { useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtHour } from '../lib/format.js';

const MODEL_COLORS = {
  ecmwf_ifs025: '#16283E',
  gfs_global: '#2F6E4F',
  icon_eu: '#5A6B82',
};

/** Deterministic runs overlaid; divergence hours shaded. Agreement is not proof. */
export default function ModelComparison() {
  const plume = useApp((s) => s.plume);
  const findings = useApp((s) => s.findings);
  const legId = useApp((s) => s.selectedLegId);

  const option = useMemo(() => {
    const leg = plume?.legs.find((l) => l.leg_id === legId);
    const legFindings = findings?.legs.find((l) => l.leg_id === legId);
    if (!leg?.deterministic || !legFindings) return null;

    const times = leg.deterministic_times.map((t) => Date.parse(t));
    const soft = '#4C5D73';

    const divergence = (legFindings.divergent_hours ?? []).map((d) => Date.parse(d.valid_time));
    const areas = divergence.map((t) => [
      { xAxis: t - 1800_000 },
      { xAxis: t + 1800_000 },
    ]);

    return {
      backgroundColor: 'transparent',
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#F3EEE3',
        borderColor: '#16283E',
        textStyle: { color: '#16283E', fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      },
      legend: {
        top: 0,
        textStyle: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
        icon: 'rect',
        itemWidth: 14,
        itemHeight: 3,
      },
      grid: { left: 48, right: 18, top: 34, bottom: 36 },
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
        name: 'kt (10 m sustained)',
        nameTextStyle: { color: soft, fontSize: 10 },
        axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(22,40,62,0.08)' } },
      },
      series: Object.entries(leg.deterministic).map(([model, values], idx) => ({
        name: model,
        type: 'line',
        data: values.map((v, i) => [times[i], v]),
        showSymbol: false,
        itemStyle: { color: MODEL_COLORS[model] ?? '#A87718' },
        lineStyle: { color: MODEL_COLORS[model] ?? '#A87718', width: 1.6 },
        markArea:
          idx === 0 && areas.length
            ? {
                silent: true,
                itemStyle: { color: 'rgba(90,107,130,0.12)' },
                label: {
                  show: true,
                  formatter: 'divergence',
                  color: '#5A6B82',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 10,
                  position: 'insideTop',
                },
                data: areas,
              }
            : undefined,
      })),
    };
  }, [plume, findings, legId]);

  if (!option) {
    return <p className="text-sm text-ink-soft">No multi-model data in this snapshot.</p>;
  }
  return (
    <ReactECharts option={option} style={{ height: 260 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
  );
}
