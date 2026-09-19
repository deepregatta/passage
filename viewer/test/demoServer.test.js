import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import verifyDemoServer from '../playwright.global-setup.js';

const config = { projects: [{ use: { baseURL: 'http://127.0.0.1:5174' } }] };
const demoIndex = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/demo/index.json'), 'utf8');
afterEach(() => vi.unstubAllGlobals());

it('accepts a demo server whose index matches this checkout', async () => {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    requests.push(url.pathname);
    return new Response(url.pathname === '/__passage_fixture' ? '{"fixture":"demo"}' : demoIndex);
  }));
  await verifyDemoServer(config);
  expect(requests).toEqual(['/__passage_fixture', '/data/index.json']);
});

it.each([
  ['live data', '{"fixture":null}', demoIndex],
  ['unidentified server', '<html>other application</html>', demoIndex],
  ['different checkout', '{"fixture":"demo"}', demoIndex.replace('64ea971e', 'different')],
])('rejects %s before the browser tests run', async (_, identity, index) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(url.pathname === '/__passage_fixture' ? identity : index)));
  await expect(verifyDemoServer(config)).rejects.toThrow('Playwright requires the viewer-demo launch configuration');
});

it.each([404, 503])('rejects unavailable fixture metadata (%s)', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status })));
  await expect(verifyDemoServer(config)).rejects.toThrow('Playwright requires the viewer-demo launch configuration');
});
