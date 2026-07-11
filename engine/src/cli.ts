/**
 * Node CLI runner (dev/test path — the same pipeline runs in the browser at M6).
 *
 * Usage:
 *   npm -w engine run cli -- run --route ../config/routes/cherbourg-plymouth.json \
 *     --profile ../config/profiles/default-limits.json --departure 2026-07-12T06:00:00Z
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from './index.js';
import { assembleFindings } from './findings.js';
import { renderBriefing } from './briefing.js';
import { buildPlume, writeSnapshot } from './snapshot.js';
import { deriveLegs, legMidpoints } from './route.js';
import { computeSchedules, parseUtc, toIso } from './eta.js';
import {
  fetchEnsembleForecasts,
  fetchMarineForecasts,
  fetchMultiModelForecasts,
  fetchPointForecasts,
} from './fetch/openMeteo.js';
import { FsCacheStore, NodeFsSnapshotStore } from './io/node.js';
import type { LimitsProfile, Route } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      args.set(arg.slice(2), argv[i + 1] ?? '');
      i++;
    } else if (!args.has('_command')) {
      args.set('_command', arg);
    }
  }
  return args;
}

async function runCommand(args: Map<string, string>): Promise<number> {
  const routePath = resolve(args.get('route') ?? join(REPO_ROOT, 'config/routes/cherbourg-plymouth.json'));
  const profilePath = resolve(args.get('profile') ?? join(REPO_ROOT, 'config/profiles/default-limits.json'));
  const departure = args.get('departure');
  if (!departure) {
    console.error('Missing --departure <ISO UTC>');
    return 1;
  }

  const route = JSON.parse(readFileSync(routePath, 'utf8')) as Route;
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as LimitsProfile;
  if (!route.speeds_kt) {
    console.error('Route has no speeds_kt');
    return 1;
  }

  const legs = deriveLegs(route);
  const midpoints = legMidpoints(legs);
  const schedules = computeSchedules(legs, route.speeds_kt, departure);

  // window: departure day .. slow-arrival day (+1 day margin)
  const startMs = parseUtc(departure);
  const endMs = parseUtc(schedules[schedules.length - 1]!.exit.slow) + 24 * 3600_000;
  const startDate = toIso(startMs).slice(0, 10);
  const endDate = toIso(endMs).slice(0, 10);

  const cache = new FsCacheStore(join(REPO_ROOT, 'data', 'cache', 'openmeteo'));
  const points = midpoints.map((p) => ({ lat: p.lat, lon: p.lon }));
  const [det, ens, marine, multi] = await Promise.all([
    fetchPointForecasts(points, startDate, endDate, { cache }),
    fetchEnsembleForecasts(points, startDate, endDate, { cache }),
    fetchMarineForecasts(points, startDate, endDate, { cache }),
    fetchMultiModelForecasts(points, startDate, endDate, { cache }),
  ]);

  const nowMs = Date.now();
  const findings = assembleFindings({
    route,
    profile,
    departureUtc: departure,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    legEnsembles: ens.forecasts,
    ensembleMeta: ens.meta,
    legMarine: marine.forecasts,
    marineMeta: marine.meta,
    multiModel: multi,
    engineVersion: ENGINE_VERSION,
    nowMs,
  });

  if (args.get('no-snapshot') !== undefined || args.has('print')) {
    console.log(JSON.stringify(findings, null, 2));
    return 0;
  }

  const briefing = renderBriefing(findings);
  const plume = buildPlume(findings, ens.forecasts, profile.max_gust_kt);
  const store = new NodeFsSnapshotStore(join(REPO_ROOT, 'data', 'processed', 'snapshots'));
  const { snapshot_id } = await writeSnapshot(store, findings, briefing, { route, plume }, nowMs);

  console.log(`snapshot: ${snapshot_id}`);
  console.log(`verdict:  ${findings.verdict.state}`);
  const decision = briefing.sections.find((s) => s.id === 'decision');
  if (decision) console.log(`\n${decision.register_plain}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.get('_command');
  if (command === 'run') return runCommand(args);
  console.error('Usage: cli run --route <path> --profile <path> --departure <ISO UTC>');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
