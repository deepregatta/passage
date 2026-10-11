import assert from 'node:assert/strict';
import { test } from 'node:test';

import limiter from './index.mjs';

function binding(allowUntil) {
  const seen = [];
  return { seen, limit: async ({ key }) => { seen.push(key); return { success: seen.length <= allowUntil }; } };
}
const post = (body) => new Request('https://passage-polar-limiter/limit', { method: 'POST', body: JSON.stringify(body) });

test('boat and index reads use their own limits, keyed per client', async () => {
  const env = { BOAT_READS: binding(1), INDEX_READS: binding(5) };
  const ask = async (body) => (await (await limiter.fetch(post(body), env)).json()).allowed;
  assert.equal(await ask({ kind: 'boat', key: '203.0.113.7' }), true);
  assert.equal(await ask({ kind: 'boat', key: '203.0.113.7' }), false);
  assert.equal(await ask({ kind: 'index', key: '203.0.113.7' }), true);
  assert.deepEqual(env.BOAT_READS.seen, ['boat:203.0.113.7', 'boat:203.0.113.7']);
  assert.deepEqual(env.INDEX_READS.seen, ['index:203.0.113.7']);
});

test('anything else is refused', async () => {
  const env = { BOAT_READS: binding(9), INDEX_READS: binding(9) };
  assert.equal((await limiter.fetch(new Request('https://passage-polar-limiter/limit'), env)).status, 405);
  assert.equal((await limiter.fetch(post({ kind: 'other', key: 'x' }), env)).status, 400);
  assert.equal((await limiter.fetch(post({ kind: 'boat' }), env)).status, 400);
  assert.equal((await limiter.fetch(new Request('https://passage-polar-limiter/limit', { method: 'POST', body: '{' }), env)).status, 400);
  assert.deepEqual(env.BOAT_READS.seen, []);
});
