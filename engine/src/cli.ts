/**
 * Node CLI runner (dev/test path — the same pipeline also runs in the browser).
 *
 * Usage:
 *   npm -w engine run cli -- run --route ../config/routes/cherbourg-plymouth.json \
 *     --profile ../config/profiles/default-limits.json --departure 2026-07-12T06:00:00Z
 *   npm -w engine run cli -- grib --bbox 48,51,-6,2 --datasets wind-gfs,waves-gfs \
 *     --from 2026-09-24T06:00Z --to 2026-09-26T06:00Z [--step all|3|6] [--out output/grib] \
 *     [--base-url https://forecast.deepregatta.com | --tiles-dir <local run dir>] \
 *     [--lon-convention 0-360|signed] [--check 49.65,-1.62[;50.77,-1.3]]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalysis, persistSnapshot } from './analyze.js';
import { FsTileTransport, NodeFsSnapshotStore } from './io/node.js';
import { HttpTileTransport } from './forecast/httpTransport.js';
import { ScenarioBundleStore } from './forecast/scenarioStore.js';
import { TileForecastStore } from './forecast/tileStore.js';
import { MemoryTileCache, type ForecastStore } from './forecast/store.js';
import { planGribExport, type GribStep } from './export/exportPlan.js';
import { gribExportSourceFromStore, runGribExport } from './export/exportGrib.js';
import { GRIB_DATASETS, GRIB_EXPORT_NOTICE } from './export/gribDatasets.js';
import type { LonConvention } from './export/grib2.js';
import type { GateDef, TidesDoc } from './hazards/tides.js';
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
      const next = argv[i + 1];
      const hasValue = next !== undefined && !next.startsWith('--');
      args.set(arg.slice(2), hasValue ? next : '');
      if (hasValue) i++;
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
  const fixedNow = args.get('now') ? Date.parse(args.get('now')!) : Date.now();
  if (!Number.isFinite(fixedNow)) {
    console.error('Invalid --now <ISO UTC>');
    return 1;
  }

  // weather source: scenario bundle (--fixture-dir), local tile run (--tiles-dir,
  // e.g. an `ingest --dry-run` output), or a tile host (--tiles-url / env)
  const fixtureDir = args.get('fixture-dir') ? userPath(args.get('fixture-dir')!) : undefined;
  const tilesDir = args.get('tiles-dir') ? userPath(args.get('tiles-dir')!) : undefined;
  const tilesUrl = args.get('tiles-url') ?? process.env.DEEPWEATHER_FORECAST_BASE_URL;
  let store: ForecastStore;
  if (fixtureDir) {
    store = new ScenarioBundleStore({
      loadBundle: async (name) => {
        const path = join(fixtureDir, `${name}.json`);
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      },
      now: () => fixedNow,
    });
  } else if (tilesDir) {
    store = new TileForecastStore({ transport: new FsTileTransport(tilesDir), now: () => fixedNow });
  } else if (tilesUrl) {
    store = new TileForecastStore({
      transport: new HttpTileTransport({ baseUrl: tilesUrl }),
      now: () => fixedNow,
    });
  } else {
    console.error(
      'No weather source: pass --fixture-dir, --tiles-dir, --tiles-url, or set DEEPWEATHER_FORECAST_BASE_URL',
    );
    return 1;
  }

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
    const routeZoneIds = Object.entries(zoneEntry ?? {}).flatMap(([key, zones]) =>
      key.endsWith('_zones') && Array.isArray(zones)
        ? zones.map((z: { zone_id: string }) => z.zone_id)
        : [],
    );
    // Only unmapped user-drawn routes use the conservative all-bulletins fallback.
    const zoneIds = !zoneEntry && route.mode === 'user'
      ? doc.bulletins.map((b: { zone_id: string }) => b.zone_id)
      : routeZoneIds;
    const repoRelativeRef = relative(REPO_ROOT, warningsPath);
    warnings = {
      doc,
      routeZoneIds: zoneIds,
      ref: repoRelativeRef.startsWith('..') ? warningsPath : repoRelativeRef,
    };
  }

  // prepared artifacts: live latest run, or deterministic fixture-local synoptic features.
  let currentGrid;
  let synoptic;
  if (fixtureDir && existsSync(join(fixtureDir, 'synoptic.json'))) {
    synoptic = JSON.parse(readFileSync(join(fixtureDir, 'synoptic.json'), 'utf8'));
  } else if (!fixtureDir) {
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
  let tides: TidesDoc | undefined;
  let gates: GateDef[] | undefined;
  if (!fixtureDir) {
    const tidesRoot = join(REPO_ROOT, 'data', 'processed', 'tides');
    const indexPath = join(tidesRoot, 'index.json');
    const gatesPath = join(REPO_ROOT, 'config', 'gates.json');
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      const artifact = index.routes?.[route.route_id];
      if (typeof artifact === 'string' && /^[a-zA-Z0-9_-]+\.json$/.test(artifact)) {
        const tidesPath = join(tidesRoot, artifact);
        if (existsSync(tidesPath)) tides = JSON.parse(readFileSync(tidesPath, 'utf8'));
      }
    }
    if (tides && existsSync(gatesPath)) {
      const definitions = JSON.parse(readFileSync(gatesPath, 'utf8')).gates as GateDef[];
      const matching = definitions.filter((gate) =>
        tides!.ports.some((port) => port.port_id === gate.reference_port),
      );
      if (matching.length) gates = matching;
    }
  }

  const result = await runAnalysis({
    route,
    profile,
    departureUtc: departure,
    store,
    ...(warnings ? { warnings } : {}),
    ...(currentGrid ? { currentGrid } : {}),
    ...(synoptic ? { synoptic } : {}),
    ...(tides ? { tides } : {}),
    ...(gates ? { gates } : {}),
    now: () => fixedNow,
  });

  if (args.get('no-snapshot') !== undefined || args.has('print')) {
    console.log(JSON.stringify(result.findings, null, 2));
    return 0;
  }

  const snapshotRoot = args.get('snapshot-dir')
    ? userPath(args.get('snapshot-dir')!)
    : join(REPO_ROOT, 'data', 'processed', 'snapshots');
  const snapshotStore = new NodeFsSnapshotStore(snapshotRoot);
  const snapshotId = await persistSnapshot(snapshotStore, result, route, fixedNow);

  console.log(`snapshot: ${snapshotId}`);
  console.log(`verdict:  ${result.findings.verdict.state}`);
  const decision = result.briefing.sections.find((s) => s.id === 'decision');
  if (decision) console.log(`\n${decision.register_plain}`);
  return 0;
}

const GRIB_USAGE = 'Usage: cli grib --bbox minLat,maxLat,minLon,maxLon --from <ISO UTC> --to <ISO UTC> ' +
  '[--datasets id,…] [--step all|3|6] [--out dir] [--base-url url | --tiles-dir dir] ' +
  '[--lon-convention 0-360|signed] [--check lat,lon[;lat,lon]]';

function numbers(text: string, count: number): number[] | null {
  const values = text.split(',').map((part) => Number(part.trim()));
  return values.length === count && values.every(Number.isFinite) ? values : null;
}

/** Route-area GRIB2 files from forecast tiles: the same engine path the planner runs in the browser. */
async function gribCommand(args: Map<string, string>): Promise<number> {
  const bbox = numbers(args.get('bbox') ?? '', 4);
  const from = args.get('from');
  const to = args.get('to');
  const step = args.get('step') ?? 'all';
  const lonConvention = args.get('lon-convention') ?? '0-360';
  const checkpoints = (args.get('check') ?? '').split(';').filter(Boolean).map((pair) => numbers(pair, 2));
  if (!bbox || !from || !to || !['all', '3', '6'].includes(step) || !['0-360', 'signed'].includes(lonConvention) ||
      checkpoints.some((point) => point === null)) {
    console.error(GRIB_USAGE);
    return 1;
  }
  const datasetIds = args.get('datasets')?.split(',').map((id) => id.trim()).filter(Boolean) ??
    GRIB_DATASETS.map((dataset) => dataset.id);

  const tilesDir = args.get('tiles-dir') ? userPath(args.get('tiles-dir')!) : undefined;
  const baseUrl = args.get('base-url') || process.env.DEEPWEATHER_FORECAST_BASE_URL || 'https://forecast.deepregatta.com';
  const store = new TileForecastStore({
    transport: tilesDir ? new FsTileTransport(tilesDir) : new HttpTileTransport({ baseUrl }),
    cache: new MemoryTileCache(),
  });
  await store.init();
  const plan = planGribExport((layer) => store.manifestFor(layer), {
    bbox: { minLat: bbox[0]!, maxLat: bbox[1]!, minLon: bbox[2]!, maxLon: bbox[3]! },
    datasetIds,
    startIso: from,
    endIso: to,
    step: (step === 'all' ? 'all' : Number(step)) as GribStep,
    lonConvention: lonConvention as LonConvention,
    checkpoints: checkpoints.map((point) => ({ lat: point![0]!, lon: point![1]! })),
    fixture: tilesDir !== undefined,
  });
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
  for (const dataset of plan.datasets) {
    const detail = dataset.availability === 'ok'
      ? `${dataset.steps.length} steps × ${dataset.variables.length} variables, ` +
        `${dataset.lattice!.ni}×${dataset.lattice!.nj} points, ~${mb(dataset.estBytes)}, ` +
        `fetch ≤ ${mb(dataset.downloadBytesUpperBound)}`
      : dataset.availability;
    console.error(`${dataset.datasetId.padEnd(16)} ${dataset.run_id ?? '-'}  ${detail}`);
  }

  let lastReport = 0;
  const files = await runGribExport(gribExportSourceFromStore(store), plan, {
    onProgress: ({ done, total }) => {
      if (Date.now() - lastReport < 2000 && done < total) return;
      lastReport = Date.now();
      console.error(`progress ${done}/${total}`);
    },
  });

  const outDir = args.get('out') ? userPath(args.get('out')!) : join(REPO_ROOT, 'output', 'grib');
  mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    if (!file.messages) continue;
    const path = join(outDir, file.name);
    writeFileSync(path, Buffer.concat(file.parts));
    console.log(`${path}  ${file.bytes} bytes  ${file.messages} messages  fnv64 ${file.fnv64}`);
  }
  const summary = {
    generated_at: new Date().toISOString(),
    source: tilesDir ? { tiles_dir: tilesDir } : { base_url: baseUrl },
    request: plan.request,
    notice: GRIB_EXPORT_NOTICE,
    datasets: plan.datasets.map((dataset) => ({
      datasetId: dataset.datasetId,
      label: dataset.label,
      availability: dataset.availability,
      run_id: dataset.run_id,
      attribution: dataset.spec.attribution,
      ...(dataset.spec.note ? { note: dataset.spec.note } : {}),
      estBytes: dataset.estBytes,
      downloadBytesUpperBound: dataset.downloadBytesUpperBound,
    })),
    files: files.map(({ parts: _parts, ...file }) => file),
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(join(outDir, 'summary.json'));
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.get('_command');
  if (command === 'run') return runCommand(args);
  if (command === 'grib') return gribCommand(args);
  console.error('Usage: cli run --route <path> --profile <path> --departure <ISO UTC>');
  console.error(GRIB_USAGE);
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
