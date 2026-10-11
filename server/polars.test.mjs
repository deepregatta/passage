// /api/polars against an invented release. Nothing here is real polar data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { DEEP_POLARS } from './deepPolarsPin.mjs';
import { clientKey, polarHandlers } from './polars.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const boat = JSON.stringify({ format: 'deepregatta-polars/1', id: 'test-boat', label: 'Test boat',
  table: { twa_deg: [60, 120], tws_kt: [6, 12], speeds_kt: [[4, 6], [5, 7]] } });
const index = JSON.stringify({ format: 'deepregatta-polars-index/1', version: '9999.1', contract: 'deepregatta-polars/1',
  boats: [{ id: 'test-boat', label: 'Test boat', kind: 'type', variant_of: null, aliases: ['TB'], builder: 'Nobody',
    loa_m: 10, loa_range_m: null, year: 2020, source: 'Invented', source_id: 'test-boat.pol', sha256: sha(boat) }] });
const pin = { repository: 'example/polars', version: '9999.1', commit: 'c0ffee', indexSha256: sha(index) };

let files, calls, limits, logs, originalFetch, originalWarn, originalError;
beforeEach(() => {
  files = { 'releases/9999.1/index.json': index, 'releases/9999.1/boats/test-boat.json': boat };
  calls = [];
  limits = [];
  logs = [];
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = console.error = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ path: pathname, ref: searchParams.get('ref'), headers: init.headers });
    const path = pathname.replace('/repos/example/polars/contents/', '');
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
});

const limiter = (allowed = true) => ({
  fetch: async (_url, init) => {
    limits.push(JSON.parse(init.body));
    return Response.json({ allowed });
  },
});
const env = (overrides = {}) => ({ DEEP_POLARS_TOKEN: 'test-token', POLAR_LIMITER: limiter(), ...overrides });
const context = (path, id, envValues = env()) => ({
  request: new Request(`https://passage.test${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
  env: envValues, params: id === undefined ? {} : { id }, waitUntil() {},
});

test('the pinned release matches the shared-contracts lock', () => {
  const lock = JSON.parse(readFileSync(new URL('../contracts/shared-contracts.lock.json', import.meta.url), 'utf8'));
  const [release] = lock.releases.filter((row) => row.name === 'deepregatta-polars');
  assert.deepEqual(
    { repository: release.canonical_repository, version: release.version, commit: release.revision.replace('git-commit:', ''), indexSha256: release.sha256 },
    { ...DEEP_POLARS },
  );
  assert.equal(release.pinned_file, `releases/${DEEP_POLARS.version}/index.json`);
});

test('serves a verified boat once read, then from memory', async () => {
  const { handleBoat } = polarHandlers(pin);
  const first = await handleBoat(context('/api/polars/test-boat', 'test-boat'));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), boat);
  assert.equal(first.headers.get('Cache-Control'), 'private, max-age=3600');
  assert.equal(first.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(calls.map((call) => [call.path, call.ref]), [
    ['/repos/example/polars/contents/releases/9999.1/index.json', 'c0ffee'],
    ['/repos/example/polars/contents/releases/9999.1/boats/test-boat.json', 'c0ffee'],
  ]);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw+json');
  assert.equal((await handleBoat(context('/api/polars/test-boat', 'test-boat'))).status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(limits, [{ kind: 'boat', key: '203.0.113.7' }, { kind: 'boat', key: '203.0.113.7' }]);
});

test('the boat list carries picker fields only', async () => {
  const { handleIndex } = polarHandlers(pin);
  const response = await handleIndex(context('/api/polars'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: '9999.1', polars: [{
    polar_id: 'test-boat', label: 'Test boat', kind: 'type', variant_of: null, aliases: ['TB'],
    builder: 'Nobody', loa_m: 10, year: 2020, source: 'Invented',
  }] });
  assert.deepEqual(limits, [{ kind: 'index', key: '203.0.113.7' }]);
});

test('unknown and malformed ids are 404 without reading a boat', async () => {
  const { handleBoat } = polarHandlers(pin);
  for (const id of ['../index', 'Test-Boat', '']) {
    assert.equal((await handleBoat(context('/api/polars/x', id))).status, 404);
  }
  assert.equal(calls.length, 0);
  assert.equal((await handleBoat(context('/api/polars/no-such-boat', 'no-such-boat'))).status, 404);
  assert.deepEqual(calls.map((call) => call.path.split('/').pop()), ['index.json']);
});

test('a file that fails its digest is never served, and the log names only the path', async () => {
  files['releases/9999.1/boats/test-boat.json'] = boat.replace('[4,6]', '[4,9]');
  const { handleBoat } = polarHandlers(pin);
  const response = await handleBoat(context('/api/polars/test-boat', 'test-boat'));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /speeds|twa|tws/);
  assert.deepEqual(logs, ['polars: 502 integrity check failed for releases/9999.1/boats/test-boat.json']);

  files['releases/9999.1/index.json'] = index.replace('Nobody', 'Somebody');
  const tamperedIndex = polarHandlers(pin);
  assert.equal((await tamperedIndex.handleIndex(context('/api/polars'))).status, 502);
  files['releases/9999.1/index.json'] = index;
  assert.equal((await tamperedIndex.handleIndex(context('/api/polars'))).status, 200, 'a failed index is retried');
});

test('over the limit is 429 before anything is read', async () => {
  const { handleBoat, handleIndex } = polarHandlers(pin);
  const limited = env({ POLAR_LIMITER: limiter(false) });
  const response = await handleBoat(context('/api/polars/test-boat', 'test-boat', limited));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal((await handleIndex(context('/api/polars', undefined, limited))).status, 429);
  assert.equal(calls.length, 0);
});

test('a missing limiter or token refuses with 503 unless the limiter is off for local development', async () => {
  const { handleBoat } = polarHandlers(pin);
  const read = (values) => handleBoat(context('/api/polars/test-boat', 'test-boat', values)).then((r) => r.status);
  assert.equal(await read(env({ POLAR_LIMITER: undefined })), 503);
  assert.equal(await read(env({ POLAR_LIMITER: { fetch: async () => { throw new Error('down'); } } })), 503);
  assert.equal(await read(env({ DEEP_POLARS_TOKEN: undefined })), 503);
  assert.equal(calls.length, 0);
  assert.equal(await read(env({ POLAR_LIMITER: undefined, POLAR_RATE_LIMIT: 'off' })), 200);
});

test('an unavailable release is 503', async () => {
  delete files['releases/9999.1/index.json'];
  const { handleBoat } = polarHandlers(pin);
  assert.equal((await handleBoat(context('/api/polars/test-boat', 'test-boat'))).status, 503);
  assert.deepEqual(logs, ['polars: 503 release returned HTTP 404 for releases/9999.1/index.json']);
});

test('clients are addresses, IPv6 grouped by /64', () => {
  const key = (ip) => clientKey(new Request('https://x.test', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }));
  assert.equal(key('198.51.100.4'), '198.51.100.4');
  assert.equal(key('::ffff:198.51.100.4'), '198.51.100.4');
  assert.equal(key('2001:db8:0:12:aaaa::1'), '2001:db8:0:12::/64');
  assert.equal(key('2001:0db8:0000:0012:ffff:1:2:3'), '2001:db8:0:12::/64');
  assert.equal(key('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(key(null), 'unknown');
});
