import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), exists: vi.fn(), run: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  readFileSync: mocks.read,
  existsSync: mocks.exists,
}));
vi.mock('../src/analyze.js', () => ({ runAnalysis: mocks.run, persistSnapshot: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const route = { route_id: 'newport-newyork-v1', mode: 'fixed' };
let files: Map<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  process.argv = ['node', 'cli', 'run', '--route', '/test-route.json', '--tiles-url', 'https://unused.invalid', '--departure', '2026-07-20T06:00:00Z', '--print'];
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  files = new Map<string, unknown>([
    ['/test-route.json', route],
    ['/config/profiles/default-limits.json', {}],
    ['/data/processed/tides/index.json', { schema_version: 1, routes: { 'cherbourg-plymouth-v1': 'channel.json' } }],
    ['/data/processed/tides/channel.json', { ports: [{ port_id: 'cherbourg' }] }],
    ['/config/gates.json', { gates: [{ reference_port: 'cherbourg' }] }],
  ]);
  const keyFor = (path: string) => [...files.keys()].find((key) => path.endsWith(key));
  mocks.exists.mockReset().mockImplementation((path) => Boolean(keyFor(String(path))));
  mocks.read.mockReset().mockImplementation((path) => {
    const key = keyFor(String(path));
    if (!key) throw new Error(`Unexpected file read: ${path}`);
    return JSON.stringify(files.get(key));
  });
  mocks.run.mockReset().mockResolvedValue({ findings: {} });
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function runCli() {
  await import('../src/cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(0));
  return mocks.run.mock.calls[0]![0];
}

it('never loads Channel tides for an unmapped US route', async () => {
  const input = await runCli();
  expect(input.tides).toBeUndefined();
  expect(input.gates).toBeUndefined();
  expect(mocks.read.mock.calls.some(([path]) => String(path).endsWith('/tides/channel.json'))).toBe(false);
});

it('loads the exact mapped artifact and only matching gate reference ports', async () => {
  files.set('/data/processed/tides/index.json', { schema_version: 1, routes: { [route.route_id]: 'newport-newyork.json' } });
  const tides = { ports: [{ port_id: 'newport' }] };
  const gate = { reference_port: 'newport' };
  files.set('/data/processed/tides/newport-newyork.json', tides);
  files.set('/config/gates.json', { gates: [gate, { reference_port: 'cherbourg' }] });
  const input = await runCli();
  expect(input.tides).toEqual(tides);
  expect(input.gates).toEqual([gate]);
});

it('missing index leaves tides unassessed', async () => {
  files.delete('/data/processed/tides/index.json');
  expect((await runCli()).tides).toBeUndefined();
});

it('missing mapped file leaves tides unassessed', async () => {
  files.set('/data/processed/tides/index.json', { schema_version: 1, routes: { [route.route_id]: 'missing.json' } });
  expect((await runCli()).tides).toBeUndefined();
});
