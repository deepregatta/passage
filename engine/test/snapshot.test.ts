import { describe, expect, it } from 'vitest';
import { persistSnapshot, type AnalyzeResult } from '../src/analyze.js';
import type { SnapshotStore } from '../src/snapshot.js';
import type { Route } from '../src/types.js';

class MemorySnapshotStore implements SnapshotStore {
  files = new Map<string, string>();
  async exists(snapshotId: string) {
    return [...this.files.keys()].some((key) => key.startsWith(`${snapshotId}/`));
  }
  async write(snapshotId: string, filename: string, content: string) {
    this.files.set(`${snapshotId}/${filename}`, content);
  }
}

describe('snapshot input archival', () => {
  it('persistSnapshot freezes bulletin and synoptic inputs and advertises both artifacts', async () => {
    const snapshotId = '20260720T060000Z_route_fixture';
    const warnings = { source: { mode: 'synthetic' }, bulletins: [{ zone_id: 'casquets' }] };
    const synoptic = { run_id: 'fixture-run', systems: [], regimes: [] };
    const route = { route_id: 'route', schema_version: 1, name: 'Route', mode: 'fixed', waypoints: [] } as Route;
    const result = {
      findings: {
        snapshot_id: snapshotId,
        engine_version: 'test',
        route_id: 'route',
        profile_id: 'profile',
        departure_utc: '2026-07-20T06:00:00Z',
        verdict: { state: 'within' },
        inputs: { route_hash: 'route-hash', profile_hash: 'profile-hash' },
      },
      briefing: { schema_version: 1, snapshot_id: snapshotId, sections: [], next_runs: [] },
      plume: { schema_version: 1, snapshot_id: snapshotId, model: null, legs: [] },
      snapshotInputs: { warnings, synoptic },
    } as unknown as AnalyzeResult;
    const store = new MemorySnapshotStore();

    await persistSnapshot(store, result, route, Date.parse('2026-07-19T18:00:00Z'));

    expect(JSON.parse(store.files.get(`${snapshotId}/warnings.json`)!)).toEqual(warnings);
    expect(JSON.parse(store.files.get(`${snapshotId}/synoptic.json`)!)).toEqual(synoptic);
    const manifest = JSON.parse(store.files.get(`${snapshotId}/snapshot.json`)!);
    expect(manifest.artifacts).toMatchObject({ warnings: 'warnings.json', synoptic: 'synoptic.json' });
  });
});
