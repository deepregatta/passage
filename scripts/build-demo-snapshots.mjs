#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixedNow = '2026-07-19T18:00:00Z';
const departure = '2026-07-20T06:00:00Z';
const generatedRoot = join(repo, 'data', 'processed', 'demo-snapshots');
const committedRoot = join(repo, 'viewer', 'test', 'fixtures', 'demo');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${result.stderr ? `\n${result.stderr}` : ''}`);
  }
  return result.stdout ?? '';
}

function buildFixture(name) {
  const output = run(
    'npm',
    [
      '--silent',
      '-w',
      'engine',
      'run',
      'cli',
      '--',
      'run',
      '--fixture-dir',
      `engine/test/fixtures/scenarios/${name}`,
      '--departure',
      departure,
      '--now',
      fixedNow,
      '--snapshot-dir',
      'data/processed/demo-snapshots',
    ],
    { capture: true },
  );
  const id = output.match(/snapshot:\s+(\S+)/)?.[1];
  if (!id) throw new Error(`Could not read snapshot id from CLI output:\n${output}`);
  return id;
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

rmSync(generatedRoot, { recursive: true, force: true });
mkdirSync(generatedRoot, { recursive: true });
run('npm', ['run', 'build', '-w', 'engine']);

const previousId = buildFixture('reference-demo-prev');
const latestId = buildFixture('reference-demo');
const previousDir = join(generatedRoot, previousId);
const latestDir = join(generatedRoot, latestId);

const engine = await import(pathToFileURL(join(repo, 'engine', 'dist', 'index.js')));
const changes = engine.diffFindings(
  json(join(previousDir, 'findings.json')),
  json(join(latestDir, 'findings.json')),
  json(join(latestDir, 'briefing.json')).next_run,
);
writeJson(join(latestDir, 'changes.json'), changes);

const verificationCase = {
  schema_version: 1,
  snapshot_id: latestId,
  observation_source: 'emulated',
  generated_at: '2026-07-21T12:00:00Z',
  coverage_summary: { emulated: 3 },
  pairs: [
    { leg_id: 'L4', valid_time: '2026-07-20T23:00:00Z', variable: 'gust_kt', forecast: 31, observed: 29, error: 2, coverage_class: 'emulated' },
    { leg_id: 'L5', valid_time: '2026-07-21T02:00:00Z', variable: 'gust_kt', forecast: 39, observed: 36, error: 3, coverage_class: 'emulated' },
    { leg_id: 'L5', valid_time: '2026-07-21T02:00:00Z', variable: 'wave_height_m', forecast: 3.1, observed: 2.8, error: 0.3, coverage_class: 'emulated' },
  ],
  disclosure: 'Synthetic observations for the product demo; excluded from every skill claim.',
};
writeJson(join(latestDir, 'verification.json'), verificationCase);

rmSync(committedRoot, { recursive: true, force: true });
mkdirSync(join(committedRoot, 'snapshots'), { recursive: true });

for (const [name, id, sourceName] of [
  ['previous', previousId, 'reference-demo-prev'],
  ['latest', latestId, 'reference-demo'],
]) {
  const source = join(generatedRoot, id);
  const target = join(committedRoot, 'snapshots', id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  const charts = join(repo, 'engine', 'test', 'fixtures', 'scenarios', sourceName, 'charts');
  if (existsSync(charts)) cpSync(charts, join(target, 'charts'), { recursive: true });
  const manifestPath = join(target, 'snapshot.json');
  const manifest = json(manifestPath);
  if (name === 'latest') {
    manifest.artifacts.changes = 'changes.json';
    manifest.artifacts.verification = 'verification.json';
    manifest.demo = true; // "See an example briefing" opens this one
  }
  writeJson(manifestPath, manifest);
}

// Install the pair into the live app data so the demo is openable from My briefings
// (snapshots are write-once: remove any previous copy of these two ids first).
const liveSnapshots = join(repo, 'data', 'processed', 'snapshots');
mkdirSync(liveSnapshots, { recursive: true });
for (const id of [previousId, latestId]) {
  const target = join(liveSnapshots, id);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(committedRoot, 'snapshots', id), target, { recursive: true });
}
const liveCases = join(repo, 'data', 'processed', 'verification', 'cases');
mkdirSync(liveCases, { recursive: true });
writeJson(join(liveCases, `${latestId}.json`), verificationCase);

mkdirSync(join(committedRoot, 'verification', 'cases'), { recursive: true });
writeJson(join(committedRoot, 'verification', 'cases', `${latestId}.json`), verificationCase);
writeJson(join(committedRoot, 'verification', 'cases', 'index.json'), {
  cases: [{ snapshot_id: latestId, observation_source: 'emulated' }],
});
writeJson(join(committedRoot, 'verification', 'calibration.json'), {
  schema_version: 1,
  generated_at: fixedNow,
  records: [],
  note: 'No emulated record is included in calibration.',
});
writeJson(join(committedRoot, 'verification', 'corpus.json'), {
  cases: 11,
  pass: 10,
  fail: 1,
  pending: 0,
  observation_source: 'era5',
  disclosure: 'Emulated demo verification is excluded from these corpus counts.',
});

writeJson(join(committedRoot, 'index.json'), {
  generated_at: fixedNow,
  departure_utc: departure,
  previous_snapshot_id: previousId,
  latest_snapshot_id: latestId,
  snapshots: {
    previous: `snapshots/${previousId}/snapshot.json`,
    latest: `snapshots/${latestId}/snapshot.json`,
  },
});

console.log(`demo snapshots: ${previousId} -> ${latestId}`);
console.log(`committed fixture: ${committedRoot}`);
