import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURRENT_ALONG_TRACK_THRESHOLD_KT, contentHash, currentInputRecord, currentSummary, routeSummary } from '../src/index.js';
import { assembleFindings } from '../src/findings.js';
import { runAnalysis } from '../src/analyze.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { deriveLegs } from '../src/route.js';
import type { RegionGrid } from '../src/grids.js';
import type { Findings, LegHour, LimitsProfile, Route } from '../src/types.js';
import { alongEachLeg } from './helpers/samplePoints.js';

const read = <T>(path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const DEMO = read<Findings>('../../viewer/test/fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json');
const GOLDEN = read<Findings>('./golden/findings-cherbourg-plymouth.json');

const H = (n: number) => `2026-07-20T${String(n).padStart(2, '0')}:00:00Z`;
const T = (hour: number, minute = 0) => `2026-07-20T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
type Current = NonNullable<LegHour['current']>;
const current = (along: number, extra: Partial<Current> = {}): Current => ({
  u_kt: along, v_kt: 0, speed_kt: Math.abs(along), set_deg: along >= 0 ? 90 : 270,
  along_kt: along, cross_kt: 0, wind_against_current: false, ...extra,
});
const hour = (h: number, c: Current | null | undefined): LegHour => ({
  valid_time: H(h), wind_kt: 15, gust_kt: null, wind_dir_deg: 270, twa_deg: null, point_of_sail: 'reach',
  limit_status: { sustained: 'ok', gust: 'ok' },
  ...(c === undefined ? {} : { current: c }),
});

interface LegSpec { id: string; enter: string; eta: string; hours: LegHour[] }
function findingsFor(legs: LegSpec[], inputs: Partial<Findings['inputs']> = {}): Findings {
  return {
    departure_utc: legs[0]!.enter,
    inputs: { forecast_tiles: [], route_hash: 'none', ...inputs },
    legs: legs.map((leg) => ({
      leg_id: leg.id, name: `Leg ${leg.id}`,
      enter_range: { slow: leg.enter, nominal: leg.enter, fast: leg.enter },
      eta_range: { slow: leg.eta, nominal: leg.eta, fast: leg.eta },
      hours: leg.hours,
    })),
    evidence: [],
  } as unknown as Findings;
}

describe('currentSummary definitions on hand-built findings', () => {
  it('a following current gains distance; the estimate integrates the leg samples over its nominal time', () => {
    // one leg 00:00 to 03:00, 2 kt along course at every hour: 2 kt x 3 h = 6 nm
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(3), hours: [0, 1, 2, 3].map((h) => hour(h, current(2))) }]))!;
    expect(summary.gain).toEqual({ nm: 6, basis: 'leg_samples' });
    expect(summary.total_hours).toBe(3);
    expect(summary.unavailable_hours).toBe(0);
  });

  it('an opposing current loses distance', () => {
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(2), hours: [0, 1, 2].map((h) => hour(h, current(-1.5))) }]))!;
    expect(summary.gain!.nm).toBeCloseTo(-3, 10);
  });

  it('a cross current neither gains nor loses, but still counts as the strongest current', () => {
    const cross = current(0, { u_kt: 0, v_kt: 2.5, speed_kt: 2.5, set_deg: 0, cross_kt: 2.5 });
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(2), hours: [0, 1, 2].map((h) => hour(h, cross)) }]))!;
    expect(summary.gain!.nm).toBe(0);
    expect(summary.strongest).toEqual({ speed_kt: 2.5, set_deg: 0, valid_time: H(0), leg_id: 'L1' });
  });

  it('a zero current is data (gain 0), not the absence of data', () => {
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(1), hours: [0, 1].map((h) => hour(h, current(0))) }]))!;
    expect(summary.gain!.nm).toBe(0);
    expect(summary.strongest!.speed_kt).toBe(0);
  });

  it('is null when the passage has no current value at all', () => {
    expect(currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(3), hours: [0, 1, 2, 3].map((h) => hour(h, undefined)) }]))).toBeNull();
    expect(currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(3), hours: [0, 1, 2, 3].map((h) => hour(h, null)) }]))).toBeNull();
    expect(currentSummary(null)).toBeNull();
    expect(currentSummary({ legs: [] } as unknown as Findings)).toBeNull();
    // the committed saved checks carry no current sample
    expect(currentSummary(DEMO)).toBeNull();
    expect(currentSummary(GOLDEN)).toBeNull();
  });

  it('counts hours without a current value as not available, and then gives no passage gain', () => {
    const hours = [hour(0, current(2)), hour(1, null), hour(2, current(2)), hour(3, current(2))];
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(3), hours }]))!;
    expect(summary.total_hours).toBe(3);
    expect(summary.unavailable_hours).toBe(1);
    expect(summary.gain).toBeNull();
    expect(summary.strongest!.valid_time).toBe(H(0));
    // a non-finite value is not a value
    const broken = [0, 1].map((h) => hour(h, current(Number.NaN)));
    expect(currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(1), hours: broken }]))).toBeNull();
  });

  it('weights the hourly samples by time inside a leg that starts and ends between hours', () => {
    // leg 00:30 to 01:30; along 0 kt at 00:00, 2 kt at 01:00, 0 kt at 02:00 (linear in between)
    // integral: 00:30-01:00 mean (1+2)/2 x 0.5 h = 0.75; 01:00-01:30 mean (2+1)/2 x 0.5 h = 0.75; total 1.5 nm
    const hours = [hour(0, current(0)), hour(1, current(2)), hour(2, current(0))];
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0, 30), eta: T(1, 30), hours }]))!;
    expect(summary.gain!.nm).toBeCloseTo(1.5, 10);
  });

  it('strongest current: the highest speed over every audited hour of the arrival range, earliest on a tie, with its leg', () => {
    const legs = [
      { id: 'L1', enter: T(0), eta: T(2), hours: [hour(0, current(1)), hour(1, current(3.2)), hour(2, current(3.2))] },
      { id: 'L2', enter: T(2), eta: T(4), hours: [hour(2, current(3.2)), hour(3, current(-3.2))] },
    ];
    expect(currentSummary(findingsFor(legs))!.strongest).toEqual({ speed_kt: 3.2, set_deg: 90, valid_time: H(1), leg_id: 'L1' });
    // 04:00 lies outside every expected-timing window but inside L2's arrival range: it counts
    legs[1]!.hours.push(hour(4, current(9)));
    expect(currentSummary(findingsFor(legs))!.strongest).toEqual({ speed_kt: 9, set_deg: 90, valid_time: H(4), leg_id: 'L2' });
  });

  it('counts wind-against-current hours on the expected timing once per hour, and every flagged hour instant of the arrival range', () => {
    const wac = (along: number) => current(along, { wind_against_current: true });
    const legs = [
      // L1's hours overlap L2's (02:00 audited by both): counted once, in L2
      { id: 'L1', enter: T(0), eta: T(2), hours: [hour(0, wac(-2)), hour(1, current(-2)), hour(2, wac(-2))] },
      { id: 'L2', enter: T(2), eta: T(4), hours: [hour(2, wac(-2)), hour(3, wac(-2)), hour(4, wac(-2))] },
    ];
    const summary = currentSummary(findingsFor(legs))!;
    expect(summary.wind_against_current_hours).toBe(3);
    // 00, 02, 03, 04: four distinct instants, 02:00 once although two legs flag it
    expect(summary.wind_against_current_arrival_hours).toBe(4);
  });

  it('sees wind against current outside the expected timing that the expected-timing count misses', () => {
    const legs = [{ id: 'L1', enter: T(0), eta: T(2), hours: [hour(0, current(0.5)), hour(1, current(0.5)), hour(2, current(3.1, { wind_against_current: true }))] }];
    const summary = currentSummary(findingsFor(legs))!;
    expect(summary.wind_against_current_hours).toBe(0);
    expect(summary.wind_against_current_arrival_hours).toBe(1);
    expect(summary.strongest!.speed_kt).toBe(3.1);
  });

  it('counts the same hours as routeSummary', () => {
    const legs = Array.from({ length: 30 }, (_, i) => ({
      id: `L${i + 1}`, enter: T(Math.floor(i * 40 / 60), (i * 40) % 60), eta: T(Math.floor((i + 1) * 40 / 60), ((i + 1) * 40) % 60),
      hours: [Math.floor(i * 40 / 60), Math.floor(i * 40 / 60) + 1].map((h) => hour(h, current(1))),
    }));
    const findings = findingsFor(legs);
    expect(currentSummary(findings)!.total_hours).toBe(routeSummary(findings)!.total_hours);
    // and on the committed saved checks once they carry a current value at every hour
    for (const saved of [DEMO, GOLDEN]) {
      const withCurrent = structuredClone(saved);
      for (const leg of withCurrent.legs) for (const h of leg.hours) h.current = current(0.5);
      expect(currentSummary(withCurrent)!.total_hours).toBe(routeSummary(withCurrent)!.total_hours);
      expect(currentSummary(withCurrent)!.unavailable_hours).toBe(0);
    }
  });

  it('gives no hours with and against the current without a recorded current grid', () => {
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(2), hours: [0, 1, 2].map((h) => hour(h, current(2))) }]), undefined)!;
    expect(summary.with_against).toBeNull();
  });
});

// ---- hours with and against the current ----

const IBI = { source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run_id: 'cmems-ibi-20260719T19Z', current_source: 'prepared', time_step_h: 1 };
const GLO12_TILES = { source: 'tiles', layer: 'currents', model: 'cmems_glo12 tiles (currents-20260720T00Z)', run_id: 'currents-20260720T00Z', current_source: 'tiles', time_step_h: 6 };
const withRecord = (legs: LegSpec[], ...records: Array<Record<string, unknown>>) => findingsFor(legs, { forecast_tiles: records });

describe('hours with and against the current', () => {
  // A current rotating through every case, one value per hour; 03:00 audited by both legs (counted once, in L2).
  const cross = current(0.2, { u_kt: 0.2, v_kt: 1.8, speed_kt: 1.81, set_deg: 6, cross_kt: 1.8 });
  const rotating = (): LegSpec[] => [
    { id: 'L1', enter: T(0), eta: T(3), hours: [hour(0, current(1.4)), hour(1, current(-1.2)), hour(2, cross), hour(3, current(0.9))] },
    { id: 'L2', enter: T(3), eta: T(9), hours: [hour(3, current(-2)), hour(4, current(0.3)), hour(5, current(0.5)), hour(6, current(-0.5)),
      hour(7, current(0.51)), hour(8, null)] },
  ];

  it('counts each hour of the expected timing once: with, against, across or weak, and missing apart', () => {
    const summary = currentSummary(withRecord(rotating(), IBI))!;
    // with: 00 (1.4), 07 (0.51); against: 01 (-1.2), 03 (-2, L2's value, not L1's 0.9);
    // across or weak: 02 (cross), 04 (0.3), 05 (exactly 0.5), 06 (exactly -0.5); missing: 08
    expect(summary.with_against).toEqual({ with_hours: 2, against_hours: 2, across_or_weak_hours: 4, time_step_h: 1, threshold_kt: CURRENT_ALONG_TRACK_THRESHOLD_KT });
    expect(summary.unavailable_hours).toBe(1);
    const { with_hours, against_hours, across_or_weak_hours } = summary.with_against!;
    expect(with_hours + against_hours + across_or_weak_hours + summary.unavailable_hours).toBe(summary.total_hours);
    expect(summary.total_hours).toBe(9);
  });

  it('the threshold is half a knot along the track, strictly exceeded', () => {
    expect(CURRENT_ALONG_TRACK_THRESHOLD_KT).toBe(0.5);
  });

  it('adds up to the nominal passage time within one hour on legs that start and end between hours', () => {
    const legs = Array.from({ length: 12 }, (_, i) => ({
      id: `L${i + 1}`, enter: T(Math.floor(i * 50 / 60), (i * 50) % 60), eta: T(Math.floor((i + 1) * 50 / 60), ((i + 1) * 50) % 60),
      hours: [Math.floor(i * 50 / 60), Math.floor(i * 50 / 60) + 1].map((h) => hour(h, h % 3 === 0 ? null : current(h % 2 ? 1 : -1))),
    }));
    const findings = withRecord(legs, IBI);
    const summary = currentSummary(findings)!;
    const { with_hours, against_hours, across_or_weak_hours } = summary.with_against!;
    expect(with_hours + against_hours + across_or_weak_hours + summary.unavailable_hours).toBe(summary.total_hours);
    const nominalHours = (Date.parse(legs.at(-1)!.eta) - Date.parse(legs[0]!.enter)) / 3600_000;
    expect(Math.abs(summary.total_hours - nominalHours)).toBeLessThanOrEqual(1);
    expect(summary.total_hours).toBe(routeSummary(findings)!.total_hours);
  });

  it('is given for an hourly or finer grid of a product that includes tide, and for nothing else', () => {
    const legs = rotating();
    const shown = (...records: Array<Record<string, unknown>>) => currentSummary(withRecord(legs, ...records))!.with_against !== null;
    expect(shown(IBI)).toBe(true);
    expect(shown({ ...IBI, time_step_h: 0.25 })).toBe(true);
    // coarse, absent (checks saved before the step was recorded), unknown
    expect(shown({ ...IBI, time_step_h: 3 })).toBe(false);
    expect(shown({ ...IBI, time_step_h: 1.5 })).toBe(false);
    const { time_step_h: _step, ...older } = IBI;
    expect(shown(older)).toBe(false);
    expect(shown({ ...IBI, time_step_h: null })).toBe(false);
    expect(shown({ ...IBI, time_step_h: '1' })).toBe(false);
    expect(shown({ ...IBI, time_step_h: 0 })).toBe(false);
    // tiles: the 6-hourly global layer, even if a record claimed an hourly step, and
    // even hourly IBI tiles (no audit reads them; enabling them is a decision of its own)
    expect(shown(GLO12_TILES)).toBe(false);
    expect(shown({ ...GLO12_TILES, time_step_h: 1 })).toBe(false);
    expect(shown({ ...IBI, model: 'cmems_ibi tiles (currents-ibi-20260720T00Z)', source: 'tiles', current_source: 'tiles' })).toBe(false);
    expect(shown({ ...IBI, current_source: 'tiles' })).toBe(false);
    // emulated values, even with an IBI id and an hourly step
    expect(shown({ ...IBI, source_kind: 'emulated' })).toBe(false);
    expect(shown({ ...IBI, mode: 'synthetic' })).toBe(false);
    expect(shown({ ...IBI, source: 'synthetic' })).toBe(false);
    // a model whose tide is not recorded, or no model at all
    expect(shown({ ...IBI, model: 'cmems_mod_nws_phy-cur_anfc_0.027deg_PT1H-m' })).toBe(false);
    expect(shown({ ...IBI, model: 'cmems' })).toBe(false);
    expect(shown({ ...IBI, model: 'scenario' })).toBe(false);
    expect(shown({ ...IBI, model: undefined })).toBe(false);
    // mixed sources: more than one current record
    expect(shown(IBI, { ...IBI, run_id: 'another' })).toBe(false);
    expect(shown(IBI, GLO12_TILES)).toBe(false);
    // an unavailable record is not a source
    expect(shown(IBI, { layer: 'currents', source: 'tiles', available: false })).toBe(true);
    // an older check's legacy grid record carries no step
    const legacy = findingsFor(legs, { forecast_tiles: [] });
    (legacy.inputs as Record<string, unknown>).openmeteo = [{ api: 'cmems-current-grid', model: IBI.model, run: IBI.run_id, mode: 'live' }];
    expect(currentSummary(legacy)!.with_against).toBeNull();
  });

  it('the committed saved checks run without throwing and get no figures', () => {
    const LEGACY = read<Findings>('./fixtures/legacy-current-snapshot/findings.json');
    const COMPAT = read<Findings>('../../viewer/test/fixtures/compatibility/20260720T060000Z_44d2cd5f_4196266b/findings.json');
    const OTHER = read<Findings>('../../viewer/test/fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_7b2600cd/findings.json');
    for (const saved of [DEMO, GOLDEN, COMPAT, OTHER, LEGACY]) {
      expect(() => currentSummary(saved)).not.toThrow();
      expect(currentSummary(saved)?.with_against ?? null).toBeNull();
    }
  });
});

describe('hours with and against the current, through the audit', () => {
  const profile = read<LimitsProfile>('../../config/profiles/default-limits.json');
  const start = Date.parse('2026-07-20T05:00:00Z');
  const times = Array.from({ length: 12 }, (_, h) => new Date(start + h * 3600_000).toISOString());
  // spatially uniform, rotating through the hours: 2 kt east, 2 kt west, 2 kt north, 0.2 kt east, ...
  const pattern: Array<[number, number]> = [[2, 0], [-2, 0], [0, 2], [0.2, 0]];
  function hourlyGrid(datasetId = 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m'): RegionGrid {
    const nlat = 4, nlon = 6;
    const u = times.flatMap((_, t) => Array(nlat * nlon).fill(pattern[t % 4]![0]));
    const v = times.flatMap((_, t) => Array(nlat * nlon).fill(pattern[t % 4]![1]));
    return { schema_version: 1, kind: 'surface_current', run_id: 'cmems-ibi-20260719T19Z', generated_at: '2026-07-19T19:30:00Z',
      lat0: 49.0, lon0: -3.0, dlat: 0.2, dlon: 0.2, nlat, nlon, time_axis: times, u_kt: u, v_kt: v,
      source: { mode: 'live', dataset_id: datasetId, resolution_deg: 0.2, fetched_at: '2026-07-19T19:20:00Z' } };
  }
  // One leg due east and its reverse (about 27 nm), timed on speeds over the ground (an older
  // computed route's basis) so the current does not move the ETA: both ways share the same
  // expected hours and the same midpoint.
  const eastward = { schema_version: 1, route_id: 'east', name: 'east', mode: 'user', timing: { basis: 'speed_over_ground' },
    waypoints: [{ id: 'a', lat: 49.3, lon: -2.8 }, { id: 'b', lat: 49.3, lon: -2.1 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } } as Route;
  const westward: Route = { ...eastward, route_id: 'west', waypoints: [...eastward.waypoints].reverse() } as Route;
  function audit(route: Route, grid = hourlyGrid()) {
    const legTimes = times;
    return assembleFindings({ route, profile, departureUtc: '2026-07-20T06:00:00Z', nowMs: 1, engineVersion: 'test', requestMeta: [],
      pointForecasts: alongEachLeg(route, [{ lat: 49.3, lon: -2.45, times: legTimes, wind_kt: legTimes.map(() => 10), gust_kt: legTimes.map(() => 14), wind_dir_deg: legTimes.map(() => 200) }]),
      currentGrid: grid,
      currentProvenance: { source: 'prepared-artifact', layer: 'currents', model: grid.source.dataset_id, run_id: grid.run_id, current_source: 'prepared',
        content_digest: contentHash(grid), digest_algorithm: 'fnv1a64' } });
  }

  it('a real check on an hourly IBI grid records step 1 and counts the rotating current exactly', () => {
    const findings = audit(eastward);
    expect(findings.inputs.forecast_tiles.find((item: Record<string, unknown>) => item.layer === 'currents')!.time_step_h).toBe(1);
    const summary = currentSummary(findings)!;
    // independent reading: every hour on the expected timing, by the grid's pattern at that hour
    const kinds = { with: 0, against: 0, weak: 0 };
    const leg = findings.legs[0]!;
    for (let t = Math.ceil(Date.parse(leg.enter_range.nominal) / 3600_000) * 3600_000; t < Date.parse(leg.eta_range.nominal); t += 3600_000) {
      const [u] = pattern[Math.round((t - start) / 3600_000) % 4]!;
      if (u > 0.5) kinds.with += 1; else if (u < -0.5) kinds.against += 1; else kinds.weak += 1;
    }
    expect(summary.with_against).toMatchObject({ with_hours: kinds.with, against_hours: kinds.against, across_or_weak_hours: kinds.weak });
    expect(kinds.with + kinds.against + kinds.weak).toBe(summary.total_hours);
    expect(kinds.with).toBeGreaterThan(0);
    expect(kinds.against).toBeGreaterThan(0);
  });

  it('the same passage reversed 180 degrees swaps with and against', () => {
    const east = currentSummary(audit(eastward))!;
    const west = currentSummary(audit(westward))!;
    expect(west.total_hours).toBe(east.total_hours);
    expect(west.with_against!.with_hours).toBe(east.with_against!.against_hours);
    expect(west.with_against!.against_hours).toBe(east.with_against!.with_hours);
    expect(west.with_against!.across_or_weak_hours).toBe(east.with_against!.across_or_weak_hours);
  });

  it('a synthetic grid with the IBI id and an hourly axis: the step is recorded, no figures', () => {
    const synthetic = hourlyGrid();
    synthetic.source = { ...synthetic.source, mode: 'synthetic' };
    const findings = audit(eastward, synthetic);
    const record = findings.inputs.forecast_tiles.find((item: Record<string, unknown>) => item.layer === 'currents')!;
    expect(record).toMatchObject({ time_step_h: 1, source_kind: 'emulated', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m' });
    const summary = currentSummary(findings)!;
    expect(summary.strongest).not.toBeNull();
    expect(summary.with_against).toBeNull();
  });

  it('the same values on a 3-hourly grid with the same hourly-sounding id: no figures', () => {
    const thinned = hourlyGrid();
    const keep = [0, 3, 6, 9];
    const cells = 4 * 6;
    const coarse: RegionGrid = { ...thinned, time_axis: keep.map((t) => times[t]!),
      u_kt: keep.flatMap((t) => thinned.u_kt.slice(t * cells, (t + 1) * cells)), v_kt: keep.flatMap((t) => thinned.v_kt.slice(t * cells, (t + 1) * cells)) };
    const summary = currentSummary(audit(eastward, coarse))!;
    expect(summary.with_against).toBeNull();
    expect(summary.strongest).not.toBeNull();
  });
});
describe('currentInputRecord', () => {
  it('reads the current grid record, skipping an unavailable one, then the legacy record', () => {
    const tiles = { source: 'tiles', layer: 'currents', model: 'cmems_glo12 tiles (currents-20260720T00Z)', run_id: 'currents-20260720T00Z', mode: 'live', current_source: 'tiles' };
    expect(currentInputRecord({ inputs: { forecast_tiles: [{ layer: 'weather', model: 'gfs' }, tiles] } } as unknown as Findings)).toEqual(tiles);
    expect(currentInputRecord({ inputs: { forecast_tiles: [{ layer: 'currents', source: 'tiles', available: false }] } } as unknown as Findings)).toBeNull();
    const legacy = { api: 'cmems-current-grid', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run: 'cmems-ibi-20260711T19Z', mode: 'live' };
    expect(currentInputRecord({ inputs: { forecast_tiles: [], openmeteo: [{ api: 'forecast' }, legacy] } } as unknown as Findings)).toEqual(legacy);
    expect(currentInputRecord(DEMO)).toBeNull();
  });
});

// ---- a computed route with a known 2 kt following current (saved router output) ----

const profile = read<LimitsProfile>('../../config/profiles/default-limits.json');
const ROUTED = read<Route>('./fixtures/routes/routed-current.json');
const departureUtc = '2026-07-20T00:00:00Z';
function currentGrid(u: number, runId = 'test-surface_current-2'): RegionGrid {
  return {
    schema_version: 1, kind: 'surface_current', run_id: runId, generated_at: departureUtc,
    lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
    time_axis: [departureUtc, '2026-07-24T00:00:00Z'],
    u_kt: Array(24).fill(u), v_kt: Array(24).fill(0), source: { mode: 'synthetic' },
  };
}
function store(grid: RegionGrid) {
  const times = Array.from({ length: 97 }, (_, h) => new Date(Date.parse(departureUtc) + h * 3600_000).toISOString().slice(0, 16));
  const result = new ScenarioBundleStore({ loadBundle: async (name) => name === 'forecast' ? {
    hourly: { time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90) },
  } : null });
  result.getCurrentGrid = async () => grid;
  return result;
}

describe('currentSummary on a saved computed route', () => {
  it('takes the gain from the route\'s own timing: a hand calculation of 2 kt over the routed time', async () => {
    const route = structuredClone(ROUTED);
    const { findings } = await runAnalysis({ route, profile, departureUtc, store: store(currentGrid(2)) });
    expect(findings.inputs.route_hash).toBe(contentHash(route));
    const summary = currentSummary(findings, route)!;
    // independent reading of the fixture: 2 kt (SOG 7 - STW 5) for 6,016,087 ms
    const leg = route.timing!.basis === 'routed' ? route.timing!.legs[0]! : null;
    const hoursNominal = 6016087.486816406 / 3600_000;
    expect(leg!.duration_ms.nominal).toBe(6016087.486816406);
    expect(summary.gain!.basis).toBe('routed_timing');
    expect(summary.gain!.nm).toBeCloseTo(2 * hoursNominal, 4); // 3.342 nm
    // the same figure as distance over ground minus distance through the water
    expect(summary.gain!.nm).toBeCloseTo(deriveLegs(route)[0]!.distance_nm - 5 * hoursNominal, 2);
    // the current samples of the check agree: 2 kt east along a due-east leg
    expect(summary.strongest!.speed_kt).toBeCloseTo(2, 6);
    expect(summary.total_hours).toBe(routeSummary(findings)!.total_hours);
  });

  it('without the route (or with a route the check did not hash) the estimate stays close and is labelled an estimate', async () => {
    const route = structuredClone(ROUTED);
    const { findings } = await runAnalysis({ route, profile, departureUtc, store: store(currentGrid(2)) });
    const estimate = currentSummary(findings)!;
    expect(estimate.gain!.basis).toBe('leg_samples');
    // not the 4.0 nm that counting two whole hours at 2 kt would give
    expect(estimate.gain!.nm).toBeCloseTo(2 * 6016087.486816406 / 3600_000, 1);
    const other = { ...structuredClone(route), name: 'edited' };
    expect(currentSummary(findings, other)!.gain!.basis).toBe('leg_samples');
  });

  it('does not use the route\'s timing when the route was routed on another current than the check read', async () => {
    const route = structuredClone(ROUTED);
    const { findings } = await runAnalysis({ route, profile, departureUtc, store: store(currentGrid(2, 'another-run')) });
    expect(currentSummary(findings, route)!.gain!.basis).toBe('leg_samples');
    const noCurrent = structuredClone(route);
    (noCurrent.provenance!.routing_request as Record<string, unknown>).current_run = null;
    const audited = await runAnalysis({ route: noCurrent, profile, departureUtc, store: store(currentGrid(2)) });
    expect(currentSummary(audited.findings, noCurrent)!.gain!.basis).toBe('leg_samples');
  });

  it('a drawn route over the same water: an estimate from the leg samples, with the ETA that already includes them', async () => {
    const drawn: Route = { schema_version: 1, route_id: 'drawn', name: 'drawn', mode: 'user',
      waypoints: ROUTED.waypoints, speeds_kt: { slow: 4, nominal: 5, fast: 6 }, timing: { basis: 'through_water' } };
    const { findings } = await runAnalysis({ route: drawn, profile, departureUtc, store: store(currentGrid(2)) });
    const summary = currentSummary(findings, drawn)!;
    const legHours = (Date.parse(findings.legs[0]!.eta_range.nominal) - Date.parse(findings.legs[0]!.enter_range.nominal)) / 3600_000;
    expect(summary.gain).toEqual({ nm: expect.closeTo(2 * legHours, 6), basis: 'leg_samples' });
    // an opposing current loses
    const against = await runAnalysis({ route: drawn, profile, departureUtc, store: store(currentGrid(-2)) });
    expect(currentSummary(against.findings, drawn)!.gain!.nm).toBeLessThan(0);
  });
});

describe('routed gain on a prepared grid', () => {
  // A computed route stamped as routed on a prepared grid with digest D, and a check whose current record names a digest.
  function preparedCase(recordDigest: string) {
    const route = structuredClone(ROUTED);
    route.provenance = { ...route.provenance, routing_request: {
      ...(route.provenance!.routing_request as Record<string, unknown>), current_source: 'prepared', current_digest: 'D', current_run: 'cmems-ibi-20260719T19Z' } };
    const leg = ROUTED.timing!.basis === 'routed' ? ROUTED.timing!.legs[0]! : null;
    const end = new Date(Date.parse(departureUtc) + leg!.duration_ms.nominal).toISOString();
    const findings = findingsFor([{ id: 'L1', enter: departureUtc, eta: end, hours: [0, 1, 2].map((h) => hour(h, current(1))) }], {
      route_hash: contentHash(route),
      forecast_tiles: [{ source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run_id: 'cmems-ibi-20260719T19Z', current_source: 'prepared', content_digest: recordDigest }],
    });
    return currentSummary(findings, route)!;
  }
  it('uses the route\'s own figures when the check recorded the same digest', () => {
    const summary = preparedCase('D');
    expect(summary.gain!.basis).toBe('routed_timing');
    expect(summary.gain!.nm).toBeCloseTo(2 * 6016087.486816406 / 3600_000, 4);
  });
  it('falls back to the estimate when the digest differs', () => {
    const summary = preparedCase('E');
    expect(summary.gain!.basis).toBe('leg_samples');
    expect(summary.gain!.nm).toBeCloseTo(6016087.486816406 / 3600_000, 6); // the injected 1 kt samples
  });
  it('keeps the current_run guard: a tile record and a route without a run would otherwise match on two missing values', () => {
    const route = structuredClone(ROUTED);
    delete (route.provenance!.routing_request as Record<string, unknown>).current_run;
    const leg = ROUTED.timing!.basis === 'routed' ? ROUTED.timing!.legs[0]! : null;
    const end = new Date(Date.parse(departureUtc) + leg!.duration_ms.nominal).toISOString();
    const findings = findingsFor([{ id: 'L1', enter: departureUtc, eta: end, hours: [0, 1, 2].map((h) => hour(h, current(1))) }], {
      route_hash: contentHash(route), forecast_tiles: [{ source: 'tiles', layer: 'currents', current_source: 'tiles' }],
    });
    expect(currentSummary(findings, route)!.gain!.basis).toBe('leg_samples');
  });
});

describe('the block never understates the check\'s own wind-against-current hazard', () => {
  it('a strong flagged current only in the slow arrival range: the strongest current is at least the T-WAC-01 value', async () => {
    // 0.5 kt east until 02:00, then 3.1 kt east from 03:00; the wind blows from the east at 12 kt
    const times = [0, 1, 2, 3, 4, 5].map((h) => new Date(Date.parse(departureUtc) + h * 3600_000).toISOString());
    const u = [0.5, 0.5, 0.5, 3.1, 3.1, 3.1].flatMap((value) => Array(12).fill(value));
    const grid: RegionGrid = { ...currentGrid(0.5, 'step-run'), time_axis: times, u_kt: u, v_kt: u.map(() => 0) };
    const drawn: Route = { schema_version: 1, route_id: 'drawn', name: 'drawn', mode: 'user',
      waypoints: ROUTED.waypoints, speeds_kt: { slow: 4, nominal: 5, fast: 6 }, timing: { basis: 'through_water' } };
    const { findings } = await runAnalysis({ route: drawn, profile, departureUtc, store: store(grid) });
    const evidence = findings.evidence.find((item) => item.rule_id === 'T-WAC-01');
    expect(evidence, 'the check raises the hazard').toBeDefined();
    const hazardKt = Number(/^([\d.]+) kt/.exec(String(evidence!.value))![1]);
    const summary = currentSummary(findings, drawn)!;
    expect(summary.wind_against_current_hours).toBe(0); // nothing on the expected timing
    expect(summary.wind_against_current_arrival_hours).toBeGreaterThan(0);
    expect(summary.strongest!.speed_kt).toBeGreaterThanOrEqual(hazardKt);
    expect(summary.strongest!.valid_time).toBe(evidence!.valid_time);
  });
});
