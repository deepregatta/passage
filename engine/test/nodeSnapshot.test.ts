import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NodeFsSnapshotStore } from '../src/io/node.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('detects partial snapshots before their manifest exists and preserves write-once artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'passage-snapshot-'));
  roots.push(root);
  const store = new NodeFsSnapshotStore(root);
  expect(await store.exists('missing')).toBe(false);
  mkdirSync(join(root, 'empty'));
  expect(await store.exists('empty')).toBe(false);
  await store.write('partial', 'findings.json', '{"original":true}');
  expect(await store.exists('partial')).toBe(true);
  await expect(store.write('partial', 'findings.json', '{}')).rejects.toThrow('write-once');
  expect(readFileSync(join(root, 'partial/findings.json'), 'utf8')).toBe('{"original":true}');
  await store.write('complete', 'snapshot.json', '{}');
  expect(await store.exists('complete')).toBe(true);
});
