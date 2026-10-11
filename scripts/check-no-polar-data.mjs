#!/usr/bin/env node
// Polar data never goes into this public repository or onto its public site
// (deep-polars docs/PLAN.md, decisions 2 and 7). Passage reads one boat's
// polar at request time from /api/polars/<id>. This check fails if polar data
// comes back, and names only the file and the rule, never the data.
//
//   node scripts/check-no-polar-data.mjs               repository files
//   node scripts/check-no-polar-data.mjs viewer/dist   repository files and a built site
//
// Repository files are those Git would commit (tracked plus untracked, not
// ignored). A built site is scanned file by file with no exceptions.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

const PATH_RULES = [
  ['published polar directory', /(^|\/)(data|config)\/polars(\/|$)/i],
  ['.pol polar file', /\.pol$/i],
  ['ORC certificate dump', /ALL20\d\d/i],
  ['deep-polars release body', /(^|\/)boats\.json\.gz$/i],
];
// A built site has no reason to carry anything under a polars directory.
const BUILT_PATH_RULES = [...PATH_RULES, ['polars directory in the build', /(^|\/)polars(\/|$)/i]];

const CONTENT_RULES = [
  // Passage's polar shape and a deep-polars table: a numeric speed matrix.
  ['boat speed matrix', /speeds_kt["']?\s*:\s*\[\s*\[\s*(?:-?\d|null)/],
  // ORC certificate VPP rows: best-VMG angles and speeds as numbers.
  ['ORC best-VMG rows', /\b(?:beat|run)_(?:angle|vmg)["']?\s*:\s*\[\s*-?\d/],
  ['ORC VPP block', /["']vpp["']\s*:\s*\{/],
  // Every deep-polars entry and release carries its licence constraint.
  ['deep-polars licence record', /["']constraint["']\s*:\s*["']no-public-download["']/],
  // .pol text: a TWA\TWS header followed by a numeric row.
  ['.pol table text', /^\s*twa\s*[\\/]\s*tws\b[^\n]*\r?\n\s*\d/im],
];

// Invented tables, never ORC, SailGrib or Meltemus data. Each entry is a
// reviewed exception for repository files; the built site has none.
export const SYNTHETIC_POLAR_FILES = new Map([
  ['engine/test/routing.test.ts', 'invented 3×4 "test-32ft" table'],
  ['engine/test/routingTiming.test.ts', 'constant 5 kt table'],
  ['engine/test/tileStore.test.ts', 'invented 3×4 table'],
  ['viewer/test/fixtures/routingTiming.js', 'constant 5 kt table'],
  ['docs/maintenance/2026-09-17-implementation-verification.md', 'quotes the invented "test-32ft" table'],
  ['scripts/check-no-polar-data.test.mjs', 'planted samples for this check\'s own test'],
]);

function textOf(path) {
  let bytes = readFileSync(path);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return null;
    }
  }
  // Binary payloads (tiles, images, fonts) carry no text tables.
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString('utf8');
}

/** Findings for files named relative to root: [{ file, rule }]. */
export function scanFiles(root, files, { built = false } = {}) {
  const findings = [];
  for (const file of files) {
    const name = file.split(sep).join('/');
    for (const [rule, pattern] of built ? BUILT_PATH_RULES : PATH_RULES) {
      if (pattern.test(name)) findings.push({ file: name, rule });
    }
    if (!built && SYNTHETIC_POLAR_FILES.has(name)) continue;
    let text;
    try {
      text = textOf(join(root, file));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') continue;
      throw error;
    }
    if (text === null) continue;
    for (const [rule, pattern] of CONTENT_RULES) {
      if (pattern.test(text)) findings.push({ file: name, rule });
    }
  }
  return findings;
}

export function listTree(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

function repositoryFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo, maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))];
}

function report(label, findings) {
  if (!findings.length) {
    console.log(`${label}: no polar data`);
    return true;
  }
  console.error(`${label}: polar data must not be published (${findings.length} finding(s)):`);
  for (const { file, rule } of findings) console.error(`  ${file}: ${rule}`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let ok = report('repository', scanFiles(repo, repositoryFiles()));
  const builtDir = process.argv[2];
  if (builtDir) {
    const root = resolve(repo, builtDir);
    ok = report(builtDir, scanFiles(root, listTree(root), { built: true })) && ok;
  }
  if (!ok) process.exit(1);
}
