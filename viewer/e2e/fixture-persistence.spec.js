import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataMiddleware } from '../vite.config.js';

const fixtureRoot = path.resolve(import.meta.dirname, '../test/fixtures/demo');
const defaults = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../config/profiles/default-limits.json')));
const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;
const departure = '2026-07-20T00:00:00Z';
const disclosure = {
  en: 'Night-sailing preference is not evaluated. It does not affect the verdict, departure scan or route timing.',
  fr: 'La préférence de navigation de nuit n’est pas évaluée. Elle ne modifie ni le verdict, ni la comparaison des départs, ni les horaires de la route.',
};
let scratch, server, baseURL, originalBytes, scratchBytes;

function digest(root) {
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  return files.map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return `${path.relative(root, file)}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  }).sort();
}

test.beforeAll(async () => {
  originalBytes = digest(fixtureRoot);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'passage-browser-fixture-'));
  fs.cpSync(fixtureRoot, scratch, { recursive: true });
  scratchBytes = digest(scratch);
  let handler;
  dataMiddleware({ dataRoot: scratch, fixtureMode: 'demo' }).configureServer({ middlewares: { use(fn) { handler = fn; } } });
  server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  try {
    expect(digest(fixtureRoot)).toEqual(originalBytes);
    expect(digest(scratch)).toEqual(scratchBytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

for (const language of ['en', 'fr']) {
  test(`${language}: planner falls back to IndexedDB and discloses the inactive night preference`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(departure));
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ defaults, language }) => {
      localStorage.setItem('passage-language', language);
      localStorage.setItem('deepweather.profile-draft', JSON.stringify({ ...defaults, night_ok: false }));
    }, { defaults, language });
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/event', route => route.fulfill({ status: 204 }));
    await page.route('**/data/runs/latest.json', route => route.fulfill({ json: null }));
    // Use the real dev persistence handler over HTTP, always rooted in a copy.
    // A future guard regression can fail this test without changing baselines.
    await page.route('**/data/**', async route => {
      if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(route.request().method())) {
        const response = await route.fetch({ url: baseURL + new URL(route.request().url()).pathname });
        mutations.push({ method: route.request().method(), status: response.status(), body: await response.text() });
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.goto(language === 'fr' ? '/fr/#plan' : '/#plan');
    await page.evaluate(async ({ engineUrl, departure }) => {
      const engine = await import(engineUrl);
      const fixture = (await import('/test/fixtures/routingTiming.js')).auditStore(engine, undefined);
      const store = (await import('/src/lib/forecastStore.js')).forecastStore();
      for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid']) store[method] = fixture[method].bind(fixture);
      store.refresh = async () => [];
      store.lastCheckedMs = () => Date.now();
      const planner = (await import('/src/stores/plannerStore.js')).usePlanner.getState();
      const { toLocalDateTimeValue } = await import('/src/lib/format.js');
      planner.patch({ mode: 'draw', waypoints: [{ lat: 49.5, lng: -3.5 }, { lat: 49.5, lng: -3.2 }],
        name: 'Scratch fixture protection', departureLocal: toLocalDateTimeValue(departure), speeds: { slow: 4, nominal: 5, fast: 6 } });
    }, { engineUrl, departure });
    const mobile = testInfo.project.name === 'mobile';
    await page.getByRole('button', { name: language === 'fr'
      ? (mobile ? 'Limites' : 'Modifier mes limites') : (mobile ? 'Limits' : 'Edit my limits'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByText(disclosure[language], { exact: true })).toBeVisible();
    await dialog.getByLabel(language === 'fr' ? 'Rafales max.' : 'Max gusts').fill('23');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('deepweather.profile-draft')).night_ok)).toBe(false);
    const screenshot = testInfo.outputPath('limits.png');
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach('limits', { path: screenshot, contentType: 'image/png' });
    await dialog.getByRole('button', { name: language === 'fr' ? 'Terminé' : 'Done', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
    // Switch to English for the existing planner workflow assertions.
    if (language === 'fr') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    const saved = await page.evaluate(async () => {
      const app = (await import('/src/stores/appStore.js')).useApp.getState();
      const local = (await import('/src/lib/localSnapshots.js')).localSnapshots;
      return { id: app.snapshotId, source: app.snapshotSource, findings: app.findings,
        manifest: JSON.parse(await local.read(app.snapshotId, 'snapshot.json')) };
    });
    expect(saved.source).toBe('local');
    expect(saved.manifest.snapshot_id).toBe(saved.id);
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every(item => item.status === 403 && item.body === 'Fixture data is read-only')).toBe(true);
    await page.reload();
    await page.evaluate(async id => (await import('/src/stores/appStore.js')).useApp.getState().openSnapshot(id), saved.id);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect(await page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().findings)).toEqual(saved.findings);
    await page.evaluate(async id => (await import('/src/stores/appStore.js')).useApp.getState().deleteSnapshot(id), saved.id);
    expect(await page.evaluate(async id => (await import('/src/lib/localSnapshots.js')).localSnapshots.exists(id), saved.id)).toBe(false);
    expect(digest(scratch)).toEqual(scratchBytes);
    expect(digest(fixtureRoot)).toEqual(originalBytes);
    expect(errors).toEqual([]);
  });
}
