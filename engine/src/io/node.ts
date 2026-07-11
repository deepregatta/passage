/** Node-only IO adapters (kept out of the browser-safe core). */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CacheStore } from '../fetch/openMeteo.js';
import type { SnapshotStore } from '../snapshot.js';

export class NodeFsSnapshotStore implements SnapshotStore {
  constructor(private root: string) {}

  async exists(snapshotId: string): Promise<boolean> {
    return existsSync(join(this.root, snapshotId, 'snapshot.json'));
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

export class FsCacheStore implements CacheStore {
  constructor(private root: string) {}

  private pathFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.root, `${safe}.json`);
  }

  async get(key: string): Promise<string | null> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  }

  async set(key: string, value: string): Promise<void> {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
}
