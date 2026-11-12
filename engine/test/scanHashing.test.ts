/**
 * A departure scan ranks its candidates' findings and never saves or shows them,
 * so it skips their saved identity (decision inputs, decision hash, snapshot id):
 * the hashing that dominated a scan (docs/maintenance/2026-11-12-scan-responsiveness.md).
 * A Check builds its decision inputs once. Every value a scan or a Check returns
 * or saves stays byte-identical; these tests count the hashing and compare outputs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RegionGrid } from '../src/grids.js';
import type { AssembleOptions } from '../src/findings.js';
import type { LimitsProfile, Route } from '../src/types.js';

// Pass-through spies: every engine module that hashes or assembles goes through them.
const seen = vi.hoisted(() => ({ hashed: [] as unknown[], assembled: [] as unknown[] }));
vi.mock('../src/hash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hash.js')>();
  return { ...actual, contentHash: (value: unknown) => { seen.hashed.push(value); return actual.contentHash(value); } };
});
vi.mock('../src/findings.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, typeof value === 'function' && name.startsWith('assemble')
    ? (options: unknown, ...rest: unknown[]) => { seen.assembled.push(options); return (value as (...args: unknown[]) => unknown)(options, ...rest); }
    : value]));
});

const { runAnalysis, persistSnapshot } = await import('../src/analyze.js');
const { scanDepartures, scanCandidates } = await import('../src/window.js');
const { canonicalJson, contentHash } = await import('../src/hash.js');
const { assembleFindings } = await import('../src/findings.js');
const { decisionInputs, withoutSavedIdentity } = await import('../src/identity.js');
const { ScenarioBundleStore } = await import('../src/forecast/scenarioStore.js');

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const route: Route = read('../../config/routes/cherbourg-plymouth.json');
const profile: LimitsProfile = read('../../config/profiles/default-limits.json');
const now = () => Date.parse('2026-07-11T18:00:00Z');
const departureUtc = '2026-07-12T06:00:00Z';
const departures = ['2026-07-12T00:00:00Z', '2026-07-12T06:00:00Z', '2026-07-12T12:00:00Z', '2026-07-12T18:00:00Z'];
const fixture: Record<string, string> = {
  forecast: './fixtures/openmeteo-forecast-cherbourg-plymouth.json', ensemble: './fixtures/openmeteo-ensemble-cherbourg-plymouth.json',
  marine: './fixtures/openmeteo-marine-cherbourg-plymouth.json', multimodel: './fixtures/openmeteo-multimodel-cherbourg-plymouth.json',
};
const store = () => new ScenarioBundleStore({ loadBundle: async (name) => read(fixture[name]!), now });

/** A tile current mosaic over the route, as TileForecastStore.getCurrentGrid builds one (clocks included). */
function tileGrid(): RegionGrid {
  const nlat = 12, nlon = 14;
  const time_axis = Array.from({ length: 13 }, (_, h) => new Date(Date.parse('2026-07-12T00:00Z') + h * 6 * 3600_000).toISOString());
  const size = nlat * nlon * time_axis.length;
  return { schema_version: 1, kind: 'surface_current', run_id: 'tile-current', generated_at: '2026-07-11T17:00:00Z',
    lat0: 49.5, lon0: -4.5, dlat: 0.1, dlon: 0.25, nlat, nlon, time_axis,
    u_kt: Array.from({ length: size }, (_, i) => Math.round(Math.sin(i / 7) * 100) / 100),
    v_kt: Array.from({ length: size }, (_, i) => Math.round(Math.cos(i / 5) * 100) / 100),
    source: { mode: 'live', dataset_id: 'tile-cmems', resolution_deg: 0.083, fetched_at: '2026-07-11T17:30:00Z' } };
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
/** The scan's shared current input, deep-frozen as the planner's freezeActionInputs leaves it. */
function frozenCurrentInput() {
  const grid = tileGrid();
  return deepFreeze({ grid, provenance: { source: 'tiles', current_source: 'tiles', content_digest: contentHash(grid), digest_algorithm: 'fnv1a64' } });
}

const isDecisionInputs = (value: unknown) => typeof value === 'object' && value !== null && 'engine_semantics' in value;
const isCurrentGrid = (value: unknown) => typeof value === 'object' && value !== null && (value as RegionGrid).kind === 'surface_current' && 'u_kt' in value;
const count = (test: (value: unknown) => boolean) => seen.hashed.filter(test).length;

class MemorySnapshots {
  files = new Map<string, string>();
  async exists(id: string) { return [...this.files.keys()].some(key => key.startsWith(`${id}/`)); }
  async read(id: string, name: string) { return this.files.get(`${id}/${name}`) ?? null; }
  async list() { return [...this.files].filter(([key]) => key.endsWith('/snapshot.json')).map(([, text]) => JSON.parse(text)); }
  async write(id: string, name: string, text: string) { this.files.set(`${id}/${name}`, text); }
}

beforeEach(() => { seen.hashed.length = 0; seen.assembled.length = 0; });

describe('a departure scan', () => {
  it('hashes no candidate decision inputs and never the shared frozen current grid', async () => {
    const currentInput = frozenCurrentInput();
    seen.hashed.length = 0;
    const scan = await scanDepartures({ route, profile, store: store(), now, currentInput }, departures);
    expect(scan.candidates).toHaveLength(departures.length);
    expect(count(isDecisionInputs)).toBe(0);
    expect(count(isCurrentGrid)).toBe(0);
  });

  it('hashes a current grid it reads itself once for the whole scan, not once per candidate', async () => {
    const tiles = store();
    vi.spyOn(tiles, 'getCurrentGrid').mockImplementation(async () => tileGrid()); // unfrozen, as the store returns it
    const scan = await scanDepartures({ route, profile, store: tiles, now }, departures);
    expect(count(isCurrentGrid)).toBe(1);
    expect(count(isDecisionInputs)).toBe(0);
    expect(scan.input_records?.find(record => record.layer === 'currents')).toMatchObject({ current_source: 'tiles', content_digest: contentHash(tileGrid()) });
  });

  it.each([
    ['a frozen shared current input', () => ({ currentInput: frozenCurrentInput() })],
    ['a current grid it reads itself', () => ({})],
    ['no current grid', () => ({ currentInput: { provenance: { current_source: 'tiles', source: 'tiles' } } })],
  ])('returns the same bytes as a scan that computes every candidate identity, with %s', async (_, extra) => {
    const run = async (savedIdentity: boolean) => {
      const tiles = store();
      vi.spyOn(tiles, 'getCurrentGrid').mockImplementation(async () => tileGrid());
      const progress: string[] = [];
      seen.hashed.length = 0;
      const scan = await scanCandidates({ route, profile, store: tiles, now, ...extra() }, departures,
        candidate => progress.push(JSON.stringify(candidate)), { savedIdentity });
      return { scan: JSON.stringify(scan), progress, decisionHashes: count(isDecisionInputs) };
    };
    const full = await run(true);
    const ranked = await run(false);
    expect(full.decisionHashes).toBe(departures.length); // the comparison path really is the one with identities
    expect(ranked.decisionHashes).toBe(0);
    expect(ranked.scan).toBe(full.scan);
    expect(ranked.progress).toEqual(full.progress);
  });
});

describe('a Check', () => {
  it('builds its decision inputs once: the current grid is hashed once, and the saved inputs are the ones hashed', async () => {
    const currentInput = frozenCurrentInput();
    seen.hashed.length = 0;
    const result = await runAnalysis({ route, profile, departureUtc, store: store(), now, currentInput });
    expect(count(isCurrentGrid)).toBe(1);
    expect(count(isDecisionInputs)).toBe(1);
    // the old path: findings and decision inputs computed separately from the same assembled options
    const assembled = seen.assembled[0] as AssembleOptions;
    expect(seen.assembled).toHaveLength(1);
    expect(canonicalJson(result.snapshotInputs.decisionInputs)).toBe(canonicalJson(decisionInputs(assembled)));
    expect(JSON.stringify(result.findings)).toBe(JSON.stringify(assembleFindings(assembled)));
    expect(contentHash(result.snapshotInputs.decisionInputs)).toBe(result.findings.decision_hash);
    const saved = new MemorySnapshots();
    expect(await persistSnapshot(saved, result, route, now())).toBe(result.findings.snapshot_id);
    expect(contentHash(JSON.parse(saved.files.get(`${result.findings.snapshot_id}/decision-inputs.json`)!))).toBe(result.findings.decision_hash);
  });

  it('audited without its saved identity differs only by that identity, and cannot be saved', async () => {
    const options = () => ({ route, profile, departureUtc, store: store(), now, currentInput: frozenCurrentInput() });
    const full = await runAnalysis(options());
    const ranked = await runAnalysis(withoutSavedIdentity(options()));
    expect(ranked.findings.snapshot_id).toBe('');
    expect(ranked.findings.decision_hash).toBeUndefined();
    expect(ranked.snapshotInputs.decisionInputs).toBeUndefined();
    const restored = { ...ranked.findings, snapshot_id: full.findings.snapshot_id, decision_hash: full.findings.decision_hash };
    expect(JSON.stringify(restored)).toBe(JSON.stringify(full.findings));
    await expect(persistSnapshot(new MemorySnapshots(), ranked, route, now())).rejects.toThrow('conflict with its identity');
  });

  it('a copy of options marked without identity is audited with its identity', async () => {
    const marked = withoutSavedIdentity({ route, profile, departureUtc, store: store(), now, currentInput: frozenCurrentInput() });
    const copy = await runAnalysis({ ...marked });
    expect(copy.findings.snapshot_id).toMatch(/^snapshot_v2_[0-9a-f]{16}$/);
    expect(contentHash(copy.snapshotInputs.decisionInputs)).toBe(copy.findings.decision_hash);
  });
});
