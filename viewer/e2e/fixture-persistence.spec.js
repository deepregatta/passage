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
      // the language only on the first load: a reload keeps the language switched to below
      if (!sessionStorage.getItem('e2e-language-set')) {
        localStorage.setItem('passage-language', language);
        sessionStorage.setItem('e2e-language-set', '1');
      }
      // every load, a reload included, brings back these limits, not the ones edited
      // below for the Check: the reloaded check must still show what it recorded
      localStorage.setItem('deepweather.profile-draft', JSON.stringify({ ...defaults, night_ok: false }));
    }, { defaults, language });
    // Counts the calls to navigator.storage.persist() (kept in sessionStorage, so a reload keeps the count) and passes them on.
    await page.addInitScript(() => {
      const storage = navigator.storage;
      const persist = storage?.persist?.bind(storage);
      if (persist) storage.persist = (...args) => {
        sessionStorage.setItem('e2e-persist-calls', String(Number(sessionStorage.getItem('e2e-persist-calls') ?? 0) + 1));
        return persist(...args);
      };
    });
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
    // The planner is a lazy chunk: wait until it has rendered before the evaluate touches its stores.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
      // Do not return in the turn that rendered the drawn route. On /fr/ LocalizedDocument's
      // MutationObserver re-translates the new map DOM in that same turn, and Chromium then
      // answers the pending evaluate with 'Promise was collected', which Playwright reports as
      // 'Execution context was destroyed, most likely because of a navigation'. No navigation
      // happens: the URL, document and context all survive, and the same evaluate on /fr/ passes
      // when the observer is disabled or when it resolves in a later frame (it failed on nearly
      // every French run, on both projects, before; English has no observer). The expect after
      // the evaluate waits for the route the patch drew.
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    }, { engineUrl, departure });
    await expect(page.locator('.passage-marker')).toHaveCount(2);
    const mobile = testInfo.project.name === 'mobile';
    await page.locator(mobile ? 'nav.md\\:hidden' : 'header').getByRole('button', { name: language === 'fr' ? /^Modifier mes limites/ : /^Edit my limits/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByText(disclosure[language], { exact: true })).toBeVisible();
    await dialog.getByLabel(language === 'fr' ? 'Rafales max.' : 'Max gusts').fill('31');
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
    // Asked once to keep the saved check (2026-11-15): not at page load, once after the real Check.
    const persistCalls = () => page.evaluate(() => Number(sessionStorage.getItem('e2e-persist-calls') ?? 0));
    await expect.poll(persistCalls).toBe(1);
    expect(saved.manifest.snapshot_id).toBe(saved.id);
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every(item => item.status === 403 && item.body === 'Fixture data is read-only')).toBe(true);
    // Stored compressed (2026-11-15): the records as Chromium's IndexedDB holds them.
    const stored = await page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const opening = indexedDB.open('passage-local-snapshots');
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction('files').objectStore('files').index('snapshot_id').getAll(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const local = (await import('/src/lib/localSnapshots.js')).localSnapshots;
      return Promise.all(records.map(async record => ({
        filename: record.filename, encoding: record.encoding ?? null,
        binary: record.content instanceof Uint8Array, stored: record.content.byteLength ?? record.content.length,
        text: (await local.read(id, record.filename)).length,
      })));
    }, saved.id);
    await testInfo.attach('stored-sizes', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });
    const decisionRecord = stored.find(item => item.filename === 'decision-inputs.json');
    expect(decisionRecord).toMatchObject({ encoding: 'gzip', binary: true });
    expect(decisionRecord.stored).toBeLessThan(decisionRecord.text);
    expect(stored.find(item => item.filename === 'snapshot.json')).toMatchObject({ encoding: null, binary: false });
    // A reload reopens the check that was open, from this browser's copy (2026-11-15):
    // same id, same findings and briefing sections, the same decision band (its
    // closest-limit line included, from the limits the check recorded, although the
    // reload brings back other limits) and no check id in the URL.
    const openCheck = () => page.evaluate(async () => {
      const app = (await import('/src/stores/appStore.js')).useApp.getState();
      return { id: app.snapshotId, source: app.snapshotSource, findings: app.findings, briefing: app.briefing };
    });
    const sections = () => page.locator('[data-section]').evaluateAll(nodes => nodes.map(node => node.dataset.section));
    const band = () => page.getByTestId('decision-band').innerText();
    const before = await openCheck();
    expect(before).toMatchObject({ id: saved.id, source: 'local', findings: saved.findings });
    const sectionsBefore = await sections();
    const bandBefore = await band();
    expect(bandBefore).toContain('Closest to your limits:');
    await expect(page).toHaveURL(/#passage$/);
    await page.reload();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await expect(page).toHaveURL(/#passage$/);
    expect(await openCheck()).toEqual(before);
    expect(await sections()).toEqual(sectionsBefore);
    expect(await band()).toBe(bandBefore);
    // Opened from My passages, it reopens after a reload too.
    await page.getByRole('link', { name: /^(My passages|Mes traversées)$/ }).first().click();
    await expect(page).toHaveURL(/#passages$/);
    // The storage line (2026-11-15): this origin's usage as the browser estimates it, whatever its size.
    await expect(page.getByTestId('storage-usage')).toContainText(
      /^Passage uses (?:less than 1 MB|about (?:\d+ MB|\d+\.\d GB)) of this browser’s storage, counting saved checks and downloaded forecasts\./);
    // The saved check lives only in this browser, which has not agreed to keep it (headless Chromium reports persisted() false).
    expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false);
    await expect(page.getByTestId('storage-not-kept')).toHaveText(
      'This browser can delete saved checks on its own, for example when the device is short of space or after a while without using Passage. Passage keeps no other copy.');
    expect(await persistCalls()).toBe(1); // reloads and visits do not ask again
    await page.locator(`button[data-snapshot-id="${saved.id}"]`).click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect(await band()).toBe(bandBefore);
    await page.reload();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect(await openCheck()).toEqual(before);
    expect(await band()).toBe(bandBefore);
    await page.evaluate(async id => (await import('/src/stores/appStore.js')).useApp.getState().deleteSnapshot(id), saved.id);
    expect(await page.evaluate(async id => (await import('/src/lib/localSnapshots.js')).localSnapshots.exists(id), saved.id)).toBe(false);
    expect(digest(scratch)).toEqual(scratchBytes);
    expect(digest(fixtureRoot)).toEqual(originalBytes);
    expect(errors).toEqual([]);
  });
}
