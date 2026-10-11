// Planted samples for check-no-polar-data.mjs. Every table here is invented.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { listTree, scanFiles, SYNTHETIC_POLAR_FILES } from './check-no-polar-data.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'no-polar-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plant(name, content) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}
const rules = (options) => scanFiles(root, listTree(root), options).map(({ file, rule }) => `${file}: ${rule}`).sort();

const passageShape = JSON.stringify({ polar_id: 'x', tws_kt: [6, 12], twa_deg: [45, 90], speeds_kt: [[4, 5], [6, 7]] });
const releaseEntry = JSON.stringify({
  format: 'deepregatta-polars/1',
  table: { twa_deg: [40, 90], tws_kt: [6, 12], speeds_kt: [[null, 4.1], [5.2, 6.3]] },
  licence: { constraint: 'no-public-download', basis: 'x' },
}, null, 2);
const orcLiteral = "[{'name': 'X', 'vpp': {'angles': [52, 60], 'beat_angle': [43.1, 41.9], 'run_vmg': [3.1, 4.2]}}]";
const polText = 'TWA\\TWS\t6\t12\n40\t4.1\t5.2\n90\t5.0\t6.3\n';

test('clean files pass, including words that merely name polars', () => {
  plant('docs/readme.md', 'Polars come from /api/polars/<id>; speeds_kt is speeds_kt[tws][twa].\n');
  plant('src/polar.ts', 'export interface Polar { speeds_kt: number[][] }\n');
  plant('functions/api/polars/[id].js', 'export const onRequestGet = () => new Response(null);\n');
  plant('data/land/tile.bin.gz', gzipSync(Buffer.from([0, 1, 2, 3])));
  assert.deepEqual(rules(), []);
});

test('polar tables are found by content, whatever the file is called', () => {
  plant('a/boat.json', passageShape);
  plant('b/entry.json', releaseEntry);
  plant('c/sample.txt', orcLiteral);
  plant('d/table.txt', polText);
  plant('e/bundle.js', `const p={speeds_kt:[[5.1,6.2],[7,8]]};`);
  plant('f/renamed.bin', gzipSync(Buffer.from(releaseEntry)));
  assert.deepEqual(rules(), [
    'a/boat.json: boat speed matrix',
    'b/entry.json: boat speed matrix',
    'b/entry.json: deep-polars licence record',
    'c/sample.txt: ORC VPP block',
    'c/sample.txt: ORC best-VMG rows',
    'd/table.txt: .pol table text',
    'e/bundle.js: boat speed matrix',
    'f/renamed.bin: boat speed matrix',
    'f/renamed.bin: deep-polars licence record',
  ]);
});

test('polar paths are found even when their content is harmless', () => {
  plant('viewer/public/data/polars/index.json', '{}');
  plant('config/polars/x.json', '{}');
  plant('x/boat.pol', '');
  plant('raw/ALL2025.json', '{}');
  plant('release/boats.json.gz', gzipSync(Buffer.from('{}')));
  assert.deepEqual(rules(), [
    'config/polars/x.json: published polar directory',
    'raw/ALL2025.json: ORC certificate dump',
    'release/boats.json.gz: deep-polars release body',
    'viewer/public/data/polars/index.json: published polar directory',
    'x/boat.pol: .pol polar file',
  ]);
});

test('reviewed synthetic tables are exempt in the repository, never in a built site', () => {
  const [synthetic] = SYNTHETIC_POLAR_FILES.keys();
  plant(synthetic, passageShape);
  plant('assets/polars/x.json', '{}');
  assert.deepEqual(rules(), []);
  assert.deepEqual(rules({ built: true }), [
    'assets/polars/x.json: polars directory in the build',
    `${synthetic}: boat speed matrix`,
  ]);
});

test('findings name the file and rule, never the data', () => {
  plant('a/boat.json', passageShape);
  const [finding] = scanFiles(root, listTree(root));
  assert.deepEqual(Object.keys(finding).sort(), ['file', 'rule']);
});
