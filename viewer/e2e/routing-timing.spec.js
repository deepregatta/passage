import { expect, test } from '@playwright/test';
import path from 'node:path';
import { DEPARTURE, routingInputs } from '../test/fixtures/routingTiming.js';

const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;
async function installForecast(page, along) {
  await page.evaluate(async ({ engineUrl, along }) => {
    const engine = await import(engineUrl);
    const { routingInputs, auditStore } = await import('/test/fixtures/routingTiming.js');
    const { forecastStore } = await import('/src/lib/forecastStore.js');
    const inputs = routingInputs(along);
    const fixture = auditStore(engine, inputs.currentGrid);
    const store = forecastStore();
    for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid']) {
      store[method] = fixture[method].bind(fixture);
    }
    store.getWindGrid = async () => inputs.windGrid;
  }, { engineUrl, along });
}
const computed = page => page.evaluate(async () => (await import('/src/stores/plannerStore.js')).usePlanner.getState().computed);
async function settleMap(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
}

for (const along of [2, -2, 0]) {
  test(`Compute -> Check -> rerouted Scan -> Check preserves timing with ${along} kt current`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(DEPARTURE));
    // Fresh browser storage per test. Never send writes into the demo warehouse.
    const interceptedWrites = [];
    await page.route('**/data/**', async route => {
      if (route.request().method() === 'POST') {
        interceptedWrites.push(route.request().url());
        await route.fulfill({ status: 403 });
      } else await route.continue();
    });
    await page.route('**/api/event', route => route.fulfill({ status: 204 }));
    await page.route(/^https:\/\//, route => route.abort());
    // Tiny all-sea raster keeps routing transport entirely synthetic.
    await page.route('**/data/land/global-005.json', route => route.fulfill({ json: {
      lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4, bit_order: 'lsb',
    } }));
    await page.route('**/data/land/global-005.bin.gz', route => route.fulfill({ body: Buffer.alloc(2) }));
    await page.route('**/data/runs/latest.json', route => route.fulfill({ json: null }));
    await page.route(/\/data\/(polars\/boats|config\/polars)\/constant-5\.json$/, route =>
      route.fulfill({ json: routingInputs(along).polar }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('TypeError')) errors.push(message.text());
    });
    await page.goto('/#plan');
    await expect(page.getByRole('button', { name: 'Compute route', exact: true })).toBeVisible();
    await installForecast(page, along);
    await page.evaluate(async () => {
      const { usePlanner } = await import('/src/stores/plannerStore.js');
      const { toLocalDateTimeValue } = await import('/src/lib/format.js');
      usePlanner.getState().patch({ mode: 'compute', polarId: 'constant-5', polarLabel: 'Synthetic 5 kt polar',
        departureLocal: toLocalDateTimeValue('2026-07-20T00:00:00Z'),
        endpoints: [{ lat: 49.5, lng: -3.5 }, { lat: 49.5, lng: -3.2 }], computed: null });
    });
    await page.getByRole('button', { name: 'Compute route', exact: true }).click();
    const check = () => page.getByRole('button', { name: 'Check this passage', exact: true });
    await expect(check()).toBeEnabled();
    const routed = await computed(page);
    expect(routed.route.timing.basis).toBe('routed');
    expect(routed.route.speeds_kt.nominal).toBeCloseTo(5, 3);
    expect(routed.avg_sog_kt).toBeCloseTo(5 + along, 1);
    // The route's timing contract survives persisted planner drafts.
    await settleMap(page);
    await page.reload();
    await expect(check()).toBeEnabled();
    expect((await computed(page)).route.timing).toEqual(routed.route.timing);
    await installForecast(page, along);
    await settleMap(page);
    await check().click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    const arrival = () => page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().findings.legs.at(-1).eta_range.nominal);
    expect(await arrival()).toBe(routed.arrival_utc);
    await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
    await page.getByRole('button', { name: 'Compare departure times (next 5 days)' }).click();
    const comparison = page.getByRole('region', { name: 'Departure comparison' });
    await expect(comparison).toBeVisible({ timeout: 15000 });
    const scan = await page.evaluate(async () => (await import('/src/stores/plannerStore.js')).usePlanner.getState().scan);
    expect(scan.skipped).toEqual([]);
    expect(scan.candidates.length).toBeGreaterThan(1);
    for (const candidate of scan.candidates) expect(candidate.passage_h).toBe(scan.routes[candidate.departure_utc].duration_h);
    await settleMap(page);
    await comparison.getByRole('button').first().click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect(await arrival()).toBe((await computed(page)).arrival_utc);
    const snapshotId = await page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().snapshotId);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Choose a passage' })).toBeVisible();
    // A local briefing is restored by saved identity, using the real read path.
    await page.evaluate(async id => (await import('/src/stores/appStore.js')).useApp.getState().openSnapshot(id), snapshotId);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect(await arrival()).toBe((await computed(page)).arrival_utc);
    expect(interceptedWrites.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await testInfo.attach('scratch-routing-timing', { body: JSON.stringify({ along, routed, candidates: scan.candidates, interceptedWrites }, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('routing-briefing.png'), fullPage: true });
  });
}
