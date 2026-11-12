/**
 * Golden test: a fixed four-departure scan on the committed Cherbourg -> Plymouth
 * fixtures (test/helpers/scanGolden.ts) must return the same WindowScan and the
 * same progress-callback candidates, byte for byte, as the checked-in golden.
 * The golden was generated from the engine before the scan stopped hashing its
 * candidates' identity, so it pins the scan against that code:
 *   git archive fa31563 engine config | tar -x -C <dir>
 *   npx tsx engine/scripts/make-scan-golden.ts --root <dir>
 * After an intentional change to a scan's result, regenerate from this checkout:
 *   npx tsx engine/scripts/make-scan-golden.ts
 */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanDepartures } from '../src/window.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { contentHash } from '../src/hash.js';
import { goldenScan } from './helpers/scanGolden.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GOLDEN = new URL('./golden/scan-cherbourg-plymouth.json', import.meta.url);

it('a fixed departure scan matches the checked-in golden byte for byte', async () => {
  const serialized = await goldenScan({ scanDepartures, ScenarioBundleStore, contentHash }, ROOT);
  expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
});
