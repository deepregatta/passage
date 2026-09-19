import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([false, true])('resolves published revisions and saved chart paths (dev=%s)', async (dev) => {
  vi.resetModules();
  vi.stubEnv('DEV', dev);
  vi.stubEnv('VITE_FORECAST_BASE_URL', 'https://forecast.test/');
  const digest = 'a'.repeat(64);
  const root = 'runs/ecmwf-ifs025-20260916T00Z';
  const featuresPath = `${root}/synoptic/features.${digest}.json`;
  const chartPath = `${root}/synoptic/charts/t000.${digest}.png`;
  const doc = { artifacts: { synoptic_features: featuresPath, synoptic_charts: [chartPath] } };
  const features = { chart_captions: [{ file: chartPath }] };
  const base = dev ? '/data/' : 'https://forecast.test/prepared/';
  const pointerUrl = dev ? '/data/runs/latest.json' : `${base}latest.json`;
  const fetchMock = vi.fn(async (url) => {
    if (url === pointerUrl) return new Response(JSON.stringify(doc));
    if (url === `${base}${featuresPath}`) return new Response(JSON.stringify(features));
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { preparedRun, artifactUrl } = await import('../src/lib/preparedRun.js');
  const { chartUrl } = await import('../src/lib/synopticCharts.js');
  expect(chartUrl(chartPath, 'saved')).toBe(`${base}${chartPath}`);
  expect(fetchMock).not.toHaveBeenCalled();
  const source = await preparedRun();
  const loaded = await fetch(await artifactUrl(source.doc.artifacts.synoptic_features)).then((r) => r.json());
  expect(chartUrl(loaded.chart_captions[0].file, 'saved')).toBe(`${base}${chartPath}`);
  // Saved revisions are used verbatim, even when latest points elsewhere.
  const savedPath = chartPath.replace(digest, 'b'.repeat(64));
  expect(chartUrl(savedPath, 'saved')).toBe(`${base}${savedPath}`);
  expect(chartUrl(`${root}/synoptic/charts/t000.png`, 'legacy')).toBe(`${base}${root}/synoptic/charts/t000.png`);
  expect(chartUrl('charts/t000.png', 'demo')).toBe('/data/snapshots/demo/charts/t000.png');
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([pointerUrl, `${base}${featuresPath}`]);
});

it.each([false, true])('keeps saved chart URLs usable when latest is unavailable (dev=%s)', async (dev) => {
  vi.stubEnv('DEV', dev);
  vi.stubEnv('VITE_FORECAST_BASE_URL', 'https://forecast.test/');
  const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  const { preparedRun, artifactUrl } = await import('../src/lib/preparedRun.js');
  const { chartUrl } = await import('../src/lib/synopticCharts.js');
  const base = dev ? '/data/' : 'https://forecast.test/prepared/';
  const file = 'runs/saved/synoptic/charts/t000.png';
  expect(chartUrl(file, 'saved')).toBe(`${base}${file}`);
  expect(await preparedRun()).toEqual({ doc: null, base });
  expect(chartUrl(file, 'saved')).toBe(`${base}${file}`);
  expect(await artifactUrl(file)).toBe(`${base}${file}`);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${base}${dev ? 'runs/' : ''}latest.json`]);
});

it('uses the checked-in production host without a deployment environment override', async () => {
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_FORECAST_BASE_URL', '');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ artifacts: {} })));
  vi.stubGlobal('fetch', fetchMock);
  const { preparedRun } = await import('../src/lib/preparedRun.js');
  expect(await preparedRun()).toEqual({ doc: { artifacts: {} }, base: 'https://forecast.deepregatta.com/prepared/' });
  expect(fetchMock).toHaveBeenCalledWith('https://forecast.deepregatta.com/prepared/latest.json');
});
