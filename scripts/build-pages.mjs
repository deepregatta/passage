#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repo, 'viewer', 'dist');

mkdirSync(join(dist, 'data'), { recursive: true });
cpSync(join(repo, 'viewer', 'test', 'fixtures', 'demo'), join(dist, 'data'), {
  recursive: true,
  force: true,
});
cpSync(join(repo, 'config'), join(dist, 'data', 'config'), { recursive: true, force: true });

const snapshotsRoot = join(dist, 'data', 'snapshots');
const snapshots = [];
if (existsSync(snapshotsRoot)) {
  for (const entry of readdirSync(snapshotsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const snapshotPath = join(snapshotsRoot, entry.name, 'snapshot.json');
    if (!existsSync(snapshotPath)) continue;
    try {
      const doc = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      snapshots.push({
        snapshot_id: doc.snapshot_id ?? entry.name,
        created_at: doc.created_at,
        route_id: doc.route_id,
        profile_id: doc.profile_id,
        departure_utc: doc.departure_utc,
        verdict_state: doc.verdict_state ?? null,
        demo: doc.demo ?? false,
      });
    } catch (error) {
      console.warn(`Skipping invalid snapshot ${snapshotPath}: ${error.message}`);
    }
  }
}
snapshots.sort((a, b) => b.snapshot_id.localeCompare(a.snapshot_id));
mkdirSync(snapshotsRoot, { recursive: true });
writeFileSync(
  join(snapshotsRoot, 'manifest.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), snapshots }, null, 2) + '\n',
);

// The HTML shell ships Cache-Control: no-transform (see viewer/public/_headers)
// to stop Cloudflare injecting its CSP-blocked challenge-platform snippet —
// which also disables Web Analytics auto-injection, so add the beacon here.
const BEACON =
  '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ' +
  'data-cf-beacon=\'{"token": "108c0d82f68a4c1daeb984cf0055b41f"}\'></script>';
const indexPath = join(dist, 'index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
if (!indexHtml.includes('cloudflareinsights')) {
  writeFileSync(indexPath, indexHtml.replace('</body>', `  ${BEACON}\n  </body>`));
}

// Cloudflare Pages otherwise serves index.html for unknown paths. Data loaders
// rely on a genuine non-2xx response for missing artifacts.
writeFileSync(
  join(dist, '404.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>404</h1><p>Not found.</p></body></html>\n',
);

console.log(`Packaged Pages data in ${dist}`);
