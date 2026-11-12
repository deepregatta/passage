/**
 * The fixed departure scan pinned by `test/golden/scan-cherbourg-plymouth.json`:
 * four departures on the committed Cherbourg -> Plymouth forecast fixtures, a
 * fixed clock, and a tile current grid shared by the whole scan. The engine is a
 * parameter so the golden can be generated from another checkout of the engine
 * (see `scripts/make-scan-golden.ts`) and compared with this one (`scanGolden.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { scanDepartures as ScanDepartures, WindowCandidate } from '../../src/window.js';
import type { ScenarioBundleStore as Store } from '../../src/forecast/scenarioStore.js';
import type { contentHash as ContentHash } from '../../src/hash.js';
import type { RegionGrid } from '../../src/grids.js';

export interface ScanEngine {
  scanDepartures: typeof ScanDepartures;
  ScenarioBundleStore: typeof Store;
  contentHash: typeof ContentHash;
}

export const GOLDEN_DEPARTURES = ['2026-07-12T00:00:00Z', '2026-07-12T06:00:00Z', '2026-07-12T12:00:00Z', '2026-07-12T18:00:00Z'];
const NOW_MS = Date.parse('2026-07-11T18:00:00Z');
const FIXTURES = ['forecast', 'ensemble', 'marine', 'multimodel'];

/** A tile current mosaic over the route (clocks included, as the tile store builds one); invented values. */
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

/** The scan result and the progress callback's candidates, serialized as the golden holds them. `root` holds `engine/` and `config/`. */
export async function goldenScan(engine: ScanEngine, root: string): Promise<string> {
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const bundles = Object.fromEntries(FIXTURES.map(name => [name, `engine/test/fixtures/openmeteo-${name}-cherbourg-plymouth.json`]));
  const store = new engine.ScenarioBundleStore({ loadBundle: async name => (bundles[name] ? read(bundles[name]) : null), now: () => NOW_MS });
  const grid = tileGrid();
  const currentInput = { grid, provenance: { source: 'tiles', current_source: 'tiles', content_digest: engine.contentHash(grid), digest_algorithm: 'fnv1a64' } };
  const progress: WindowCandidate[] = [];
  const scan = await engine.scanDepartures({
    route: read('config/routes/cherbourg-plymouth.json'), profile: read('config/profiles/default-limits.json'),
    store, now: () => NOW_MS, currentInput,
  }, GOLDEN_DEPARTURES, candidate => progress.push(JSON.parse(JSON.stringify(candidate))));
  return JSON.stringify({ scan, progress }, null, 2);
}
