import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RouteTimeline from '../src/components/RouteTimeline.jsx';
import { useApp } from '../src/stores/appStore.js';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

// capture the chart option instead of drawing it
const charts = vi.hoisted(() => []);
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: (props) => { charts.push(props.option); return null; } }));

beforeEach(() => { charts.length = 0; });
afterEach(cleanup);

it('draws the expected timing at the boat\'s expected position when a check records it, and the row otherwise', () => {
  // passage-audit-4: a leg read at several points carries, per hour, the reading where the boat is expected
  const f = structuredClone(findings);
  const leg = f.legs[0];
  const enter = Date.parse(leg.enter_range.nominal);
  const hour = leg.hours.find((h) => Date.parse(h.valid_time) >= enter);
  const rowWind = hour.wind_kt;
  hour.expected = { sample_point_id: 'L1.1', wind_kt: rowWind - 5, gust_kt: hour.gust_kt - 5, wind_dir_deg: hour.wind_dir_deg,
    twa_deg: hour.twa_deg, point_of_sail: hour.point_of_sail, limit_status: { sustained: 'ok', gust: 'ok' } };
  useApp.setState({ ...useApp.getInitialState(), findings: f }, true);
  render(<RouteTimeline />);
  fireEvent.click(screen.getByText(/Show wind, gust and wave charts/));
  const option = charts.at(-1);
  const wind = option.series.find((s) => s.name === 'wind').data;
  const at = Date.parse(hour.valid_time);
  expect(wind.filter(([t]) => t === at).map(([, v]) => v)).toEqual([rowWind - 5]);
  // another hour without `expected` (as every hour saved before) is drawn from its row
  const other = leg.hours.find((h) => Date.parse(h.valid_time) > at && !h.expected && Date.parse(h.valid_time) < Date.parse(leg.eta_range.nominal));
  expect(wind.find(([t]) => t === Date.parse(other.valid_time))[1]).toBe(other.wind_kt);
});
