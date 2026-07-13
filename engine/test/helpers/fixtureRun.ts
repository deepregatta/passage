/**
 * In-memory fixture tile runs for TileForecastStore tests: builds PFT1 tiles
 * with the test-only encoder and serves them through an in-memory transport.
 * Values are analytic so tests can assert exact expectations.
 */

import { encodeTile, type TileHeader, type TileVariable } from '../../src/forecast/tileCodec.js';
import type { LatestDoc, RunManifest, TileTransport } from '../../src/forecast/store.js';

export interface FixtureVariable {
  name: string;
  axis: string;
  dtype: 'i16' | 'i8';
  scale: number;
  per_member?: boolean;
  /** value(member, timeIdx, latIdx, lonIdx); NaN = missing */
  value: (m: number, t: number, i: number, j: number) => number;
}

export interface FixtureLayerSpec {
  layer: string;
  model: string;
  cycle: string; // e.g. '2026-07-20T00:00Z'
  resolution_deg: number;
  member_count?: number;
  time_axes: Record<string, { base: string; offsets_h: number[] }>;
  variables: FixtureVariable[];
  /** SW corners of the tiles to build, e.g. [[50, -10], [50, 0]] */
  tiles: Array<[number, number]>;
  /** grid points per tile side (default: 10 / resolution_deg) */
  pointsPerSide?: number;
}

export class MemoryTileTransport implements TileTransport {
  constructor(
    public latest: LatestDoc,
    public manifests: Map<string, RunManifest>,
    public tiles: Map<string, Uint8Array>, // key: `${runId}/${path}`
    public failManifests = new Set<string>(),
  ) {}

  async fetchLatest(): Promise<LatestDoc> {
    return this.latest;
  }

  async fetchManifest(runId: string): Promise<RunManifest> {
    if (this.failManifests.has(runId)) throw new Error(`manifest unavailable: ${runId}`);
    const manifest = this.manifests.get(runId);
    if (!manifest) throw new Error(`no manifest: ${runId}`);
    return manifest;
  }

  async fetchTile(runId: string, path: string): Promise<Uint8Array> {
    const tile = this.tiles.get(`${runId}/${path}`);
    if (!tile) throw new Error(`no tile: ${runId}/${path}`);
    return tile; // fixture tiles are stored uncompressed
  }
}

function tileIdOf(lat0: number, lon0: number): string {
  const ns = lat0 >= 0 ? 'N' : 'S';
  const ew = lon0 >= 0 ? 'E' : 'W';
  return `${ns}${String(Math.abs(lat0)).padStart(2, '0')}${ew}${String(Math.abs(lon0)).padStart(3, '0')}`;
}

export function buildFixtureRun(
  specs: FixtureLayerSpec[],
  updatedAt = '2026-07-20T04:00:00Z',
): MemoryTileTransport {
  const latest: LatestDoc = { schema_version: 1, updated_at: updatedAt, layers: {} };
  const manifests = new Map<string, RunManifest>();
  const tiles = new Map<string, Uint8Array>();

  for (const spec of specs) {
    // '2026-07-20T00:00Z' -> 'weather-20260720T00Z'
    const runId = `${spec.layer}-${spec.cycle.slice(0, 13).replace(/-/g, '')}Z`;
    const memberCount = spec.member_count ?? 1;
    const n = spec.pointsPerSide ?? Math.round(10 / spec.resolution_deg);
    const zDir = `z${String(spec.resolution_deg).replace('0.', '0').replace('.', '')}`;
    const pathTemplate = `${spec.layer}/${zDir}/{tile_id}.bin`;

    const manifestTiles: RunManifest['tiles'] = {};
    for (const [lat0, lon0] of spec.tiles) {
      const tileId = tileIdOf(lat0, lon0);
      const header: TileHeader = {
        spec: 'PFT1',
        schema_version: 1,
        layer: spec.layer,
        model: spec.model,
        run_id: runId,
        cycle: spec.cycle,
        generated_at: updatedAt,
        tile_id: tileId,
        lat0,
        lon0,
        dlat: spec.resolution_deg,
        dlon: spec.resolution_deg,
        nlat: n,
        nlon: n,
        time_axes: spec.time_axes,
        member_count: memberCount,
        variables: spec.variables.map(({ value: _v, ...rest }) => rest) as TileVariable[],
      };
      const arrays: Record<string, Float32Array> = {};
      for (const variable of spec.variables) {
        const nTime = spec.time_axes[variable.axis]!.offsets_h.length;
        const members = variable.per_member ? memberCount : 1;
        const values = new Float32Array(members * nTime * n * n);
        let k = 0;
        for (let m = 0; m < members; m++) {
          for (let t = 0; t < nTime; t++) {
            for (let i = 0; i < n; i++) {
              for (let j = 0; j < n; j++) values[k++] = variable.value(m, t, i, j);
            }
          }
        }
        arrays[variable.name] = values;
      }
      const encoded = encodeTile(
        { ...header, variables: spec.variables.map(({ value: _v, ...rest }) => rest) },
        arrays,
      );
      tiles.set(`${runId}/${spec.layer}/${zDir}/${tileId}.bin`, encoded);
      manifestTiles[tileId] = { bytes: encoded.byteLength, fnv64: '0'.repeat(16) };
    }

    manifests.set(runId, {
      schema_version: 1,
      run_id: runId,
      layer: spec.layer,
      model: spec.model,
      cycle: spec.cycle,
      member_count: memberCount,
      resolution_deg: spec.resolution_deg,
      horizon_h: Math.max(...Object.values(spec.time_axes).flatMap((a) => a.offsets_h)),
      time_axes: spec.time_axes,
      variables: spec.variables.map(({ value: _v, ...rest }) => rest),
      tiling: { tile_deg: 10, path_template: pathTemplate },
      tiles: manifestTiles,
      totals: { tile_count: Object.keys(manifestTiles).length, bytes: 0 },
      published_at: updatedAt,
    });
    latest.layers[spec.layer] = {
      run_id: runId,
      previous_run_id: null,
      cycle: spec.cycle,
      ...(memberCount > 1 ? { member_count: memberCount } : {}),
      published_at: updatedAt,
    };
  }

  return new MemoryTileTransport(latest, manifests, tiles);
}
