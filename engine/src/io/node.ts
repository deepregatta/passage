/** Node-only IO adapters (kept out of the browser-safe core). */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { LatestDoc, RunManifest, TileTransport } from '../forecast/store.js';
import type { SnapshotStore } from '../snapshot.js';

export class NodeFsSnapshotStore implements SnapshotStore {
  constructor(private root: string) {}

  async exists(snapshotId: string): Promise<boolean> {
    const directory = join(this.root, snapshotId);
    return existsSync(directory) && readdirSync(directory).length > 0;
  }

  async write(snapshotId: string, filename: string, content: string): Promise<void> {
    const path = join(this.root, snapshotId, filename);
    if (existsSync(path)) {
      throw new Error(`Snapshot artifact already exists (write-once): ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/**
 * Tile transport over a local directory laid out like the R2 bucket
 * (latest.json, forecast-runs/{run_id}/…). Used by the CLI and by tests
 * against fixture runs (e.g. an `ingest weather --dry-run` output).
 */
export class FsTileTransport implements TileTransport {
  constructor(private root: string) {}

  async fetchLatest(): Promise<LatestDoc> {
    return JSON.parse(readFileSync(join(this.root, 'latest.json'), 'utf8')) as LatestDoc;
  }

  async fetchManifest(runId: string): Promise<RunManifest> {
    return JSON.parse(
      readFileSync(join(this.root, 'forecast-runs', runId, 'manifest.json'), 'utf8'),
    ) as RunManifest;
  }

  async fetchTile(runId: string, path: string): Promise<Uint8Array> {
    const bytes = readFileSync(join(this.root, 'forecast-runs', runId, path));
    return new Uint8Array(gunzipSync(bytes));
  }
}
