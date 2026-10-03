import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataMiddleware } from '../vite.config.js';

let scratch, server;
const fixtureRoot = path.join(import.meta.dirname, 'fixtures/demo');
const snapshotId = '20260720T060000Z_44d2cd5f_64ea971e';

function bytes(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
    }));
}

async function start(fixture) {
  vi.stubEnv('VITE_DW_FIXTURE', fixture);
  let handler;
  dataMiddleware({ dataRoot: scratch }).configureServer({ middlewares: { use(fn) { handler = fn; } } });
  server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'passage-fixture-'));
  fs.cpSync(fixtureRoot, scratch, { recursive: true });
});
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('refuses fixture mutations over HTTP and preserves every file byte and name', async () => {
  const committed = bytes(fixtureRoot), before = bytes(scratch);
  const routeFile = fs.readdirSync(path.join(scratch, 'routes')).find(file => file.endsWith('.json'));
  await start('demo');
  for (const [method, url] of [
    ['POST', `/data/routes/${routeFile}`],
    ['POST', '/data/routes/new-route.json'],
    ['POST', '/data/snapshots/new-snapshot/findings.json'],
    ['POST', `/data/snapshots/${snapshotId}/snapshot.json`],
    ['DELETE', `/data/snapshots/${snapshotId}`],
    ['PUT', `/data/routes/${routeFile}`],
    ['PATCH', `/data/snapshots/${snapshotId}/snapshot.json`],
  ]) {
    const response = await request(method, url, '{"scratch":true}');
    expect(response, `${method} ${url}`).toEqual({ status: 403, body: 'Fixture data is read-only' });
    expect(bytes(scratch)).toEqual(before);
  }
  const read = await request('GET', `/data/snapshots/${snapshotId}/snapshot.json`);
  expect(read.status).toBe(200);
  expect(read.body).toBe(fs.readFileSync(path.join(scratch, 'snapshots', snapshotId, 'snapshot.json'), 'utf8'));
  expect((await request('GET', '/data/snapshots/manifest.json')).status).toBe(200);
  expect(bytes(fixtureRoot)).toEqual(committed);
});

it('retains write-once snapshot persistence and deletion outside fixture mode in scratch storage', async () => {
  await start('');
  const url = '/data/snapshots/scratch-snapshot/snapshot.json';
  const body = '{"snapshot_id":"scratch-snapshot"}';
  expect((await request('POST', '/data/routes/scratch-route.json', '{}')).status).toBe(201);
  expect((await request('POST', url, body)).status).toBe(201);
  expect((await request('POST', url, '{"replacement":true}')).status).toBe(409);
  expect((await request('GET', url)).body).toBe(body);
  expect((await request('DELETE', '/data/snapshots/scratch-snapshot')).status).toBe(200);
  expect(fs.existsSync(path.join(scratch, 'snapshots/scratch-snapshot'))).toBe(false);
});
