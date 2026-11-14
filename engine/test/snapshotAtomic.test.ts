/**
 * A saved check is all-or-nothing when the store offers `writeAll`, and
 * sequential (as before) when it does not. The stored text of
 * `decision-inputs.json` is not part of any identity: the file is written
 * compactly, and an indented one saved earlier still reopens on an exact retry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleFindings, type AssembleOptions } from '../src/findings.js';
import { decisionInputs } from '../src/identity.js';
import { renderBriefing } from '../src/briefing.js';
import { SnapshotExistsError, writeSnapshot, type SnapshotFile, type SnapshotStore } from '../src/snapshot.js';

function inputs(): AssembleOptions {
  const route = JSON.parse(readFileSync(new URL('../../config/routes/cherbourg-plymouth.json', import.meta.url), 'utf8'));
  route.waypoints = route.waypoints.slice(0, 2);
  route.passage_id = 'fixed-intent';
  const profile = JSON.parse(readFileSync(new URL('../../config/profiles/default-limits.json', import.meta.url), 'utf8'));
  return { route, profile, departureUtc: '2026-07-20T06:00:00Z', nowMs: 1, engineVersion: 'test',
    requestMeta: [], pointForecasts: [{ lat: 49, lon: -2, times: ['2026-07-20T06:00:00Z'], wind_kt: [5], gust_kt: [8], wind_dir_deg: [0] }],
    currentGrid: { schema_version: 1, kind: 'surface_current', run_id: 'same', generated_at: '2026-07-20T06:00:00Z',
      lat0: 40, lon0: -10, dlat: 20, dlon: 20, nlat: 2, nlon: 2, time_axis: ['2026-07-19T00:00Z', '2026-07-25T00:00Z'],
      u_kt: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], v_kt: [0, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7],
      source: { mode: 'live', fetched_at: '2026-07-20T06:00:00Z' } },
    currentProvenance: { current_source: 'tiles', content_digest: 'x' } } as AssembleOptions;
}

function check() {
  const opts = inputs();
  const findings = assembleFindings(opts);
  return { findings, briefing: renderBriefing(findings), extras: { route: opts.route, decisionInputs: decisionInputs(opts) } };
}

/** Files by `${id}/${filename}`; `writeAll` commits all of them or none, like one IndexedDB transaction. */
class MemoryStore implements SnapshotStore {
  files = new Map<string, string>();
  writes: string[] = [];
  batches: SnapshotFile[][] = [];
  failNext: Error | null = null;
  async exists(id: string) { return [...this.files.keys()].some(key => key.startsWith(`${id}/`)); }
  async read(id: string, filename: string) { return this.files.get(`${id}/${filename}`) ?? null; }
  async list() {
    return [...this.files].filter(([key]) => key.endsWith('/snapshot.json')).map(([, text]) => JSON.parse(text));
  }
  async write(id: string, filename: string, content: string) {
    if (this.files.has(`${id}/${filename}`)) throw new Error('write-once');
    this.writes.push(filename);
    this.files.set(`${id}/${filename}`, content);
  }
}
class BatchStore extends MemoryStore {
  async writeAll(id: string, files: SnapshotFile[]) {
    this.batches.push(files);
    const staged = new Map(this.files);
    for (const [i, { filename, content }] of files.entries()) {
      if (staged.has(`${id}/${filename}`)) throw new Error('ConstraintError');
      if (this.failNext && i === files.length - 2) {
        const failure = this.failNext;
        this.failNext = null;
        throw failure; // nothing staged reaches `files`
      }
      staged.set(`${id}/${filename}`, content);
    }
    this.files = staged;
  }
}
const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

describe('saved check identity does not depend on the stored text', () => {
  it('keeps decision_hash and snapshot_id for a fixed input (values from the engine before this change)', () => {
    const { findings } = check();
    // Pinned again on 2026-11-14 for engine semantics passage-audit-4 (per-sample-point inputs);
    // the stored-text changes this test was written for left it unchanged before that.
    expect(findings.decision_hash).toBe('ac173cf39926a430');
    expect(findings.snapshot_id).toBe('snapshot_v2_ac173cf39926a430');
  });

  it('writes decision-inputs.json compactly; the other files keep their indentation', async () => {
    const { findings, briefing, extras } = check();
    const store = new MemoryStore();
    await writeSnapshot(store, findings, briefing, extras, 1);
    const id = findings.snapshot_id;
    const saved = store.files.get(`${id}/decision-inputs.json`)!;
    expect(saved).toBe(JSON.stringify(extras.decisionInputs));
    expect(saved).not.toContain('\n');
    expect(store.files.get(`${id}/findings.json`)).toBe(JSON.stringify(findings, null, 2));
    expect(store.files.get(`${id}/snapshot.json`)).toContain('\n  "snapshot_id"');
  });

  it.each(['compact', 'indented'])('an exact retry reopens a check whose decision-inputs.json is %s, without writing', async (layout) => {
    const { findings, briefing, extras } = check();
    const store = new MemoryStore();
    const first = await writeSnapshot(store, findings, briefing, extras, 1);
    const key = `${findings.snapshot_id}/decision-inputs.json`;
    if (layout === 'indented') store.files.set(key, JSON.stringify(extras.decisionInputs, null, 2));
    const before = new Map(store.files);
    store.writes = [];
    const again = check();
    await expect(writeSnapshot(store, again.findings, again.briefing, again.extras, 99_999)).resolves.toEqual(first);
    expect(store.writes).toEqual([]);
    expect(store.files).toEqual(before);
  });
});

describe('all-or-nothing saves', () => {
  it('hands every artifact to writeAll in one call, manifest last, and writes nothing one by one', async () => {
    const { findings, briefing, extras } = check();
    const store = new BatchStore();
    const { manifest } = await writeSnapshot(store, findings, briefing, extras, 1);
    expect(store.writes).toEqual([]);
    expect(store.batches).toHaveLength(1);
    const names = store.batches[0]!.map(file => file.filename);
    expect(names).toEqual(['decision-inputs.json', 'findings.json', 'briefing.json', 'route.json', 'snapshot.json']);
    expect(JSON.parse(store.batches[0]!.at(-1)!.content)).toEqual(manifest);
  });

  it.each([['a quota failure', quota], ['any other failure', () => new Error('transaction aborted')]])(
    '%s part-way leaves nothing for the check, and the same check then saves', async (_name, failure) => {
      const { findings, briefing, extras } = check();
      const store = new BatchStore();
      store.failNext = failure();
      await expect(writeSnapshot(store, findings, briefing, extras, 1)).rejects.toMatchObject({ name: failure().name });
      expect(await store.exists(findings.snapshot_id)).toBe(false);
      expect(await store.list()).toEqual([]);
      const { manifest } = await writeSnapshot(store, findings, briefing, extras, 2);
      expect(await store.list()).toEqual([manifest]);
      expect(manifest.check_sequence).toBe(1);
    });

  it('still refuses a pre-existing partial check and leaves its bytes alone', async () => {
    const { findings, briefing, extras } = check();
    const store = new BatchStore();
    store.files.set(`${findings.snapshot_id}/route.json`, '{"original":true}');
    const refusal = await writeSnapshot(store, findings, briefing, extras, 1).catch(error => error);
    expect(refusal).toBeInstanceOf(SnapshotExistsError);
    expect(refusal).toMatchObject({ name: 'SnapshotExistsError', snapshotId: findings.snapshot_id,
      message: `Snapshot ${findings.snapshot_id} is incomplete, legacy or conflicting. Snapshots are write-once.` });
    expect(store.batches).toEqual([]);
    expect([...store.files]).toEqual([[`${findings.snapshot_id}/route.json`, '{"original":true}']]);
  });

  it('still refuses conflicting frozen inputs for a complete check', async () => {
    const { findings, briefing, extras } = check();
    const store = new BatchStore();
    await writeSnapshot(store, findings, briefing, extras, 1);
    const before = new Map(store.files);
    await expect(writeSnapshot(store, findings, briefing, { ...extras, decisionInputs: { changed: true } }, 2)).rejects.toThrow('conflict');
    expect(store.files).toEqual(before);
    expect(store.batches).toHaveLength(1);
  });

  it('a store without writeAll still writes one file at a time, manifest last', async () => {
    const { findings, briefing, extras } = check();
    const store = new MemoryStore();
    await writeSnapshot(store, findings, briefing, { ...extras, warnings: { bulletins: [] }, tides: { ports: [] } }, 1);
    expect(store.writes).toEqual(['decision-inputs.json', 'findings.json', 'briefing.json', 'route.json', 'warnings.json', 'tides.json', 'snapshot.json']);
  });
});
