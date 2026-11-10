import { palette, rgba } from '../lib/palette.js';
import ReactECharts from './lazy/EChartsLazy.jsx';
import { useMemo } from 'react';
import { useApp } from '../stores/appStore.js';
import useViewport from '../hooks/useViewport.js';
import {
  createAxisLabelFormatter, labelledBandIndex, mergeDivergenceBands, modelComparisonAriaLabel, sampleStepMs, timeZoneAxisProps,
} from '../lib/chartTime.js';
import { dashArray, modelStyle } from '../lib/modelStyles.js';

/** Deterministic runs overlaid; divergence hours shaded. Agreement is not proof. */
export default function ModelComparison() {
  const plume = useApp((s) => s.plume);
  const findings = useApp((s) => s.findings);
  const legId = useApp((s) => s.selectedLegId);
  const mobile = useViewport();

  const view = useMemo(() => {
    const leg = plume?.legs.find((l) => l.leg_id === legId);
    const legFindings = findings?.legs.find((l) => l.leg_id === legId);
    if (!leg?.deterministic || !legFindings) return null;

    const times = leg.deterministic_times.map((t) => Date.parse(t));
    const soft = palette.ink.soft;
    const models = Object.keys(leg.deterministic).map((model) => ({ model, ...modelStyle(model) }));

    // Hours that touch merge into one band, and only one band carries the label, so
    // consecutive divergent hours no longer print "divergence" on top of each other.
    const divergence = (legFindings.divergent_hours ?? []).map((d) => Date.parse(d.valid_time));
    const stepMs = sampleStepMs(times);
    const bands = mergeDivergenceBands(divergence, { stepMs });
    const labelled = labelledBandIndex(bands);
    const areas = bands.map((band, i) => [
      { xAxis: band.start, label: { show: i === labelled } },
      { xAxis: band.end },
    ]);

    const option = {
      backgroundColor: 'transparent',
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: palette.paper.DEFAULT,
        borderColor: palette.ink.DEFAULT,
        textStyle: { color: palette.ink.DEFAULT, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      },
      // The key is the HTML list above the chart (names, colour and dash, readable by
      // assistive tech); the built-in legend would be a second, 3 px-tall tap target.
      grid: { left: 48, right: 18, top: 34, bottom: 74 },
      xAxis: {
        type: 'time',
        ...timeZoneAxisProps(soft),
        axisLine: { lineStyle: { color: soft } },
        axisLabel: {
          color: soft,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          hideOverlap: true,
          formatter: createAxisLabelFormatter({ skipOdd: mobile }),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: 'kt (10 m sustained)',
        nameTextStyle: { color: soft, fontSize: 12, align: 'left' },
        axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
        splitLine: { lineStyle: { color: rgba(palette.ink.DEFAULT, '0.08') } },
      },
      series: models.map(({ model, label, color, dash, width }, idx) => ({
        name: label,
        type: 'line',
        data: leg.deterministic[model].map((v, i) => [times[i], v]),
        showSymbol: false,
        itemStyle: { color },
        lineStyle: { color, width, type: dash },
        markArea:
          idx === 0 && areas.length
            ? {
                silent: true,
                itemStyle: { color: rgba(palette.verdict.insufficient, '0.12') },
                label: {
                  show: true,
                  formatter: 'divergence',
                  color: palette.verdict.insufficient,
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 12,
                  position: 'insideTop',
                },
                data: areas,
              }
            : undefined,
      })),
    };
    const aria = modelComparisonAriaLabel({
      modelNames: models.map((m) => m.label),
      startMs: times[0],
      endMs: times.at(-1),
      divergentHours: new Set(divergence).size,
    });
    return { option, models, aria, hasDivergence: areas.length > 0 };
  }, [plume, findings, legId, mobile]);

  if (!view) {
    return <p className="text-sm text-ink-soft">No multi-model data in this snapshot.</p>;
  }
  return (
    <div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 mb-2 font-mono text-xs text-ink">
        {view.models.map(({ model, label, color, dash, width }) => (
          <li key={model} className="flex items-center gap-2">
            <svg width="30" height="10" aria-hidden="true"><line x1="0" y1="5" x2="30" y2="5" stroke={color} strokeWidth={width} strokeDasharray={dashArray(dash)} /></svg>
            {label}
          </li>
        ))}
        {view.hasDivergence && (
          <li className="flex items-center gap-2">
            <svg width="30" height="10" aria-hidden="true"><rect width="30" height="10" fill={rgba(palette.verdict.insufficient, '0.25')} /></svg>
            grey band: models diverge
          </li>
        )}
      </ul>
      <div role="img" aria-label={view.aria}>
        <ReactECharts option={view.option} style={{ height: 300 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
      </div>
    </div>
  );
}
