import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Import a check from a file (2026-11-15; the control is "Import from a file" since 2026-11-16): a real Check in fixture mode is saved
// in this test's own browser storage, saved to a file, and imported into a second,
// empty browser context. The imported check opens with its label, the same verdict
// and departure; a file that is not a check file is refused with a message. Demo
// /data/ is only read.
const DEPARTURE = '2026-07-20T00:00:00Z';
const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;

async function prepare(page) {
  await page.clock.setFixedTime(new Date(DEPARTURE));
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/api/event', (route) => route.fulfill({ status: 204 }));
  await page.route('**/data/runs/latest.json', (route) => route.fulfill({ json: null }));
  await page.route('**/data/**', async (route) => {
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(route.request().method())) await route.fulfill({ status: 403 });
    else await route.continue();
  });
}

test('a check saved to a file imports into another browser, labelled, with the same verdict and departure', async ({ page, browser }, testInfo) => {
  await prepare(page);
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(async ({ engineUrl, departure }) => {
    const engine = await import(engineUrl);
    const { auditStore } = await import('/test/fixtures/routingTiming.js');
    const fixture = auditStore(engine, undefined);
    const store = (await import('/src/lib/forecastStore.js')).forecastStore();
    for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid']) store[method] = fixture[method].bind(fixture);
    store.refresh = async () => [];
    store.lastCheckedMs = () => Date.now();
    const planner = (await import('/src/stores/plannerStore.js')).usePlanner.getState();
    const { toLocalDateTimeValue } = await import('/src/lib/format.js');
    planner.patch({ mode: 'draw', waypoints: [{ lat: 49.5, lng: -3.5 }, { lat: 49.5, lng: -3.2 }],
      name: 'Scratch import', departureLocal: toLocalDateTimeValue(departure), speeds: { slow: 4, nominal: 5, fast: 6 } });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, { engineUrl, departure: DEPARTURE });
  await expect(page.locator('.passage-marker')).toHaveCount(2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
  const band = page.getByTestId('decision-band');
  await expect(band).toBeVisible();
  const original = {
    verdict: await band.locator('span.rounded-sm.text-white').first().innerText(),
    departure: await band.locator('p.font-mono').first().innerText(),
    id: await page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().snapshotId),
  };
  const downloading = page.waitForEvent('download');
  await band.getByRole('button', { name: 'Save a copy to a file' }).click();
  const file = await (await downloading).path();

  // a second browser, with nothing saved
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  const other = await context.newPage();
  try {
    await prepare(other);
    await other.goto('/#passages');
    const control = other.getByTestId('import-check');
    await expect(control.getByRole('button', { name: 'Import from a file' })).toBeVisible();
    await expect(control.getByText('It is read in this browser; nothing is uploaded.', { exact: false })).toBeVisible();

    // a hostile file first: refused, nothing stored
    await control.locator('input[type="file"]').setInputFiles({ name: 'passage-check.json.gz', mimeType: 'application/gzip', buffer: Buffer.from('<script>not a check</script>') });
    await expect(control.getByRole('alert')).toHaveText('This file is not a Passage check file.');
    expect(await other.evaluate(async () => (await (await import('/src/lib/localSnapshots.js')).localSnapshots.list()).length)).toBe(0);

    await control.locator('input[type="file"]').setInputFiles(file);
    await expect(control.getByTestId('import-result')).toHaveText(/^Check imported from a file, departing .+\.$/);
    const card = other.locator(`[data-snapshot-id="${original.id}"]`).locator('xpath=ancestor::article');
    await expect(card.getByTestId('imported-label')).toHaveText(/^Imported from a file, not recomputed here · check made .+$/);
    await control.getByRole('button', { name: 'Open the check' }).click();
    const imported = other.getByTestId('decision-band');
    await expect(imported).toBeVisible();
    await expect(imported.getByTestId('imported-label')).toHaveText(/^Imported from a file, not recomputed here · check made .+$/);
    expect(await imported.locator('span.rounded-sm.text-white').first().innerText()).toBe(original.verdict);
    expect(await imported.locator('p.font-mono').first().innerText()).toBe(original.departure);
    expect(await other.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().snapshotId)).toBe(original.id);
    // the file is the one saved: its gzip came from this test's download
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  } finally {
    await context.close();
  }
});
