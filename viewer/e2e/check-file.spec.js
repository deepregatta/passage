import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

// Save a copy of a check to a file (2026-11-15): a real Check in fixture mode is
// saved in this test's own browser storage (the dev middleware's writes are
// refused, so the browser keeps it), then "Save a copy to a file" downloads one
// gzip file. The test reads that file back and verifies its format, its check and
// that the decision inputs hash to the check id. Demo /data/ is only read.
const DEPARTURE = '2026-07-20T00:00:00Z';
const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;

test('a browser-saved check is saved to a gzip file that holds it exactly', async ({ page }) => {
  await page.clock.setFixedTime(new Date(DEPARTURE));
  const events = [];
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/api/event', (route) => { events.push(route.request().postData()); return route.fulfill({ status: 204 }); });
  await page.route('**/data/runs/latest.json', (route) => route.fulfill({ json: null }));
  await page.route('**/data/**', async (route) => {
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(route.request().method())) await route.fulfill({ status: 403 });
    else await route.continue();
  });
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
      name: 'Scratch check file', departureLocal: toLocalDateTimeValue(departure), speeds: { slow: 4, nominal: 5, fast: 6 } });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, { engineUrl, departure: DEPARTURE });
  await expect(page.locator('.passage-marker')).toHaveCount(2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
  const band = page.getByTestId('decision-band');
  await expect(band).toBeVisible();
  const { id, source } = await page.evaluate(async () => {
    const app = (await import('/src/stores/appStore.js')).useApp.getState();
    return { id: app.snapshotId, source: app.snapshotSource };
  });
  expect(source).toBe('local');
  expect(id).toMatch(/^snapshot_v2_[0-9a-f]{16}$/);

  const save = band.getByRole('button', { name: 'Save a copy to a file' });
  await expect(save).toBeVisible();
  await expect(band.getByRole('status')).toHaveText('');
  const downloading = page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  await expect(band.getByRole('status')).toHaveText('Copy made. Your browser saves it with its downloads: one file with the route, the departure time, your limits, the boat reference and the forecast data this check used. Nothing is sent anywhere.');
  await expect(save).toBeFocused();
  expect(download.suggestedFilename()).toBe(`passage-check-2026-07-20-${id.slice('snapshot_v2_'.length)}.json.gz`);
  const document = JSON.parse(gunzipSync(readFileSync(await download.path())).toString('utf8'));
  expect(Object.keys(document)).toEqual(['format', 'format_version', 'exported_at', 'exported_by', 'checks']);
  expect(document).toMatchObject({ format: 'passage-checks', format_version: 1, exported_by: expect.stringMatching(/^Passage engine /) });
  expect(document.checks.map((check) => check.snapshot_id)).toEqual([id]);
  const { files } = document.checks[0];
  // the files are the texts this browser stored, and the decision inputs hash to the id
  const verified = await page.evaluate(async ({ id, files, engineUrl }) => {
    const { contentHash } = await import(engineUrl);
    const { localSnapshots } = await import('/src/lib/localSnapshots.js');
    const stored = {};
    for (const name of Object.keys(files)) stored[name] = await localSnapshots.read(id, name);
    return {
      same: Object.keys(files).every((name) => stored[name] === files[name]),
      hash: contentHash(JSON.parse(files['decision-inputs.json'])),
      manifest: JSON.parse(files['snapshot.json']),
    };
  }, { id, files, engineUrl });
  expect(verified.same).toBe(true);
  expect(`snapshot_v2_${verified.hash}`).toBe(id);
  expect(verified.manifest).toMatchObject({ snapshot_id: id, decision_hash: verified.hash });
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['snapshot.json', 'decision-inputs.json', 'findings.json', 'briefing.json', 'route.json']));
  // no analytics event for an export
  expect(events.filter((body) => /check_file|export|copy/i.test(body ?? ''))).toEqual([]);
});
