import { palette, rgba } from '../lib/palette.js';
import ReactECharts from './lazy/EChartsLazy.jsx';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { STATUS_HEX, hourStatus, fmtHour, fmtLocalTime } from '../lib/format.js';
import { usePlayback } from '../stores/playbackStore.js';
import useViewport from '../hooks/useViewport.js';
import { edgeShift, fmtLocalClock, rulerTicks } from '../lib/ruler.js';
import { createAxisLabelFormatter, createTimeTooltipFormatter } from '../lib/chartTime.js';
import { legLabel } from '../pages/briefing/routeLabels.jsx';

/**
 * Passage timeline and the page's one time control. Default = one glanceable
 * condition strip (worst status per hour vs your limits) that is also the
 * scrubber for the chart above; the three labeled charts (wind / gust / waves)
 * live behind "Show detailed charts".
 */
export default function RouteTimeline() {
  const findings = useApp((s) => s.findings);
  const mobile = useViewport();
  const [detailed, setDetailed] = useState(false);
  const option = useMemo(
    () => (findings && detailed ? buildOption(findings, mobile) : null),
    [findings, mobile, detailed],
  );
  const [chart, setChart] = useState(null);
  useEffect(() => {
    if (!chart || !detailed || !option) return;
    const gust = option.series.find((series) => series.id === 'gusts');
    if (!gust.markLine) return;
    const span = chartSpan(findings);
    const update = () => {
      if (chart.isDisposed()) return;
      const cursorTime = Date.parse(findings.departure_utc) + usePlayback.getState().cursorHours * 3600_000;
      // Merge only mark-line data by series id; retain all weather data and bands.
      chart.setOption({ series: [{ id: 'gusts', markLine: {
        data: [gust.markLine.data[0], nowLine(cursorTime, span)],
      } }] });
    };
    update();
    return usePlayback.subscribe((state, previous) => {
      if (state.cursorHours !== previous.cursorHours) update();
    });
  }, [chart, detailed, option, findings]);
  if (!findings) return null;
  return (
    <div>
      <PassageClock findings={findings} />
      <ConditionStrip findings={findings} />
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
          <ReactECharts onChartReady={setChart} option={option} style={{ height: 372 }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 justify-end font-sans text-xs text-ink-soft pr-2 -mt-1">
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ background: rgba(palette.verdict.approaching, '0.35') }} />
              close to your limits
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ background: rgba(palette.verdict.exceeds, '0.35') }} />
              beyond your limits
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed inline-block" style={{ borderColor: palette.verdict.approaching }} />
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

/** The strip covers the assessed passage: departure to the last hour at usual speed. */
function stripHours(findings) {
  const rows = collectRows(findings);
  if (!rows.length) return 0;
  return Math.max(1, Math.ceil((rows[rows.length - 1].t + 3600_000 - Date.parse(findings.departure_utc)) / 3600_000));
}

/** Play/pause and the time under the cursor; departure time zone is stated once, in the band. */
function PassageClock({ findings }) {
  const cursor = usePlayback((state) => state.cursorHours);
  const playing = usePlayback((state) => state.playing);
  const play = usePlayback((state) => state.play);
  const pause = usePlayback((state) => state.pause);
  useEffect(() => () => pause(), [pause]);
  const time = new Date(Date.parse(findings.departure_utc) + cursor * 3600_000).toISOString();
  return (
    <div className="flex items-center justify-end gap-3 -mt-1">
      <output className="font-mono text-xs text-right">
        {fmtLocalTime(time)} <span className="text-ink-soft">· +{Math.round(cursor)} h</span>
      </output>
      <button type="button" onClick={() => playing ? pause() : play(stripHours(findings))} className="w-11 h-11 border border-ink/40 bg-paper hover:bg-white/60" aria-label={playing ? 'Pause passage playback' : 'Play passage playback'}>{playing ? 'Ⅱ' : '▶'}</button>
    </div>
  );
}

/** One glanceable bar: each stretch of the passage colored by its worst condition
 * status. It spans the playback window, and dragging along it moves the time cursor. */
function ConditionStrip({ findings }) {
  const rows = collectRows(findings);
  const cursor = usePlayback((state) => state.cursorHours);
  const setCursor = usePlayback((state) => state.setCursor);
  const mobile = useViewport();
  if (!rows.length) return null;
  const maxHours = stripHours(findings);
  const t0 = Date.parse(findings.departure_utc);
  const t1 = t0 + maxHours * 3600_000;
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

  // browser-local wall-clock ticks: the zone the page header states ("times in …")
  const ticks = rulerTicks(t0, t1, mobile ? 6 : 12);
  const hasDay = ticks.some((tick) => tick.day);
  const summary = merged.map((m) => `${fmtLocalClock(m.from)}–${fmtLocalClock(m.to)} ${STRIP_LABEL[m.status]}`).join('; ');
  const twoRows = flags.length > 1;

  return (
    <div className="mt-3" data-testid="condition-strip">
      <div className={flags.length ? `relative ${twoRows ? 'h-11' : 'h-6'}` : 'hidden'}>
        {flags.map((f, i) => (
          <span
            key={f.label}
            className="absolute font-sans text-xs text-paper px-1.5 py-0.5 rounded-sm whitespace-nowrap"
            style={{
              left: `${pct(f.at)}%`,
              transform: `translateX(${edgeShift(pct(f.at), 14)})`,
              backgroundColor: palette.verdict.approaching,
              top: i % 2 ? 22 : 0,
            }}
          >
            {f.label}
          </span>
        ))}
      </div>
      {/* the slider's hit area is 44px tall; the visible track stays slim */}
      <div className="relative h-11 py-1">
        <input
          type="range"
          aria-label="Passage time"
          aria-describedby="condition-summary"
          min="0"
          max={maxHours}
          step="1"
          value={Math.round(cursor * 10) / 10}
          onChange={(event) => setCursor(Number(event.target.value))}
          className="peer absolute inset-0 z-10 w-full h-full opacity-0 cursor-ew-resize m-0"
        />
        <span id="condition-summary" className="sr-only">{`Conditions along your route: ${summary}`}</span>
        <span className="pointer-events-none absolute inset-0 z-20 rounded-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-ink" aria-hidden />
        <div className="relative h-9 rounded-sm overflow-hidden border hairline bg-white/40">
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
          <StripCursor departure={t0} t0={t0} t1={t1} />
        </div>
      </div>
      <div className={`relative ${hasDay ? 'h-9' : 'h-5'}`} aria-hidden>
        {ticks.map((tick) => (
          <span
            key={tick.t}
            className={`absolute text-center font-mono text-xs leading-4 ${tick.day ? 'text-ink' : 'text-ink-soft'}`}
            style={{ left: `${pct(tick.t)}%`, transform: `translateX(${edgeShift(pct(tick.t), 9)})` }}
          >
            {tick.label}
            {tick.day && <span className="block font-semibold">{tick.day}</span>}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 justify-end font-sans text-xs text-ink-soft pr-2">
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

function StripCursor({ departure, t0, t1 }) {
  const cursor = usePlayback((state) => state.cursorHours);
  const time = departure + cursor * 3600_000;
  if (time < t0 || time > t1) return null;
  return <div className="pointer-events-none absolute -top-px -bottom-px w-[3px] -translate-x-1/2" style={{ left: `${((time - t0) / (t1 - t0)) * 100}%`, backgroundColor: palette.event }} aria-hidden />;
}

/** First and last hour drawn on the charts. */
function chartSpan(findings) {
  const rows = collectRows(findings);
  return rows.length ? { from: rows[0].t, to: rows[rows.length - 1].t } : null;
}

function nowLine(time, span) {
  // the NOW text is not a link: ink colour, the teal stays on the line itself. It reads away from the
  // row names at the left edge and stays inside the plot at the right edge.
  const late = span && span.to > span.from && (time - span.from) / (span.to - span.from) > 0.5;
  return { xAxis: time, label: { formatter: 'NOW', position: 'end', color: palette.ink.DEFAULT, fontSize: 12, align: late ? 'right' : 'left' }, lineStyle: { color: palette.event, type: 'solid', width: 1 } };
}

/** Table alternative: header-zone time first with the chart's UTC hour as a marked secondary column
 * (as the plume table does), legs by place and number ("Mid-Channel (leg 4)", never the raw "L4");
 * the disclosure grows with its rows, it is not a scroll box of its own. */
function TimelineTable({ findings }) {
  const rows = findings.legs.flatMap((leg) => leg.hours.filter((_, index) => index % 3 === 0).map((hour) => ({ leg: leg.leg_id, ...hour })));
  return (
    <details className="mt-3 border-t hairline pt-2">
      <summary className="font-instrument text-xs cursor-pointer min-h-11 flex items-center">Table alternative for route timeline</summary>
      <div className="overflow-x-auto mt-2">
        <table className="w-full font-mono text-xs">
          <thead><tr className="text-left"><th className="py-1 pr-3">local time</th><th className="pr-3">UTC</th><th className="pr-3">leg</th><th className="pr-3">wind kt</th><th className="pr-3">gust kt</th><th className="pr-3">waves m</th><th>status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.leg}-${row.valid_time}`} className="border-t hairline align-top">
                <td className="py-1 pr-3 whitespace-nowrap">{fmtLocalTime(row.valid_time)}</td>
                <td className="pr-3">{fmtHour(row.valid_time)}</td>
                <td className="pr-3">{legLabel(findings, row.leg, { bare: true })}</td>
                <td className="pr-3">{row.wind_kt ?? 'n/a'}</td>
                <td className="pr-3">{row.gust_kt ?? 'n/a'}</td>
                <td className="pr-3">{row.waves?.hs_m ?? 'not assessed'}</td>
                <td>{hourStatus(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
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

function buildOption(findings, mobile = false) {
  const rows = collectRows(findings);

  const gustLimit = findings.evidence.find(
    (e) => e.rule_id === 'W-GUST-01' || e.rule_id === 'W-GUST-03',
  )?.limit;
  const cursorTime = Date.parse(findings.departure_utc) + usePlayback.getState().cursorHours * 3600_000;
  const span = chartSpan(findings);

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
      itemStyle: { color: b.status === 'exceeded' ? rgba(palette.verdict.exceeds, '0.13') : rgba(palette.verdict.approaching, '0.13') },
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
        color: palette.paper.DEFAULT,
        backgroundColor: palette.verdict.approaching,
        padding: [2, 5],
        borderRadius: 2,
        fontFamily: 'system-ui',
        fontSize: 12,
      },
      itemStyle: { color: palette.verdict.approaching },
    });
  }

  const ink = palette.ink.DEFAULT;
  const soft = palette.ink.soft;
  const axisBase = {
    axisLine: { lineStyle: { color: rgba(palette.ink.DEFAULT, '0.25') } },
    axisTick: { show: false },
    axisLabel: { color: soft, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
    splitLine: { lineStyle: { color: rgba(palette.ink.DEFAULT, '0.07') } },
  };
  const rowName = (name, sub) => ({
    name: `${name}\n${sub}`,
    nameLocation: 'end',
    nameTextStyle: {
      color: ink,
      fontFamily: 'system-ui',
      fontSize: 12,
      fontWeight: 600,
      align: 'right',
      padding: [0, 6, 0, 0],
      lineHeight: 14,
    },
  });

  // wide enough for the longest row name ("Rafales" in French) beside the tick numbers
  const GRID_L = mobile ? 58 : 88;
  const GRID_R = mobile ? 34 : 96;

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.paper.DEFAULT,
      borderColor: ink,
      textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      formatter: createTimeTooltipFormatter(),
    },
    grid: [
      // a row's name (two lines) sits above its plot: 44 px between plots keeps it clear of the row above
      { left: GRID_L, right: GRID_R, top: 32, height: 64 },
      { left: GRID_L, right: GRID_R, top: 140, height: 64 },
      { left: GRID_L, right: GRID_R, top: 248, height: 50 },
    ],
    xAxis: [0, 1, 2].map((i) => ({
      type: 'time',
      gridIndex: i,
      ...axisBase,
      axisLabel:
        i === 2
          ? { ...axisBase.axisLabel, formatter: createAxisLabelFormatter({ skipOdd: mobile }), hideOverlap: true }
          : { show: false },
    })),
    yAxis: [
      { type: 'value', gridIndex: 0, splitNumber: 3, ...axisBase, ...rowName('Wind', mobile ? 'kt' : 'knots') },
      { type: 'value', gridIndex: 1, splitNumber: 3, ...axisBase, ...rowName('Gusts', mobile ? 'kt' : 'knots') },
      { type: 'value', gridIndex: 2, splitNumber: 3, ...axisBase, ...rowName('Waves', mobile ? 'm' : 'metres') },
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
        id: 'gusts',
        name: 'gusts',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: gust,
        showSymbol: false,
        lineStyle: { color: palette.verdict.exceeds, width: 2 },
        markArea: bandAreas.length ? { silent: true, data: bandAreas } : undefined,
        markLine: gustLimit
          ? {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: gustLimit }, nowLine(cursorTime, span)],
              lineStyle: { color: palette.verdict.approaching, type: 'dashed', width: 1.6 },
              label: {
                formatter: `${gustLimit} kt\nyour limit`,
                // inside the plot on a phone, where there is no margin to the right of it
                position: mobile ? 'insideEndTop' : 'end',
                color: palette.verdict.approaching,
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                lineHeight: 14,
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
        areaStyle: { color: rgba(palette.ink.soft, '0.18') },
        lineStyle: { color: soft, width: 1.6 },
      },
    ],
  };
}
