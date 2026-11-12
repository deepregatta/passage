import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash, currentInputRecord, currentSummary, routeSummary } from '../src/index.js';
import { runAnalysis } from '../src/analyze.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { deriveLegs } from '../src/route.js';
import type { RegionGrid } from '../src/grids.js';
import type { Findings, LegHour, LimitsProfile, Route } from '../src/types.js';

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

  it('offers no hours with and against the current: no saved record establishes a tide-resolving source', () => {
    const summary = currentSummary(findingsFor([{ id: 'L1', enter: T(0), eta: T(2), hours: [0, 1, 2].map((h) => hour(h, current(2))) }]), undefined)!;
    expect(Object.keys(summary).sort()).toEqual(['gain', 'strongest', 'total_hours', 'unavailable_hours', 'wind_against_current_arrival_hours', 'wind_against_current_hours']);
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
