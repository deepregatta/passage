/**
 * Regenerate the golden GRIB2 export fixtures in engine/test/fixtures/grib/.
 * Run after any intentional encoder or dataset-registry change, then re-run
 * the ecCodes contract test (analysis/tests/test_grib_export_contract.py):
 *
 *   npm run make:grib-fixtures -w engine
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGribFixtures, GRIB_FIXTURE_DIR } from '../test/helpers/gribFixtures.js';

mkdirSync(GRIB_FIXTURE_DIR, { recursive: true });
for (const fixture of await buildGribFixtures()) {
  writeFileSync(join(GRIB_FIXTURE_DIR, `${fixture.name}.grb2`), fixture.bytes);
  writeFileSync(join(GRIB_FIXTURE_DIR, `${fixture.name}.expected.json`), `${JSON.stringify(fixture.expected, null, 2)}\n`);
  console.log(`${fixture.name}.grb2  ${fixture.bytes.byteLength} bytes  ${fixture.expected.messages.length} messages  fnv64 ${fixture.expected.fnv64}`);
}
