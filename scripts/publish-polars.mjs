#!/usr/bin/env node

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'data', 'processed', 'polars');
const target = join(repo, 'viewer', 'public', 'data', 'polars');

if (!existsSync(join(source, 'index.json'))) {
  throw new Error(`No generated polar database at ${source}; run build-polar-db first`);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Published polar database to ${target}`);
