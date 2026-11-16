import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

// Save all checks to one file and import them elsewhere (2026-11-16, stage 2; a renamed
// passage's name travels with the file since version 3): two real
// Checks in fixture mode, saved in this test's own browser storage, written to one
// version-2 file in two taps, read here (name, header, two lines, trailer) and imported
// into fresh, empty browser contexts: whole, mixed with a damaged line, and offline once
// the page has loaded. No analytics event; the storage block fits 375 px. Demo /data/ is
// only read.
const DEPARTURE = '2026-07-20T00:00:00Z';
const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;

async function prepare(page, events, { clock = true } = {}) {
  // the fixed clock makes the Checks; it also holds back idle callbacks, so a page that only imports goes without it
  if (clock) await page.clock.setFixedTime(new Date(DEPARTURE));
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/api/event', (route) => { events?.push(route.request().postData()); return route.fulfill({ status: 204 }); });
  await page.route('**/data/runs/latest.json', (route) => route.fulfill({ json: null }));
  await page.route('**/data/**', async (route) => {
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(route.request().method())) await route.fulfill({ status: 403 });
    else await route.continue();
  });
}

/** One Check of a drawn route, made by the page itself with the fixture forecast. */
async function check(page, { name, waypoints }) {
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(async ({ engineUrl, departure, name, waypoints }) => {
    const engine = await import(engineUrl);
    const { auditStore } = await import('/test/fixtures/routingTiming.js');
    const fixture = auditStore(engine, undefined);
    const store = (await import('/src/lib/forecastStore.js')).forecastStore();
    for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid']) store[method] = fixture[method].bind(fixture);
    store.refresh = async () => [];
    store.lastCheckedMs = () => Date.now();
    const planner = (await import('/src/stores/plannerStore.js')).usePlanner.getState();
    planner.reset();
    const { toLocalDateTimeValue } = await import('/src/lib/format.js');
    planner.patch({ mode: 'draw', waypoints, name, departureLocal: toLocalDateTimeValue(departure), speeds: { slow: 4, nominal: 5, fast: 6 } });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, { engineUrl, departure: DEPARTURE, name, waypoints });
  await expect(page.locator('.passage-marker')).toHaveCount(waypoints.length);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  return page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().snapshotId);
}

/** A fresh, empty browser, on My passages, with its lists read. */
async function freshPassages(browser, testInfo, options) {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await prepare(page, undefined, options);
  await page.goto('/#passages');
  await expect(page.getByTestId('import-check').getByRole('button', { name: 'Import from a file' })).toBeVisible();
  return { context, page };
}

test('all checks saved to one file import into another browser, whole, mixed and offline', async ({ page, browser }, testInfo) => {
  // two Checks, a save and three fresh browsers
  test.setTimeout(60_000);
  const events = [];
  await prepare(page, events);
  const ids = [
    await check(page, { name: 'Scratch all one', waypoints: [{ lat: 49.5, lng: -3.5 }, { lat: 49.5, lng: -3.2 }] }),
    await check(page, { name: 'Scratch all two', waypoints: [{ lat: 49.6, lng: -3.5 }, { lat: 49.6, lng: -3.1 }] }),
  ];
  expect(new Set(ids).size).toBe(2);
  await page.goto('/#passages');
  // the sailor names one passage
  await page.getByRole('button', { name: 'Rename Scratch all one' }).click();
  await page.getByRole('textbox', { name: 'Passage name' }).fill('Autumn delivery → Plymouth');
  await page.getByRole('textbox', { name: 'Passage name' }).press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Autumn delivery → Plymouth' })).toBeVisible();
  const save = page.getByTestId('save-all-checks');
  await save.getByRole('button', { name: 'Save all checks to a file' }).click();
  await expect(save.getByTestId('save-all-ready')).toHaveText(/^File ready: 2 checks, (less than 1 MB|about \d+ MB)\.$/);
  const downloading = page.waitForEvent('download');
  await save.getByRole('button', { name: 'Save the file' }).click();
  const download = await downloading;
  await expect(save.getByTestId('save-all-saved')).toHaveText('Your browser saves it with its downloads. Nothing is sent anywhere.');
  expect(download.suggestedFilename()).toMatch(/^passage-all-checks-\d{4}-\d{2}-\d{2}-\d{4}Z\.json\.gz$/);
  const file = await download.path();
  const bytes = readFileSync(file);
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  const lines = gunzipSync(bytes).toString('utf8').split('\n');
  expect(lines.pop()).toBe('');
  expect(lines).toHaveLength(5);
  expect(JSON.parse(lines[0])).toMatchObject({ format: 'passage-checks', format_version: 3, exported_by: expect.stringMatching(/^Passage engine /) });
  // the names line: the one name given here
  const names = JSON.parse(lines[1]);
  expect(names.names).toEqual([{ passage_id: expect.any(String), name: 'Autumn delivery → Plymouth' }]);
  expect(lines.slice(2, 4).map((line) => JSON.parse(line).snapshot_id).sort()).toEqual([...ids].sort());
  expect(JSON.parse(lines[4])).toEqual({ end: 'passage-checks', checks: 2 });
  await expect(save.getByTestId('last-checks-file')).toHaveText(/^Last file of all checks: made .+, 2 checks\.$/);

  // a fresh browser: both passages, labelled as imported
  const whole = await freshPassages(browser, testInfo);
  try {
    const control = whole.page.getByTestId('import-check');
    await control.locator('input[type="file"]').setInputFiles(file);
    await expect(control.getByTestId('import-summary')).toContainText('2 checks imported from the file.');
    for (const id of ids) {
      const card = whole.page.locator(`[data-snapshot-id="${id}"]`).locator('xpath=ancestor::article');
      await expect(card.getByTestId('imported-label')).toHaveText(/^Imported from a file, not recomputed here · check made .+$/);
    }
    await expect(control.getByTestId('import-summary')).toContainText('1 passage name was taken from the file.');
    // the name on its card and on its passage page
    await expect(whole.page.getByRole('heading', { level: 2, name: 'Autumn delivery → Plymouth' })).toBeVisible();
    await whole.page.getByRole('button', { name: /^Open Autumn delivery → Plymouth, departing / }).click();
    await expect(whole.page.getByTestId('decision-band')).toContainText('Autumn delivery → Plymouth');
    await whole.page.goto('/#passages');
    await whole.page.evaluate(() => window.scrollTo(0, 0));
    expect(await whole.page.evaluate(() => JSON.parse(localStorage.getItem('deepweather.passage-labels')))).toEqual({ [`local|passage|${names.names[0].passage_id}`]: 'Autumn delivery → Plymouth' });
    // the storage block fits a 375 px screen
    await whole.page.setViewportSize({ width: 375, height: 812 });
    expect(await whole.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const block = await whole.page.getByTestId('storage-block').boundingBox();
    expect(block.x + block.width).toBeLessThanOrEqual(375);
  } finally {
    await whole.context.close();
  }

  // the undo takes back the checks and the name this import gave
  const undone = await freshPassages(browser, testInfo);
  try {
    const control = undone.page.getByTestId('import-check');
    await control.locator('input[type="file"]').setInputFiles(file);
    await expect(undone.page.getByRole('heading', { level: 2, name: 'Autumn delivery → Plymouth' })).toBeVisible();
    await control.getByRole('button', { name: 'Remove the checks this import added' }).click();
    const dialog = undone.page.getByRole('alertdialog');
    await expect(dialog).toContainText('The passage names it took from the file are removed too.');
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(control.getByTestId('import-removed')).toHaveText('2 checks removed.');
    await expect(undone.page.getByRole('heading', { level: 2, name: 'Autumn delivery → Plymouth' })).toHaveCount(0);
    expect(await undone.page.evaluate(() => localStorage.getItem('deepweather.passage-labels'))).toBeNull();
  } finally {
    await undone.context.close();
  }

  // one valid line and one altered: its files no longer give its digest
  const mixedPath = testInfo.outputPath('mixed.json.gz');
  const altered = lines[3].replace(/"files_digest":"([0-9a-f])/, (_match, hex) => `"files_digest":"${hex === '0' ? '1' : '0'}`);
  expect(altered).not.toBe(lines[3]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(mixedPath, gzipSync(`${[lines[0], lines[1], lines[2], altered, lines[4]].join('\n')}\n`));
  const mixed = await freshPassages(browser, testInfo);
  try {
    const control = mixed.page.getByTestId('import-check');
    await control.locator('input[type="file"]').setInputFiles(mixedPath);
    const summary = control.getByTestId('import-summary');
    await expect(summary).toContainText('1 check imported from the file.');
    await expect(summary.getByRole('alert')).toHaveText('1 check was not imported: the file is damaged or has been altered there.');
  } finally {
    await mixed.context.close();
  }

  // offline once the page has loaded and its importer is there
  const offline = await freshPassages(browser, testInfo, { clock: false });
  try {
    // the importer preloads when the page is idle; its own imports (validators, reader) follow it
    await offline.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('checkImportMany')));
    await offline.page.waitForLoadState('networkidle');
    await offline.page.context().setOffline(true);
    const control = offline.page.getByTestId('import-check');
    await control.locator('input[type="file"]').setInputFiles(file);
    await expect(control.getByTestId('import-summary')).toContainText('2 checks imported from the file.');
  } finally {
    await offline.context.close();
  }

  // no analytics event for saving or importing
  expect(events.filter((body) => /check_file|checks_file|export|import|backup/i.test(body ?? ''))).toEqual([]);
});
