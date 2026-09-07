import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { Findings, Route, WarningsDoc } from '../src/types.js';

const repo = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'passage-cli-zones-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const registry = JSON.parse(readFileSync(join(repo, 'config/route-zones.json'), 'utf8')) as {
  routes: Record<string, Record<string, Array<{ zone_id: string }>>>;
};
const routes = readdirSync(join(repo, 'config/routes')).filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(repo, 'config/routes', name), 'utf8')) as Route);
const allZones = Object.values(registry.routes).flatMap((entry) => Object.values(entry).flatMap((zones) => zones.map((z) => z.zone_id)));
const doc: WarningsDoc = {
  schema_version: 1, fetched_at: '2026-07-20T00:00:00Z', source: { mode: 'synthetic' }, feed_status: 'ok',
  bulletins: allZones.map((zone_id) => ({
    zone_id, kind: 'gale-warning', severity: 'gale', valid_from: '2026-07-20T00:00:00Z',
    valid_to: '2026-07-25T00:00:00Z', raw_text: 'SYNTHETIC test warning',
  })),
};
writeFileSync(join(temp, 'warnings.json'), JSON.stringify(doc));

function runRoute(route: Route): string[] {
  writeFileSync(join(temp, 'route.json'), JSON.stringify(route));
  const output = execFileSync(process.execPath, [
    '--import', 'tsx', join(repo, 'engine/src/cli.ts'), 'run',
    '--route', join(temp, 'route.json'), '--warnings', join(temp, 'warnings.json'),
    '--fixture-dir', join(repo, 'engine/test/fixtures/scenarios/calm'),
    '--departure', '2026-07-20T06:00:00Z', '--now', '2026-07-19T18:00:00Z', '--print',
  ], { cwd: repo, encoding: 'utf8', maxBuffer: 5_000_000 });
  const findings = JSON.parse(output) as Findings;
  return findings.evidence.filter((item) => item.rule_id === 'A-WARN-01')
    .flatMap((item) => item.bulletin_ref?.zone_ids ?? []).sort();
}

for (const [routeId, entry] of Object.entries(registry.routes)) {
  it(`CLI selects all warning zones for ${routeId}`, () => {
    const route = routes.find((route) => route.route_id === routeId);
    expect(route).toBeDefined();
    expect(runRoute(route!)).toEqual(Object.values(entry).flatMap((zones) => zones.map((z) => z.zone_id)).sort());
  });
}

it('CLI only falls back to all warning zones for user-drawn routes', () => {
  const route = { ...routes[0]!, route_id: 'unmapped' };
  expect(runRoute({ ...route, mode: 'fixed' })).toEqual([]);
  expect(runRoute({ ...route, mode: 'user' })).toEqual([...allZones].sort());
});
