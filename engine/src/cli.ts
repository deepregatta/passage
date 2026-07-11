/**
 * Node CLI runner (dev/test path — the same pipeline runs in the browser at M6).
 *
 * Usage:
 *   npm -w engine run cli -- run --route ../config/routes/cherbourg-plymouth.json \
 *     --profile ../config/profiles/default-limits.json --departure 2026-07-12T06:00:00Z
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalysis, persistSnapshot } from './analyze.js';
import { FsCacheStore, NodeFsSnapshotStore } from './io/node.js';
import type { LimitsProfile, Route, WarningsInput } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
/** npm workspace scripts chdir into engine/; user-supplied relative paths are
 *  relative to where the user actually invoked npm (INIT_CWD). */
const USER_CWD = process.env.INIT_CWD ?? process.cwd();
const userPath = (p: string) => resolve(USER_CWD, p);

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
  const routePath = args.get('route')
    ? userPath(args.get('route')!)
    : join(REPO_ROOT, 'config/routes/cherbourg-plymouth.json');
  const profilePath = args.get('profile')
    ? userPath(args.get('profile')!)
    : join(REPO_ROOT, 'config/profiles/default-limits.json');
  const departure = args.get('departure');
  if (!departure) {
    console.error('Missing --departure <ISO UTC>');
    return 1;
  }

  const route = JSON.parse(readFileSync(routePath, 'utf8')) as Route;
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as LimitsProfile;

  // fixture mode: responses come from files; file-URL bases make request digests
  // (and therefore snapshot ids) unique per fixture directory
  const fixtureDir = args.get('fixture-dir') ? userPath(args.get('fixture-dir')!) : undefined;
  const fileFetch = (async (url: string | URL) => {
    const path = String(url).split('?')[0]!.replace('file://', '');
    return new Response(readFileSync(path, 'utf8'), { status: 200 });
  }) as unknown as typeof fetch;

  // warnings: explicit path (scenarios), or data/processed/warnings/latest.json when present
  let warnings: WarningsInput | undefined;
  const warningsPath = args.get('warnings')
    ? userPath(args.get('warnings')!)
    : fixtureDir && existsSync(join(fixtureDir, 'warnings.json'))
      ? join(fixtureDir, 'warnings.json')
      : join(REPO_ROOT, 'data', 'processed', 'warnings', 'latest.json');
  if (existsSync(warningsPath)) {
    const doc = JSON.parse(readFileSync(warningsPath, 'utf8'));
    const zones = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'route-zones.json'), 'utf8'));
    const zoneEntry = zones.routes?.[route.route_id];
    const routeZoneIds = [
      ...(zoneEntry?.fr_zones ?? []).map((z: { zone_id: string }) => z.zone_id),
      ...(zoneEntry?.uk_zones ?? []).map((z: { zone_id: string }) => z.zone_id),
    ];
    warnings = { doc, routeZoneIds, ref: warningsPath };
  }

  // prepared artifacts: data/processed/runs/latest.json -> current grid + synoptic (skipped in fixture mode)
  let currentGrid;
  let synoptic;
  if (!fixtureDir) {
    const latestPath = join(REPO_ROOT, 'data', 'processed', 'runs', 'latest.json');
    if (existsSync(latestPath)) {
      const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
      const load = (rel?: string) => {
        if (!rel) return undefined;
        const p = join(REPO_ROOT, 'data', 'processed', rel);
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
      };
      currentGrid = load(latest.artifacts?.current_grid);
      synoptic = load(latest.artifacts?.synoptic_features);
    }
  }

  // tides + gates (skipped in fixture mode — scenario bundles carry their own story)
  let tides;
  let gates;
  if (!fixtureDir) {
    const tidesPath = join(REPO_ROOT, 'data', 'processed', 'tides', 'channel.json');
    const gatesPath = join(REPO_ROOT, 'config', 'gates.json');
    if (existsSync(tidesPath) && existsSync(gatesPath)) {
      tides = JSON.parse(readFileSync(tidesPath, 'utf8'));
      gates = JSON.parse(readFileSync(gatesPath, 'utf8')).gates;
    }
  }

  const result = await runAnalysis({
    route,
    profile,
    departureUtc: departure,
    ...(warnings ? { warnings } : {}),
    ...(currentGrid ? { currentGrid } : {}),
    ...(synoptic ? { synoptic } : {}),
    ...(tides ? { tides } : {}),
    ...(gates ? { gates } : {}),
    ...(fixtureDir
      ? {
          fetchFn: fileFetch,
          baseUrls: {
            forecast: `file://${fixtureDir}/forecast.json`,
            ensemble: `file://${fixtureDir}/ensemble.json`,
            marine: `file://${fixtureDir}/marine.json`,
            multimodel: `file://${fixtureDir}/multimodel.json`,
          },
        }
      : { cache: new FsCacheStore(join(REPO_ROOT, 'data', 'cache', 'openmeteo')) }),
  });

  if (args.get('no-snapshot') !== undefined || args.has('print')) {
    console.log(JSON.stringify(result.findings, null, 2));
    return 0;
  }

  const store = new NodeFsSnapshotStore(join(REPO_ROOT, 'data', 'processed', 'snapshots'));
  const snapshotId = await persistSnapshot(store, result, route, Date.now());

  console.log(`snapshot: ${snapshotId}`);
  console.log(`verdict:  ${result.findings.verdict.state}`);
  const decision = result.briefing.sections.find((s) => s.id === 'decision');
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
  .then((code) => {
    // exitCode (not process.exit) lets large stdout writes flush completely
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
