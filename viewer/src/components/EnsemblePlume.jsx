import { palette, rgba } from '../lib/palette.js';
import ReactECharts from './lazy/EChartsLazy.jsx';
import { useMemo } from 'react';
import { quantile } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import useViewport from '../hooks/useViewport.js';
import { createAxisLabelFormatter, createTimeTooltipFormatter, plumeAriaLabel, timeZoneAxisProps } from '../lib/chartTime.js';

/**
 * Ensemble plume (mockup 2): 51 thin member lines, median + P10/P90 envelope,
 * declared limit line, exceedance window shading. Raw scenario fractions only.
 */
export default function EnsemblePlume({ evidence, variable = 'gust', height = 430 }) {
  const plume = useApp((s) => s.plume);
  const findings = useApp((s) => s.findings);
  const selectedLegId = useApp((s) => s.selectedLegId);
  const legId = evidence?.leg_id ?? selectedLegId;
  const mobile = useViewport();

  const option = useMemo(() => {
    if (!plume || !findings || !legId) return null;
    const leg = plume.legs.find((l) => l.leg_id === legId);
    const legFindings = findings.legs.find((l) => l.leg_id === legId);
    const members = variable === 'gust' ? leg?.gust_members : leg?.wind_members;
    if (!leg?.times?.length || !legFindings || !members?.some((series) => series.some(Number.isFinite))) return null;
    return buildOption(leg, legFindings, evidence, variable, mobile);
  }, [plume, findings, legId, evidence, variable, mobile]);

  if (!option) return <p className="text-sm text-ink-soft">No ensemble data for this leg.</p>;
  return (
    <div role="img" aria-label={option.ariaLabel}>
      <ReactECharts option={option.chart} style={{ height }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
    </div>
  );
}

function buildOption(leg, legFindings, evidence, variable, mobile = false) {
  const members = variable === 'gust' ? leg.gust_members : leg.wind_members;
  const times = leg.times.map((t) => Date.parse(t));
  // Frozen plumes archive a gust limit only. Wind needs its own evidence limit.
  const limit = Number.isFinite(evidence?.limit) ? evidence.limit : variable === 'gust' && Number.isFinite(leg.gust_limit_kt) ? leg.gust_limit_kt : null;
  const units = evidence?.units ?? 'kt';

  const memberSeries = members.map((series, m) => ({
    name: m === 0 ? 'control' : `member ${m}`,
    type: 'line',
    data: series.map((v, i) => [times[i], v]),
    showSymbol: false,
    silent: true,
    lineStyle: { color: rgba(palette.ink.DEFAULT, '0.10'), width: 0.8 },
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

  // Exceedance windows. On a leg the check read at several points (passage-audit-4) the lines are the
  // reading at the expected position, so the windows come from the check's own counts (a scenario
  // counts when it exceeds the limit at any point the boat can be at in that hour), never from these
  // lines. On a leg read at one point the lines are that point's reading: the windows are derived from
  // these same members and this same claim limit, as before.
  const floor = 0.3;
  const audited = auditedFractions(legFindings, variable);
  const windows = [];
  let start = null;
  for (let i = 0; i < times.length; i++) {
    const values = members.map((series) => series[i]).filter((value) => Number.isFinite(value));
    const above = audited
      ? (audited.get(times[i]) ?? 0) >= floor
      : limit !== null && values.length > 0 && values.filter((value) => value > limit).length / values.length >= floor;
    const t = times[i];
    if (above && start === null) start = t;
    if (!above && start !== null) {
      windows.push([{ xAxis: start }, { xAxis: t }]);
      start = null;
    }
  }
  if (start !== null) {
    windows.push([{ xAxis: start }, { xAxis: times.at(-1) }]);
  }

  const finite = members.flat().filter((value) => Number.isFinite(value));
  const dataMax = finite.length ? Math.max(...finite) : limit;

  const ink = palette.ink.DEFAULT;
  const soft = palette.ink.soft;

  const chart = {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.paper.DEFAULT,
      borderColor: ink,
      textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      formatter: createTimeTooltipFormatter(),
    },
    grid: { left: mobile ? 34 : 48, right: mobile ? 8 : 18, top: 30, bottom: 74 },
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
      name: units,
      nameTextStyle: { color: soft, fontSize: 12 },
      axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      splitLine: { lineStyle: { color: rgba(palette.ink.DEFAULT, '0.08') } },
      min: 0,
      max: Math.ceil(Math.max(dataMax, limit ?? 0) * 1.12),
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
        markLine: limit === null ? undefined : {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: limit }],
          lineStyle: { color: palette.verdict.approaching, width: 1.8 },
          label: {
            formatter: `YOUR LIMIT · ${limit} ${units}`,
            position: 'insideStartTop',
            color: palette.verdict.approaching,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            fontWeight: 'bold',
          },
        },
        markArea: windows.length
          ? {
              silent: true,
              itemStyle: { color: rgba(palette.verdict.exceeds, '0.10') },
              label: {
                show: true,
                formatter: 'exceedance window',
                color: palette.verdict.exceeds,
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                position: 'insideTop',
              },
              data: windows,
            }
          : undefined,
      },
    ],
  };
  const ariaLabel = plumeAriaLabel({ members: members.length, variable, startMs: times[0], endMs: times.at(-1), limit, units });
  return { chart, ariaLabel };
}

/** Whether the check read this leg at several points: then its plume lines follow the expected position. */
export function readAtSeveralPoints(legFindings) {
  return (legFindings?.sample_points?.length ?? 0) > 1;
}

/**
 * The check's own scenario fraction per audited hour (ms) for one variable on a
 * leg read at several points, or null for a leg read at one point.
 */
export function auditedFractions(legFindings, variable) {
  if (!readAtSeveralPoints(legFindings)) return null;
  const key = variable === 'gust' ? 'gust' : 'sustained';
  const out = new Map();
  for (const hour of legFindings.hours ?? []) {
    const count = hour.exceedance?.[key];
    if (count && count.total > 0) out.set(Date.parse(hour.valid_time), count.exceed / count.total);
  }
  return out;
}

/** The check's own count at one hour on a leg read at several points ("20/51"), or null when it did not audit that hour. */
export function auditedCount(legFindings, variable, iso) {
  const key = variable === 'gust' ? 'gust' : 'sustained';
  const at = Date.parse(iso);
  const count = (legFindings?.hours ?? []).find((hour) => Date.parse(hour.valid_time) === at)?.exceedance?.[key];
  return count ? `${count.exceed}/${count.total}` : null;
}
