import { describe, expect, it } from 'vitest';
import { nextForecastRuns } from '../src/briefing.js';
import type { LayerInfo } from '../src/forecast/store.js';
import { describeNextRun, modelDisplayName, NEXT_RUN_DUE_MINUTES, NEXT_RUN_GRACE_MINUTES } from '../src/index.js';

const layer = (overrides: Partial<LayerInfo>): LayerInfo => ({
  layer: 'weather', model: 'gfs_0p25', run_id: 'weather-20261110T12Z',
  cycle: '2026-11-10T12:00:00Z', published_at: '2026-11-10T16:52:00Z',
  member_count: 1, resolution_deg: 0.25, cadence_hours: 6, ...overrides,
});

describe('live case: "next forecast ~Tue 10 Nov 19:37 UTC" shown at 19:35', () => {
  // Analysis ran at 19:33; the page was read at 19:35.
  const analysedAt = '2026-11-10T19:33:00Z';

  it('the 19:37 estimate cannot be GFS: it would need a 1 h 37 publication lag', () => {
    // GFS 12Z with the measured lag (provider ready +4 h 35-4 h 55, forecast-tiles
    // README dispatcher table) gives the 18Z run around 22:52, not 19:37.
    expect(nextForecastRuns({ weather: layer({}) }, analysedAt)).toEqual([
      { model: 'gfs_0p25', cycle: '2026-11-10T18:00:00Z', expected_at: '2026-11-10T22:52:00Z' },
    ]);
    // Only a GFS 12Z published at 13:37 yields 19:37, which NOAA never does.
    expect(nextForecastRuns({ weather: layer({ published_at: '2026-11-10T13:37:00Z' }) }, analysedAt)[0]!.expected_at)
      .toBe('2026-11-10T19:37:00Z');
  });

  it('19:37 is ECMWF 12Z: its 00Z run was published at 07:37 (ready +7 h 34)', () => {
    const runs = nextForecastRuns({
      weather: layer({}),
      'weather-ecmwf': layer({ layer: 'weather-ecmwf', model: 'ecmwf_ifs_0p25', run_id: 'weather-ecmwf-20261110T00Z',
        cycle: '2026-11-10T00:00:00Z', published_at: '2026-11-10T07:37:00Z', cadence_hours: 12 }),
    }, analysedAt);
    expect(runs[0]).toEqual({ model: 'ecmwf_ifs_0p25', cycle: '2026-11-10T12:00:00Z', expected_at: '2026-11-10T19:37:00Z' });
    // Read two minutes before: due now, with no clock time to show.
    expect(describeNextRun(runs, '2026-11-10T19:35:00Z')).toEqual({
      kind: 'due', model: 'ecmwf_ifs_0p25', model_name: 'ECMWF', cycle: '12Z',
    });
  });
});

describe('describeNextRun', () => {
  const run = { model: 'gfs_0p25', cycle: '2026-11-10T18:00:00Z', expected_at: '2026-11-10T22:52:00Z' };

  it('returns a future estimate with model name, expected cycle and minutes until', () => {
    expect(describeNextRun(run, '2026-11-10T19:35:00Z')).toEqual({
      kind: 'future', model: 'gfs_0p25', model_name: 'GFS', cycle: '18Z',
      expected_at: '2026-11-10T22:52:00Z', minutes_until: 197,
    });
  });

  it('is due from 15 minutes before until a short grace after the estimate', () => {
    expect(NEXT_RUN_DUE_MINUTES).toBe(15);
    expect(describeNextRun(run, '2026-11-10T22:36:00Z').kind).toBe('future');
    expect(describeNextRun(run, '2026-11-10T22:37:00Z').kind).toBe('due');
    expect(describeNextRun(run, '2026-11-10T22:52:00Z').kind).toBe('due');
    const graceEnd = new Date(Date.parse(run.expected_at) + NEXT_RUN_GRACE_MINUTES * 60_000).toISOString();
    expect(describeNextRun(run, graceEnd).kind).toBe('due');
    expect(describeNextRun(run, new Date(Date.parse(graceEnd) + 60_000).toISOString())).toEqual({
      kind: 'overdue', model: 'gfs_0p25', model_name: 'GFS', cycle: '18Z', minutes_late: NEXT_RUN_GRACE_MINUTES + 1,
    });
  });

  it('a saved check reopened the next day never shows a past time', () => {
    const result = describeNextRun([run], '2026-11-11T09:00:00Z');
    expect(result.kind).toBe('overdue');
    expect(result).not.toHaveProperty('expected_at');
  });

  it('skips an overdue entry when a later estimate is still ahead', () => {
    const later = { model: 'ecmwf_ifs_0p25', cycle: '2026-11-11T00:00:00Z', expected_at: '2026-11-11T07:37:00Z' };
    expect(describeNextRun([run, later], '2026-11-11T02:00:00Z')).toMatchObject({
      kind: 'future', model_name: 'ECMWF', cycle: '00Z', expected_at: later.expected_at, minutes_until: 337,
    });
  });

  it('never returns a time that is not after now', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    for (let offset = -600; offset <= 600; offset += 1) {
      const expected = new Date(now + offset * 60_000).toISOString();
      const result = describeNextRun({ model: 'gfs_0p25', expected_at: expected }, new Date(now).toISOString());
      if (result.kind === 'future') expect(Date.parse(result.expected_at)).toBeGreaterThan(now);
    }
  });

  it('has no estimate without usable metadata; legacy entries have no cycle', () => {
    expect(describeNextRun(undefined, '2026-11-10T19:35:00Z')).toEqual({ kind: 'none' });
    expect(describeNextRun([], '2026-11-10T19:35:00Z')).toEqual({ kind: 'none' });
    expect(describeNextRun({ model: 'gfs_0p25', expected_at: 'soon' }, '2026-11-10T19:35:00Z')).toEqual({ kind: 'none' });
    expect(describeNextRun(run, 'not a time')).toEqual({ kind: 'none' });
    expect(describeNextRun({ model: 'gfs_0p25', expected_at: '2026-11-10T22:52:00Z' }, '2026-11-10T19:35:00Z'))
      .toMatchObject({ kind: 'future', cycle: null });
  });

  it('names known models and passes unknown ids through', () => {
    expect(['gfs_0p25', 'ecmwf_ifs_0p25', 'gefs_0p50', 'gfswave_0p25', 'cmems_glo12', 'cmems_ibi', 'dwd_icon_eu_0p0625', 'mystery']
      .map(modelDisplayName)).toEqual(['GFS', 'ECMWF', 'GEFS', 'GFS-Wave', 'Copernicus GLO12', 'Copernicus IBI', 'ICON-EU', 'mystery']);
  });
});
