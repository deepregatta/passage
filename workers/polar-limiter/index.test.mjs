import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import limiter, { ClientWindow, LIMITS, WINDOW_MS } from './index.mjs';

function storage() {
  const data = new Map();
  return {
    data, alarm: null,
    get: async (key) => data.get(key),
    put: async (key, value) => { data.set(key, value); },
    setAlarm: async function (at) { this.alarm = at; },
    deleteAll: async () => { data.clear(); },
  };
}
// The CLIENT_WINDOWS namespace: one ClientWindow per name, as Durable Objects are.
function namespace() {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (id) => {
      if (!objects.has(id)) objects.set(id, new ClientWindow({ storage: storage() }));
      return { fetch: (url) => objects.get(id).fetch(new Request(url)) };
    },
  };
}
const ask = async (env, kind, key) => {
  const response = await limiter.fetch(new Request('https://passage-polar-limiter/limit', {
    method: 'POST', body: JSON.stringify({ kind, key }),
  }), env);
  return (await response.json()).allowed;
};
const times = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push(await fn()); return out; };

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test('a client gets exactly its limit per kind in any 60 s, counted apart from other clients and kinds', async () => {
  const env = { CLIENT_WINDOWS: namespace() };
  const boats = await times(LIMITS.boat + 5, () => ask(env, 'boat', '203.0.113.7'));
  assert.equal(boats.filter(Boolean).length, LIMITS.boat);
  assert.deepEqual(boats.slice(LIMITS.boat), [false, false, false, false, false]);
  assert.equal(await ask(env, 'boat', '198.51.100.4'), true);
  const lists = await times(LIMITS.index + 1, () => ask(env, 'index', '203.0.113.7'));
  assert.equal(lists.filter(Boolean).length, LIMITS.index);
  assert.deepEqual([...env.CLIENT_WINDOWS.objects.keys()].sort(),
    ['boat:198.51.100.4', 'boat:203.0.113.7', 'index:203.0.113.7']);
});

test('the window slides: a request is allowed again once the oldest allowed one is 60 s old', async () => {
  const counter = new ClientWindow({ storage: storage() });
  const admit = async () => (await (await counter.fetch(new Request('https://client-window/?limit=2'))).json()).allowed;
  assert.equal(await admit(), true);
  mock.timers.tick(30_000);
  assert.equal(await admit(), true);
  assert.equal(await admit(), false, 'denied requests are not counted');
  mock.timers.tick(WINDOW_MS - 30_000);
  assert.equal(await admit(), true);
  assert.equal(await admit(), false);
});

test('a quiet minute deletes the window', async () => {
  const state = { storage: storage() };
  const counter = new ClientWindow(state);
  await counter.fetch(new Request('https://client-window/?limit=2'));
  assert.equal(state.storage.alarm, 1_000_000 + WINDOW_MS);
  await counter.alarm();
  assert.equal(state.storage.data.size, 0);
});

test('anything else is refused without counting', async () => {
  const env = { CLIENT_WINDOWS: namespace() };
  const send = (init) => limiter.fetch(new Request('https://passage-polar-limiter/limit', init), env).then((r) => r.status);
  assert.equal(await send(), 405);
  assert.equal(await send({ method: 'POST', body: JSON.stringify({ kind: 'other', key: 'x' }) }), 400);
  assert.equal(await send({ method: 'POST', body: JSON.stringify({ kind: 'boat' }) }), 400);
  assert.equal(await send({ method: 'POST', body: '{' }), 400);
  assert.equal(env.CLIENT_WINDOWS.objects.size, 0);
});
