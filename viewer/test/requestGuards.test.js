import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import config from '../vite.config.js';

const handlers = vi.hoisted(() => ({ static: null }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal();
  const createServer = (handler) => { handlers.static = handler; return { listen: vi.fn() }; };
  return { ...actual, createServer, default: { ...actual.default, createServer } };
});
import '../../scripts/serve-pages.mjs';

function response() {
  return { statusCode: 200, setHeader: vi.fn(), end: vi.fn(), writeHead(status) { this.statusCode = status; return this; } };
}
function middleware() {
  const plugin = config({ mode: 'test' }).plugins.find((item) => item.name === 'data-middleware');
  let handler;
  plugin.configureServer({ middlewares: { use: (fn) => { handler = fn; } } });
  return handler;
}
it.each(['GET', 'POST', 'DELETE'])('returns 400 for a malformed data URL via %s', async (method) => {
  vi.stubEnv('VITE_DW_FIXTURE', '');
  const res = response();
  try {
    await middleware()({ method, url: '/data/snapshots/%E0%A4%A' }, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.end).toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
it('returns 400 for a corrupt verification index without rejecting the request', async () => {
  const exists = fs.existsSync.bind(fs);
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => String(file).endsWith(path.join('verification', 'cases', 'index.json')) || exists(file));
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => String(file).endsWith(path.join('verification', 'cases', 'index.json')) ? '{broken' : read(file, ...args));
  const res = response();
  await middleware()({ method: 'GET', url: '/data/verification/cases/index.json' }, res, vi.fn());
  expect(res.statusCode).toBe(400);
  expect(res.end).toHaveBeenCalled();
});
it('rejects malformed POST JSON without writing it', async () => {
  const write = vi.spyOn(fs, 'writeFileSync');
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/data/routes/guard-regression.json' });
  const res = response();
  const pending = middleware()(req, res, vi.fn());
  req.emit('data', Buffer.from('{broken')); req.emit('end');
  await pending;
  expect(res.statusCode).toBe(400);
  expect(write).not.toHaveBeenCalled();
});
it.each(['/%E0%A4%A', 'http://['])('returns 400 for malformed static URL %s', async (url) => {
  const res = response();
  await handlers.static({ method: 'GET', url }, res);
  expect(res.statusCode).toBe(400);
  expect(res.end).toHaveBeenCalled();
});
it('preserves the static method guard', async () => {
  const res = response();
  await handlers.static({ method: 'POST', url: '/' }, res);
  expect(res.statusCode).toBe(405);
});
