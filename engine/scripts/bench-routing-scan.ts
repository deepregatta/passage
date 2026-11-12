/**
 * Engine cost of Compute and of a computed departure scan, in Node, on
 * synthetic inputs the size of the real ones (docs/maintenance/
 * 2026-11-12-scan-responsiveness.md). It calls the same engine functions the
 * planner controller calls (selectRoutingCurrent -> computeRoute for every
 * departure, then scanDepartures -> runAnalysis for every route), on a real
 * TileForecastStore reading in-memory PFT1 tiles, and the real coastline mask.
 * No network, no polar service: the polar is a formula-built invented one.
 *
 *   npm run bench:routing -w engine                      all passages, 5 runs
 *   npm run bench:routing -w engine -- --runs 3 --only channel-63nm
 *   npm run bench:routing -w engine -- --json ../output/perf/node.json
 *
 * Milliseconds, wall clock, one process. A measurement tool, not a test: it asserts nothing.
 *
 * One "run" is the sequence a visitor follows: a fresh store (nothing decoded),
 * Compute, then the departure scan (its audit layers decode on the way), then
 * the scan again with everything decoded.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { computeRoute, type RoutingResult } from '../src/routing/isochrone.js';
import { polarFromRelease } from '../src/routing/deepPolars.js';
import { snapToSea, windowLandMask, type PackedLandMaskMetadata } from '../src/routing/landmaskPack.js';
import { routeBbox, passageMaxHours } from '../src/fetch/liveGrids.js';
import { selectRoutingCurrent } from '../src/currentInput.js';
import { candidateDepartures, scanDepartures } from '../src/window.js';
import { TileForecastStore } from '../src/forecast/tileStore.js';
import { runAnalysis } from '../src/analyze.js';
import { contentHash } from '../src/hash.js';
import { haversineNm } from '../src/geo.js';
import { parseUtc } from '../src/eta.js';
import type { RegionGrid } from '../src/grids.js';
import type { LimitsProfile, Route } from '../src/types.js';
import {
  DEPARTURE_ISO, NOW_ISO, PASSAGES, INVENTED_POLAR_ENTRY, buildPerfTransport, preparedCurrentGrid, type Passage,
} from './perf/scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = (name: string) => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] : undefined; };
const RUNS = Number(flag('runs') ?? 5);
const VARIANT_RUNS = Math.min(RUNS, 3);
const ONLY = flag('only');
const JSON_OUT = flag('json');

const FORECAST_HOURS = 240; // viewer/src/lib/routingInputs.js
const NOW_MS = parseUtc(NOW_ISO);
const polar = polarFromRelease(INVENTED_POLAR_ENTRY);
const profile: LimitsProfile = JSON.parse(readFileSync(join(REPO, 'config/profiles/default-limits.json'), 'utf8'));
const maskMeta: PackedLandMaskMetadata = JSON.parse(readFileSync(join(REPO, 'viewer/public/data/land/global-005.json'), 'utf8'));
const maskBytes = new Uint8Array(gunzipSync(readFileSync(join(REPO, 'viewer/public/data/land/global-005.bin.gz'))));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const worst = (xs: number[]) => Math.max(...xs);
const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));
const stat = (xs: number[]) => ({ median: median(xs), worst: worst(xs), runs: xs.map((x) => Math.round(x * 10) / 10) });
const show = (xs: number[]) => `${fmt(median(xs))} ms median, ${fmt(worst(xs))} ms worst`;

/** Wall time of `work`, and the longest gap between two turns of the event loop while it ran (the longest block). */
async function timed<T>(work: () => Promise<T> | T): Promise<{ value: T; ms: number; longestGapMs: number }> {
  let last = performance.now();
  let longest = 0;
  let running = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const t0 = performance.now();
  const value = await work();
  const ms = performance.now() - t0;
  running = false;
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  return { value, ms, longestGapMs: longest };
}

/** Deep freeze, as viewer/src/lib/actionInputs.js freezeInput does to the scan's action inputs. */
function freezeInput<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeInput);
    Object.freeze(value);
  }
  return value;
}

interface Inputs {
  windGrid: RegionGrid; currentGrid: RegionGrid | null; landMask: ReturnType<typeof windowLandMask>; maxHours: number;
  start: { lat: number; lon: number; name: string }; finish: { lat: number; lon: number; name: string };
}

/** What loadRoutingInputs (viewer/src/lib/routingInputs.js) does after the polar download. */
async function loadInputs(store: TileForecastStore, p: Passage, scanning: boolean): Promise<Inputs> {
  const bbox = routeBbox(p.start, p.finish);
  const maxHours = passageMaxHours(p.start, p.finish);
  const departureMs = Date.parse(DEPARTURE_ISO);
  const remaining = Math.floor((NOW_MS + FORECAST_HOURS * 3600_000 - departureMs) / 3600_000);
  const hours = Math.min((scanning ? 120 : 0) + maxHours + 6, remaining);
  const landMask = windowLandMask(maskBytes, maskMeta, bbox);
  const start = snapToSea(landMask, p.start);
  const finish = snapToSea(landMask, p.finish);
  if (!start || !finish) throw new Error(`${p.id}: endpoint on land`);
  const windGrid = await store.getWindGrid(bbox, DEPARTURE_ISO, hours);
  const currentGrid = await store.getCurrentGrid(bbox, DEPARTURE_ISO, hours);
  return { windGrid, currentGrid, landMask, maxHours, start: { ...start, name: 'Start' }, finish: { ...finish, name: 'Finish' } };
}

const routeForDeparture = (inputs: Inputs, departureUtc: string, currentGrid: RegionGrid | undefined, strictCurrent: boolean): RoutingResult =>
  computeRoute({
    start: inputs.start, finish: inputs.finish, departureUtc, polar, polarScaling: 1, windGrid: inputs.windGrid,
    currentGrid, ...(strictCurrent ? { strictCurrent: true } : {}), landMask: inputs.landMask, maxHours: inputs.maxHours,
  });

/** viewer/src/pages/planner/usePlannerController.jsx routeOnOneCurrent, counting the computeRoute calls. */
function routeOnOneCurrent(inputs: Inputs, departures: string[], prepared?: { currentGrid: RegionGrid; currentGridProvenance: Record<string, unknown> }) {
  let calls = 0;
  const selection = selectRoutingCurrent({
    departures,
    route: (departureUtc, currentGrid, strictCurrent) => { calls += 1; return routeForDeparture(inputs, departureUtc, currentGrid, strictCurrent); },
    tileGrid: inputs.currentGrid,
    ...(prepared ? { prepared: prepared.currentGrid, preparedProvenance: prepared.currentGridProvenance } : {}),
  });
  return { ...selection, calls };
}

/** The input record a prepared grid carries (viewer/src/lib/preparedCurrent.js artifactRecord), with its digest. */
const preparedRecord = (grid: RegionGrid) => ({ source: 'prepared-artifact', layer: 'currents', content_digest: contentHash(grid), digest_algorithm: 'fnv1a64' });

const dims = (g: RegionGrid | null) => (g ? `${g.nlat}x${g.nlon}x${g.time_axis.length}` : 'none');
const rows: Array<Record<string, unknown>> = [];
const out = (line: string) => console.log(line);

/** One departure scan as the controller runs it: route every candidate, then audit every route. */
async function scanOnce(store: TileForecastStore, p: Passage, departures: string[], load: Inputs, prepared?: { currentGrid: RegionGrid; currentGridProvenance: Record<string, unknown> }) {
  const routing = await timed(() => {
    const sel = routeOnOneCurrent(load, departures, prepared);
    freezeInput(sel.currentInput);
    return sel;
  });
  const sel = routing.value;
  const routes: Record<string, Route> = {};
  for (const [dep, outcome] of sel.results) if (outcome.result) routes[dep] = outcome.result.route;
  const first = Object.values(routes)[0];
  if (!first) throw new Error(`${p.id}: no candidate routed`);
  const audit = await timed(() => scanDepartures({
    route: first, profile, store, currentInput: sel.currentInput,
    routeFor: (dep) => { const r = routes[dep]; if (!r) throw new Error('not routed'); return r; },
    dateWindow: { startDate: DEPARTURE_ISO.slice(0, 10), endDate: new Date(Date.parse(departures.at(-1)!) + (load.maxHours + 24) * 3600_000).toISOString().slice(0, 10) },
  }, departures));
  return {
    routeMs: routing.ms, routeBlockMs: routing.longestGapMs, auditMs: audit.ms, auditBlockMs: audit.longestGapMs,
    calls: sel.calls, routed: Object.keys(routes).length, skipped: audit.value.skipped.length, audited: audit.value.candidates.length,
    source: String(sel.currentInput.provenance?.current_source), fallback: String(sel.currentInput.provenance?.fallback_reason ?? ''),
  };
}

async function benchPassage(p: Passage) {
  const distanceNm = haversineNm(p.start.lat, p.start.lon, p.finish.lat, p.finish.lon);
  out(`\n=== ${p.id}: ${p.label}  [${distanceNm.toFixed(1)} nm]`);
  const transport = buildPerfTransport(p.residual);
  const newStore = () => new TileForecastStore({ transport, now: () => NOW_MS });
  const departures = candidateDepartures(Date.parse(DEPARTURE_ISO), 120, 6);

  const compute = { load: [] as number[], route: [] as number[], total: [] as number[], loadBlock: [] as number[] };
  const scanCold = { load: [] as number[], route: [] as number[], audit: [] as number[], total: [] as number[], routeBlock: [] as number[], auditBlock: [] as number[] };
  const scanWarm = { load: [] as number[], route: [] as number[], audit: [] as number[], total: [] as number[], routeBlock: [] as number[], auditBlock: [] as number[] };
  let sizes = {}; let resolution = 0; let nodesSettled = 0; let detail = ''; let scanFacts = { calls: 0, routed: 0, skipped: 0, audited: 0 };
  let lastStore = newStore();
  let scanInputs: Inputs | undefined;
  for (let run = 0; run < RUNS; run++) {
    const store = (lastStore = newStore());
    // Compute
    const load = await timed(() => loadInputs(store, p, false));
    const computeInputs = load.value;
    const t0 = performance.now();
    const sel = routeOnOneCurrent(computeInputs, [DEPARTURE_ISO]);
    const routeMs = performance.now() - t0;
    const outcome = sel.results.get(DEPARTURE_ISO)!;
    if (!outcome.result) throw outcome.error;
    compute.load.push(load.ms); compute.loadBlock.push(load.longestGapMs); compute.route.push(routeMs); compute.total.push(load.ms + routeMs);
    nodesSettled = outcome.result.steps_used;
    resolution = (outcome.result.route.provenance as { routing_request: { resolution_deg: number } }).routing_request.resolution_deg;
    detail = `passage ${outcome.result.duration_h} h, ${outcome.result.route.waypoints.length} waypoints`;
    // Scan, then the same scan again with every tile decoded
    for (const [target, label] of [[scanCold, 'cold'], [scanWarm, 'warm']] as const) {
      const scanLoad = await timed(() => loadInputs(store, p, true));
      scanInputs = scanLoad.value;
      const s = await scanOnce(store, p, departures, scanInputs);
      target.load.push(scanLoad.ms); target.route.push(s.routeMs); target.audit.push(s.auditMs);
      target.total.push(scanLoad.ms + s.routeMs + s.auditMs); target.routeBlock.push(s.routeBlockMs); target.auditBlock.push(s.auditBlockMs);
      scanFacts = { calls: s.calls, routed: s.routed, skipped: s.skipped, audited: s.audited };
      if (run === 0 && label === 'cold') {
        sizes = { computeWind: dims(computeInputs.windGrid), computeCurrent: dims(computeInputs.currentGrid), scanWind: dims(scanInputs.windGrid), scanCurrent: dims(scanInputs.currentGrid), landMask: `${computeInputs.landMask.nlat}x${computeInputs.landMask.nlon}` };
      }
    }
  }
  const s = sizes as Record<string, string>;
  out(`  inputs: wind ${s.computeWind} (compute) / ${s.scanWind} (scan), current ${s.computeCurrent} / ${s.scanCurrent}, land mask ${s.landMask}; maxHours ${scanInputs!.maxHours}; router graph step ${resolution} deg`);
  out(`  Compute, tile currents (1 route, ${nodesSettled} nodes settled, ${detail}):`);
  out(`    load tiles+grids (cold, mosaic) ${show(compute.load)}; computeRoute ${show(compute.route)}; total ${show(compute.total)}`);
  out(`  Scan, tile currents, ${departures.length} candidates (${scanFacts.routed} routed, ${scanFacts.skipped} skipped, ${scanFacts.calls} computeRoute calls):`);
  out(`    first scan: load ${show(scanCold.load)}; routing ${show(scanCold.route)}; audit ${show(scanCold.audit)}; total ${show(scanCold.total)}`);
  out(`    repeat scan (all decoded): routing ${show(scanWarm.route)}; audit ${show(scanWarm.audit)}; total ${show(scanWarm.total)}`);
  out(`    longest event-loop block: routing ${show(scanWarm.routeBlock)}; audit ${show(scanWarm.auditBlock)}`);

  // ---- where the audit time goes: one candidate's warm audit, with and without a current grid, and the grid's hash
  const probeInputs = scanInputs!;
  const probeSel = routeOnOneCurrent(probeInputs, [departures[0]!]);
  const probeRoute = probeSel.results.get(departures[0]!)!.result!.route;
  const dateWindow = { startDate: DEPARTURE_ISO.slice(0, 10), endDate: new Date(Date.parse(departures.at(-1)!) + (probeInputs.maxHours + 24) * 3600_000).toISOString().slice(0, 10) };
  const auditProbe = async (currentInput: { grid?: RegionGrid; provenance?: Record<string, unknown> }) => {
    const ms: number[] = [];
    for (let k = 0; k < 4; k++) { const t = performance.now(); await runAnalysis({ route: probeRoute, profile, departureUtc: departures[0]!, store: lastStore, currentInput, dateWindow }); ms.push(performance.now() - t); }
    return median(ms.slice(1));
  };
  const withGrid = await auditProbe({ ...(probeInputs.currentGrid ? { grid: probeInputs.currentGrid } : {}), provenance: { current_source: 'tiles', source: 'tiles' } });
  const withoutGrid = await auditProbe({ provenance: { current_source: 'tiles', source: 'tiles' } });
  const hashes: number[] = [];
  for (let k = 0; k < 3; k++) { const t = performance.now(); if (probeInputs.currentGrid) contentHash(probeInputs.currentGrid); hashes.push(performance.now() - t); }
  out(`  one warm audit of one candidate (scan-size window): ${fmt(withGrid)} ms with the ${dims(probeInputs.currentGrid)} tile current grid, ${fmt(withoutGrid)} ms without a grid; contentHash of that grid once: ${fmt(median(hashes))} ms`);

  // ---- Compute with a prepared grid, and its fallbacks
  const routerBox = routeBbox(p.start, p.finish);
  const around = (m: number) => ({ minLat: routerBox.minLat - m, maxLat: routerBox.maxLat + m, minLon: routerBox.minLon - m, maxLon: routerBox.maxLon + m });
  const tight = { minLat: Math.min(p.start.lat, p.finish.lat) - 0.1, maxLat: Math.max(p.start.lat, p.finish.lat) + 0.1, minLon: Math.min(p.start.lon, p.finish.lon) - 0.1, maxLon: Math.max(p.start.lon, p.finish.lon) + 0.1 };
  const preparedBase = new Date(Date.parse(DEPARTURE_ISO) - 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // fetched two hours before the first departure
  const step = distanceNm > 150 ? { step: 0.12 } : {}; // coarser for the long leg, to stay near real prepared sizes
  const covering = preparedCurrentGrid({ box: around(0.3), baseIso: preparedBase, residual: p.residual, ...step });
  const small = preparedCurrentGrid({ box: tight, baseIso: preparedBase, residual: p.residual, ...step });
  const computeInputs = await loadInputs(lastStore, p, false);
  const computeVariants: Record<string, unknown> = {};
  for (const [name, grid] of [['prepared grid covers the router box', covering], ['prepared grid too small (gap, then tiles)', small]] as const) {
    const times: number[] = []; let calls = 0; let source = '';
    for (let k = 0; k < VARIANT_RUNS; k++) {
      const t0 = performance.now();
      const rec = preparedRecord(grid); // loading the pointer's grid hashes it once (artifactRecord)
      const r = routeOnOneCurrent(computeInputs, [DEPARTURE_ISO], { currentGrid: grid, currentGridProvenance: rec });
      times.push(performance.now() - t0); calls = r.calls; source = String(r.currentInput.provenance?.current_source);
    }
    computeVariants[name] = { ...stat(times), routeCalls: calls, source };
    out(`  Compute, ${name} [${dims(grid)}]: route step incl. hash ${show(times)}; ${calls} computeRoute call(s); ends on ${source}`);
  }

  // ---- Scan double routing. A prepared grid reaches about 120 h from its fetch, so a real 120 h scan is rejected up front:
  const realistic = freezeInput(preparedCurrentGrid({ box: around(0.3), baseIso: preparedBase, hours: 120, residual: p.residual, ...step }));
  const t1 = performance.now();
  const upFront = routeOnOneCurrent(scanInputs!, departures, { currentGrid: realistic, currentGridProvenance: preparedRecord(realistic) });
  const upFrontMs = performance.now() - t1;
  out(`  Scan routing, prepared grid of 121 steps from 10Z (a real one): ${fmt(upFrontMs)} ms; ${upFront.calls} computeRoute calls; ends on ${upFront.currentInput.provenance?.current_source}; reason "${upFront.currentInput.provenance?.fallback_reason}"`);
  // worst case: the prepared axis holds every departure but runs out in the last candidate's search
  const lastDeparture = Date.parse(departures.at(-1)!);
  const longAxis = freezeInput(preparedCurrentGrid({ box: around(0.3), baseIso: preparedBase, hours: Math.ceil((lastDeparture - Date.parse(preparedBase)) / 3600_000) + 1, residual: p.residual, ...step }));
  const doubles: number[] = []; let doubleCalls = 0; let doubleReason = '';
  for (let k = 0; k < VARIANT_RUNS; k++) {
    const t = performance.now();
    const r = routeOnOneCurrent(scanInputs!, departures, { currentGrid: longAxis, currentGridProvenance: preparedRecord(longAxis) });
    doubles.push(performance.now() - t); doubleCalls = r.calls; doubleReason = String(r.currentInput.provenance?.fallback_reason ?? r.currentInput.provenance?.current_source);
  }
  out(`  Scan routing, worst-case double route (prepared axis holds all departures, runs out on the last): ${show(doubles)} (single-source routing ${show(scanWarm.route)}); ${doubleCalls} computeRoute calls; ${doubleReason}`);

  rows.push({
    passage: p.id, label: p.label, distanceNm, sizes, resolutionDeg: resolution, nodesSettled, passageDetail: detail,
    compute: { load: stat(compute.load), loadLongestBlock: stat(compute.loadBlock), route: stat(compute.route), total: stat(compute.total), variants: computeVariants },
    scan: { candidates: departures.length, ...scanFacts, first: { load: stat(scanCold.load), routing: stat(scanCold.route), audit: stat(scanCold.audit), total: stat(scanCold.total), routingLongestBlock: stat(scanCold.routeBlock), auditLongestBlock: stat(scanCold.auditBlock) },
      repeat: { load: stat(scanWarm.load), routing: stat(scanWarm.route), audit: stat(scanWarm.audit), total: stat(scanWarm.total), routingLongestBlock: stat(scanWarm.routeBlock), auditLongestBlock: stat(scanWarm.auditBlock) },
      auditProbe: { withGridMs: withGrid, withoutGridMs: withoutGrid, gridHashMs: median(hashes) },
      realisticPrepared: { ms: upFrontMs, calls: upFront.calls, reason: upFront.currentInput.provenance?.fallback_reason ?? null },
      worstCaseDouble: { ...stat(doubles), calls: doubleCalls, reason: doubleReason } },
  });
}

console.log(`node ${process.version}, ${process.platform} ${process.arch}, ${RUNS} runs per case (${VARIANT_RUNS} for the prepared-grid variants)`);
for (const p of PASSAGES) if (!ONLY || p.id === ONLY) await benchPassage(p);
if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ node: process.version, platform: `${process.platform} ${process.arch}`, runs: RUNS, rows }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
