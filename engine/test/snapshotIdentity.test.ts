import { describe, expect, it } from 'vitest';
import { decisionInputs } from '../src/identity.js';
import { assembleFindings, type AssembleOptions } from '../src/findings.js';
import { renderBriefing } from '../src/briefing.js';
import { writeSnapshot, type SnapshotStore } from '../src/snapshot.js';
import { NodeFsSnapshotStore } from '../src/io/node.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function inputs(): AssembleOptions {
  const route = JSON.parse(readFileSync(new URL('../../config/routes/cherbourg-plymouth.json', import.meta.url), 'utf8'));
  // Short single leg, enough hourly input to trigger a real warning override.
  route.waypoints = route.waypoints.slice(0, 2);
  const profile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
  return { route, profile, departureUtc: '2026-07-20T06:00:00Z', nowMs: 1, engineVersion: 'test',
    requestMeta: [], legForecasts: [{ lat: 49, lon: -2, times: ['2026-07-20T06:00:00Z'],
      wind_kt: [5], gust_kt: [8], wind_dir_deg: [0] }] };
}

it('a gale warning changes the verdict and receives a distinct snapshot', () => {
  const opts = inputs();
  const clear = assembleFindings(opts);
  opts.warnings = { ref: 'same-url', routeZoneIds: ['channel'], doc: { schema_version: 1,
    feed_status: 'ok', fetched_at: '2026-07-20T00:00:00Z', source: { mode: 'synthetic' }, bulletins: [
      { zone_id: 'channel', kind: 'gale', raw_text: 'Synthetic gale', valid_from: '2026-07-20T00:00:00Z', valid_to: '2026-07-21T00:00:00Z' },
    ] } };
  const gale = assembleFindings(opts);
  expect(gale.verdict.state).toBe('warning_active');
  expect(gale.snapshot_id).not.toBe(clear.snapshot_id);
});

describe('complete decision identity', () => {
  it.each(['forecast', 'gates', 'tides', 'engine', 'prepared', 'geometry', 'departure', 'profile', 'intent'])('%s changes cannot reuse a snapshot', (kind) => {
    const opts = inputs();
    const before = assembleFindings(opts).snapshot_id;
    if (kind === 'forecast') opts.legForecasts[0]!.gust_kt[0] = 9;
    if (kind === 'gates') opts.gates = [{ gate_id: 'gate', name: 'Gate', reference_port: 'port', lat: 49, lon: -2, favorable_sw_going: { from_hw_h: -1, to_hw_h: 1 } }];
    if (kind === 'tides') opts.tides = { generated_at: '2026-07-20T00:00Z', schema_version: 1, source: { mode: 'synthetic' }, ports: [] } as AssembleOptions['tides'];
    if (kind === 'engine') opts.engineVersion = 'changed';
    if (kind === 'prepared') opts.inputRecords = [{ layer: 'synoptic', run_id: 'same-run', content_digest: 'changed' }];
    if (kind === 'geometry') opts.route.waypoints[1]!.lon += 0.01;
    if (kind === 'departure') opts.departureUtc = '2026-07-20T07:00:00Z';
    if (kind === 'profile') opts.profile.max_gust_kt += 1;
    if (kind === 'intent') Object.assign(opts.route, { passage_id: 'another-intent' });
    expect(assembleFindings(opts).snapshot_id).not.toBe(before);
  });

  it('exact retries reopen the original complete result without writes; partial/legacy data is preserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'passage-03-'));
    try {
      const opts = inputs();
      const findings = assembleFindings(opts);
      const store = new NodeFsSnapshotStore(root);
      const extras = { route: opts.route, decisionInputs: decisionInputs(opts) };
      const first = await writeSnapshot(store, findings, renderBriefing(findings), extras, 1);
      const before = readFileSync(join(root, findings.snapshot_id, 'snapshot.json'), 'utf8');
      const retry = await writeSnapshot(store, findings, renderBriefing(findings), extras, 99999);
      expect(retry).toEqual(first);
      expect(readFileSync(join(root, findings.snapshot_id, 'snapshot.json'), 'utf8')).toBe(before);
      const partial: SnapshotStore = { exists: async () => true, write: async () => { throw new Error('must not write'); } };
      await expect(writeSnapshot(partial, findings, renderBriefing(findings), extras, 1)).rejects.toThrow(/incomplete|conflict|write-once/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('retrieval and evaluation clocks do not change identity; route revisions ignore intent but retain timing', async () => {
  const { routeRevision } = await import('../src/identity.js');
  const opts = inputs();
  const a = assembleFindings(opts);
  const b = assembleFindings({ ...opts, nowMs: 99999 });
  expect(a.snapshot_id).toBe(b.snapshot_id);
  expect(a.generated_at).not.toBe(b.generated_at);
  expect(routeRevision({ ...opts.route, passage_id: 'a' }, opts.departureUtc))
    .toBe(routeRevision({ ...opts.route, passage_id: 'b' }, opts.departureUtc));
  expect(routeRevision(opts.route, opts.departureUtc)).not.toBe(routeRevision(opts.route, '2026-07-21T06:00Z'));
});

it('tile current mosaics and cache metadata retry idempotently as retrieval clocks advance', () => {
  const opts = inputs();
  opts.requestMeta = [{ source: 'tiles', layer: 'wind', model: 'gfs', run_id: 'same', cycle: opts.departureUtc,
    resolution_deg: 0.25, fetched_at: opts.departureUtc, cached_tiles: 0, tiles: ['same'], points: 1 }];
  opts.currentGrid = { schema_version: 1, kind: 'surface_current', run_id: 'same', generated_at: opts.departureUtc,
    lat0: 40, lon0: -10, dlat: 20, dlon: 20, nlat: 2, nlon: 2, time_axis: ['2026-07-19T00:00Z', '2026-07-25T00:00Z'],
    u_kt: Array(8).fill(0), v_kt: Array(8).fill(0), source: { mode: 'live', fetched_at: opts.departureUtc } };
  opts.currentProvenance = { current_source: 'tiles', content_digest: 'first-clock' };
  const first = assembleFindings(opts);
  opts.requestMeta[0]!.cached_tiles = 1;
  opts.requestMeta[0]!.fetched_at = '2026-07-20T09:00Z';
  opts.currentGrid.generated_at = '2026-07-20T09:00Z';
  opts.currentGrid.source.fetched_at = '2026-07-20T09:00Z';
  opts.currentProvenance.content_digest = 'second-clock';
  expect(assembleFindings(opts).snapshot_id).toBe(first.snapshot_id);
  opts.currentGrid.u_kt[0] = 0.1;
  expect(assembleFindings(opts).snapshot_id).not.toBe(first.snapshot_id);
});

it('conflicting frozen inputs and incomplete artifacts cannot be accepted as an exact retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'passage-03-conflict-'));
  try {
    const opts = inputs();
    const findings = assembleFindings(opts);
    const store = new NodeFsSnapshotStore(root);
    const extras = { route: opts.route, decisionInputs: decisionInputs(opts) };
    await writeSnapshot(store, findings, renderBriefing(findings), extras, 1);
    const bytes = readFileSync(join(root, findings.snapshot_id, 'findings.json'), 'utf8');
    await expect(writeSnapshot(store, findings, renderBriefing(findings), { ...extras, decisionInputs: { changed: true } }, 2)).rejects.toThrow('conflict');
    rmSync(join(root, findings.snapshot_id, 'briefing.json'));
    await expect(writeSnapshot(store, findings, renderBriefing(findings), extras, 2)).rejects.toThrow('incomplete');
    expect(readFileSync(join(root, findings.snapshot_id, 'findings.json'), 'utf8')).toBe(bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('persists creation order for a passage at tied timestamps; an exact retry retains its original sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'passage-03-order-'));
  try {
    const store = new NodeFsSnapshotStore(root);
    const opts = inputs();
    opts.route.passage_id = 'ordered';
    const results = [];
    for (const gust of [8, 9, 10]) {
      opts.legForecasts[0]!.gust_kt[0] = gust;
      const findings = assembleFindings(opts);
      results.push(await writeSnapshot(store, findings, renderBriefing(findings), { route: opts.route, decisionInputs: decisionInputs(opts) }, 1));
    }
    expect(results.map(result => result.manifest.check_sequence)).toEqual([1, 2, 3]);
    opts.legForecasts[0]!.gust_kt[0] = 8;
    const findings = assembleFindings(opts);
    expect(await writeSnapshot(store, findings, renderBriefing(findings), { route: opts.route, decisionInputs: decisionInputs(opts) }, 999)).toEqual(results[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
