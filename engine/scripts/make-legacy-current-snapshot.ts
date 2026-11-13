/**
 * Writes engine/test/fixtures/legacy-current-snapshot/, a complete saved check on an
 * hourly prepared current grid (check definition: test/helpers/legacyCurrentSnapshot.ts),
 * as the engine of <root> saves it. The committed fixture is LEGACY evidence: it was
 * written by the engine before checks recorded the current grid's time step:
 *   git archive f75248e engine config | tar -x -C <dir>
 *   npx tsx engine/scripts/make-legacy-current-snapshot.ts --root <dir>
 * Never regenerate it from a newer engine: test/legacySnapshot.test.ts proves that a
 * passage saved before the change still opens and verifies unchanged.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGACY_FILES, LEGACY_NOW_MS, legacyOptions } from '../test/helpers/legacyCurrentSnapshot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string) => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] : undefined; };
const root = resolve(flag('root') ?? join(HERE, '..', '..'));
const out = resolve(flag('out') ?? join(HERE, '..', 'test', 'fixtures', 'legacy-current-snapshot'));
const load = (path: string) => import(pathToFileURL(join(root, 'engine', 'src', path)).href);

const { assembleFindings } = await load('findings.ts');
const { decisionInputs } = await load('identity.ts');
const { renderBriefing } = await load('briefing.ts');
const { writeSnapshot } = await load('snapshot.ts');
const { contentHash } = await load('hash.ts');
const { NodeFsSnapshotStore } = await load('io/node.ts');

const options = legacyOptions(root, contentHash);
const findings = assembleFindings(options);
const scratch = mkdtempSync(join(tmpdir(), 'legacy-current-'));
try {
  await writeSnapshot(new NodeFsSnapshotStore(scratch), findings, renderBriefing(findings),
    { route: options.route, decisionInputs: decisionInputs(options) }, LEGACY_NOW_MS);
  mkdirSync(out, { recursive: true });
  for (const file of LEGACY_FILES) writeFileSync(join(out, file), readFileSync(join(scratch, findings.snapshot_id, file)));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`wrote ${findings.snapshot_id} to ${out} from the engine in ${join(root, 'engine')}`);
