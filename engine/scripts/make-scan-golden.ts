/**
 * Writes engine/test/golden/scan-cherbourg-plymouth.json, the departure scan
 * pinned by test/scanGolden.test.ts (scan definition: test/helpers/scanGolden.ts).
 *
 *   npx tsx engine/scripts/make-scan-golden.ts                 this checkout's engine
 *   npx tsx engine/scripts/make-scan-golden.ts --root <dir>    the engine in <dir>/engine, fixtures in <dir>/config
 *
 * Run from the repository root. The committed golden was generated from the
 * engine before the scan stopped hashing its candidates' identity (commit fa31563):
 *   git archive fa31563 engine config | tar -x -C <dir>
 *   npx tsx engine/scripts/make-scan-golden.ts --root <dir>
 * After an intentional change to a scan's result, regenerate with this checkout
 * (no --root), and review the diff.
 * Regenerated so on 2026-11-13: checks record the current grid's time step
 * (`time_step_h`, 6 on this scan's tile grid), the golden's only change.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { goldenScan, type ScanEngine } from '../test/helpers/scanGolden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string) => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] : undefined; };
const root = resolve(flag('root') ?? join(HERE, '..', '..'));
const out = resolve(flag('out') ?? join(HERE, '..', 'test', 'golden', 'scan-cherbourg-plymouth.json'));
const load = (path: string) => import(pathToFileURL(join(root, 'engine', 'src', path)).href);

const engine: ScanEngine = {
  scanDepartures: (await load('window.ts')).scanDepartures,
  ScenarioBundleStore: (await load('forecast/scenarioStore.ts')).ScenarioBundleStore,
  contentHash: (await load('hash.ts')).contentHash,
};
writeFileSync(out, await goldenScan(engine, root));
console.log(`wrote ${out} from the engine in ${join(root, 'engine')}`);
