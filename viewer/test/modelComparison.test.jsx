import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ModelComparison from '../src/components/ModelComparison.jsx';
import EnsemblePlume from '../src/components/EnsemblePlume.jsx';
import { localTimeZoneName } from '../src/lib/format.js';
import { useApp } from '../src/stores/appStore.js';

// The chart option is the contract: the mock prints it so the test can read it back.
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: ({ option }) => <pre data-testid="chart">{JSON.stringify(option)}</pre> }));

afterEach(() => {
  cleanup();
  useApp.setState({ plume: null, findings: null, selectedLegId: null });
});

const HOURS = Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2026, 6, 20, i)).toISOString());

function setup(divergentHours, deterministic = { gfs_0p25: HOURS.map(() => 12), ecmwf_ifs_0p25: HOURS.map(() => 14) }) {
  useApp.setState({
    selectedLegId: 'L1',
    findings: { legs: [{ leg_id: 'L1', divergent_hours: divergentHours.map((valid_time) => ({ valid_time, values: {}, spread_kt: 6 })) }] },
    plume: {
      legs: [{
        leg_id: 'L1', times: HOURS, deterministic_times: HOURS, deterministic,
        gust_limit_kt: 28, gust_members: [HOURS.map(() => 20), HOURS.map(() => 24)], wind_members: [HOURS.map(() => 14)],
      }],
    },
  });
}
const chartOption = () => JSON.parse(screen.getByTestId('chart').textContent);

it('draws the two live models in different colours and dashes, named for people', () => {
  setup([]);
  const { container } = render(<ModelComparison />);
  const series = chartOption().series;
  expect(series.map((s) => s.name)).toEqual(['GFS 0.25°', 'ECMWF IFS 0.25°']);
  expect(series[0].lineStyle.color).not.toBe(series[1].lineStyle.color);
  expect(series[0].lineStyle.type).not.toBe(series[1].lineStyle.type);
  // The visible key repeats the same names, with a swatch per line.
  const key = container.querySelector('ul');
  expect(key.textContent).toContain('GFS 0.25°');
  expect(key.textContent).toContain('ECMWF IFS 0.25°');
  expect(key.querySelectorAll('svg line')).toHaveLength(2);
  expect(key.textContent).not.toContain('grey band');
  expect(chartOption().legend).toBeUndefined();
});

it('prints "divergence" once for three adjacent divergent hours', () => {
  setup([HOURS[9], HOURS[10], HOURS[11]]);
  const { container } = render(<ModelComparison />);
  const area = chartOption().series[0].markArea;
  expect(area.data).toHaveLength(1);
  expect(area.data[0][0].label.show).toBe(true);
  expect(container.querySelector('ul').textContent).toContain('grey band: models diverge');
});

it('labels only one of several separate divergence bands', () => {
  setup([HOURS[9], HOURS[10], HOURS[30], HOURS[50], HOURS[51], HOURS[52]]);
  render(<ModelComparison />);
  const shown = chartOption().series[0].markArea.data.map(([start]) => start.label.show);
  expect(shown).toEqual([false, false, true]);
});

it('states the zone and day names on the axis, with chart text at 12 px or more', () => {
  setup([HOURS[9]]);
  render(<ModelComparison />);
  const option = chartOption();
  expect(option.xAxis.name).toBe(`local time · ${localTimeZoneName()}`);
  const sizes = [
    option.xAxis.axisLabel.fontSize, option.xAxis.nameTextStyle.fontSize, option.yAxis.axisLabel.fontSize,
    option.yAxis.nameTextStyle.fontSize, option.tooltip.textStyle.fontSize, option.series[0].markArea.label.fontSize,
  ];
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
});

it('gives the chart a text alternative with names, span, zone and divergence', () => {
  setup([HOURS[9], HOURS[10]]);
  const { container } = render(<ModelComparison />);
  const label = container.querySelector('[role="img"]').getAttribute('aria-label');
  expect(label).toContain('GFS 0.25°, ECMWF IFS 0.25°');
  expect(label).toContain(`local time ${localTimeZoneName()}`);
  expect(label).toContain('Models diverge in 2 h');
});

it('keeps unknown model ids visible and distinct', () => {
  setup([], { arpege_eu: HOURS.map(() => 10), gfs_0p25: HOURS.map(() => 12) });
  render(<ModelComparison />);
  const series = chartOption().series;
  expect(series[0].name).toBe('arpege_eu');
  expect(series[0].lineStyle.color).not.toBe(series[1].lineStyle.color);
});

it('the ensemble plume states its zone, names days and describes itself', () => {
  setup([]);
  const { container } = render(<EnsemblePlume />);
  const option = chartOption();
  expect(option.xAxis.name).toBe(`local time · ${localTimeZoneName()}`);
  expect(option.xAxis.axisLabel.fontSize).toBeGreaterThanOrEqual(12);
  expect(container.querySelector('[role="img"]').getAttribute('aria-label')).toMatch(/^Ensemble plume of 2 forecast scenarios for gust, from .+ to .+, local time .+\. Median and P10 to P90 range shown\. Your limit: 28 kt\.$/);
});
