/** Node-only IO adapters (kept out of the browser-safe core). */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CacheStore } from '../fetch/openMeteo.js';

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
