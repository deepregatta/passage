// The departure comparison in its Web Worker, on real PFT1 tiles: the same
// result as the page running it itself, a count that advances, and a Stop that
// ends the Worker. The tiles, the invented boat and the clock are the
// synthetic ones of the responsiveness measurement (engine/scripts/perf),
// written to a scratch folder; the coastline is the real one the dev server serves.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
let fixtures;
let meta;

// eslint-disable-next-line no-empty-pattern -- Playwright hooks take their fixtures as a destructured first argument
test.beforeAll(({}, testInfo) => {
  // one folder per project, so that two projects never write the same files
  fixtures = path.join(repo, `output/e2e-scan-worker-fixtures-${testInfo.project.name}`);
  execFileSync('npx', ['tsx', 'scripts/perf/prepare-fixtures.ts', fixtures], { cwd: path.join(repo, 'engine'), stdio: 'pipe' });
  meta = JSON.parse(readFileSync(path.join(fixtures, 'meta.json'), 'utf8'));
});

/** A planner on the synthetic forecast, with the coastal passage drawn for Compute; `inPage` keeps the scan on the page's thread. */
async function openPlanner(page, { inPage = false, passageId = 'coastal-20nm' } = {}) {
  await page.clock.setFixedTime(new Date(meta.nowIso));
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/api/event', (route) => route.fulfill({ status: 204 }));
  await page.route('**/data/runs/latest.json', (route) => route.fulfill({ json: null }));
  await page.route('**/data/forecast/**', (route) => {
    const relative = new URL(route.request().url()).pathname.replace(/^\/data\//, '');
    route.fulfill({ body: readFileSync(path.join(fixtures, relative)) });
  });
  // The committed coastline, as the production host serves it (the dev server labels .gz files as gzip-encoded).
  await page.route('**/data/land/*', (route) => route.fulfill({
    body: readFileSync(path.join(repo, 'viewer/public', new URL(route.request().url()).pathname)), contentType: 'application/octet-stream' }));
  await page.route(`**/api/polars/${meta.polarId}`, (route) => route.fulfill({ body: readFileSync(path.join(fixtures, 'api/polars', meta.polarId)), contentType: 'application/json' }));
  await page.addInitScript(({ meta, inPage, passageId }) => {
    // Count the Workers the page starts and ends, without changing them.
    window.__scanWorkers = { started: 0, terminated: 0, scans: 0, refines: 0 };
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        window.__scanWorkers.started += 1;
      }
      postMessage(message, ...rest) {
        if (message?.type === 'scan') window.__scanWorkers.scans += 1;
        if (message?.type === 'refine') window.__scanWorkers.refines += 1;
        return super.postMessage(message, ...rest);
      }
      terminate() {
        window.__scanWorkers.terminated += 1;
        return super.terminate();
      }
    };
    if (inPage) window.__deepweatherScanInPage = true;
    // Every status text under the action buttons, as the page shows them.
    window.__statusTexts = [];
    new MutationObserver(() => {
      for (const p of document.querySelectorAll('p[aria-live="polite"]')) {
        const text = p.textContent.trim();
        if (text && window.__statusTexts.at(-1) !== text) window.__statusTexts.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
    const passage = meta.passages.find((p) => p.id === passageId);
    const d = new Date(meta.departureIso);
    const pad = (n) => String(n).padStart(2, '0');
    localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 3, state: {
      mode: 'compute', polarId: meta.polarId, polarLabel: meta.polarLabel, polarPercent: 100, name: 'Worker passage', nameAuto: false,
      endpoints: [{ lat: passage.start.lat, lng: passage.start.lon }, { lat: passage.finish.lat, lng: passage.finish.lon }],
      departureLocal: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      waypoints: [], computed: null,
    } }));
  }, { meta, inPage, passageId });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#plan');
  await page.getByRole('button', { name: 'Compute route', exact: true }).click();
  await expect(page.getByText('Weather-routed', { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  return errors;
}

const scanButton = (page) => page.getByRole('button', { name: 'Compare departure times (next 5 days)' });
const storedScan = (page) => page.evaluate(async () => {
  const { usePlanner } = await import('/src/stores/plannerStore.js');
  // Only wall-clock stamps may differ: a route's computed_at, a tile read's fetched_at, and the tile current
  // record's content_digest, which hashes the current grid with its read time. This page's clock is fixed and a
  // Worker's is not; with the Worker's clock fixed too, the whole comparison was found identical.
  const scan = usePlanner.getState().scan;
  return scan && JSON.parse(JSON.stringify(scan, function strip(key, value) {
    if (key === 'computed_at' || key === 'fetched_at' || key === 'scanId') return undefined;
    if (key === 'content_digest' && this.layer === 'currents' && this.current_source === 'tiles') return undefined;
    return value;
  }));
});

test.describe('departure comparison in a Worker', () => {
  test.skip(({ isMobile }) => isMobile, 'one browser is enough for the thread boundary');
  test.setTimeout(180_000);

  test('gives the same comparison as the page running it, and shows its counts', async ({ page, browser }) => {
    const errors = await openPlanner(page);
    await scanButton(page).click();
    await expect(page.getByText('Departure comparison ready.', { exact: false })).toBeVisible({ timeout: 120_000 });
    const viaWorker = await storedScan(page);
    const workers = await page.evaluate(() => window.__scanWorkers);
    expect(workers).toMatchObject({ started: 1, scans: 1, terminated: 0 });
    const texts = await page.evaluate(() => window.__statusTexts);
    expect(texts.some((t) => /^Routing departures \d+\/21…$/.test(t))).toBe(true);
    expect(texts.some((t) => /^Comparing departure times \d+\/21…$/.test(t))).toBe(true);
    expect(viaWorker.candidates).toHaveLength(21);
    expect(errors).toEqual([]);

    const other = await browser.newContext({ timezoneId: 'Europe/Paris' });
    const inPagePage = await other.newPage();
    await openPlanner(inPagePage, { inPage: true });
    await scanButton(inPagePage).click();
    await expect(inPagePage.getByText('Departure comparison ready.', { exact: false })).toBeVisible({ timeout: 120_000 });
    expect(await inPagePage.evaluate(() => window.__scanWorkers.scans)).toBe(0);
    expect(viaWorker).toEqual(await storedScan(inPagePage));
    await other.close();
  });

  test('refines once in the same Worker, with the same result as the page refining it itself', async ({ page, browser }) => {
    const refineButton = (p) => p.getByRole('button', { name: 'Refine around the least-exposure times' });
    const refineOnce = async (p) => {
      await scanButton(p).click();
      await expect(p.getByText('Departure comparison ready.', { exact: false })).toBeVisible({ timeout: 120_000 });
      await expect(refineButton(p)).toBeEnabled();
      const adds = Number(/^Adds (\d+) departure/.exec(await p.getByText(/^Adds \d+ departure times?,/).textContent())[1]);
      await refineButton(p).click();
      await expect(p.getByText(/^Refined: \d+ more departure/)).toBeVisible({ timeout: 120_000 });
      return adds;
    };
    const errors = await openPlanner(page);
    const adds = await refineOnce(page);
    expect(adds).toBeGreaterThan(0);
    // the same Worker, still running, with one comparison and one refinement
    expect(await page.evaluate(() => window.__scanWorkers)).toMatchObject({ started: 1, scans: 1, refines: 1, terminated: 0 });
    const texts = await page.evaluate(() => window.__statusTexts);
    const counted = new RegExp(`^Comparing departure times \\d+/${adds}…$`);
    expect(texts.some((t) => counted.test(t))).toBe(true);
    const viaWorker = await storedScan(page);
    expect(viaWorker.refined.departures).toHaveLength(adds);
    expect(viaWorker.requested).toBe(21 + adds);
    expect(new Set(viaWorker.candidates.map((c) => c.departure_utc)).size).toBe(viaWorker.candidates.length);
    await expect(page.getByTestId('refined-row').first()).toBeVisible();
    await expect(refineButton(page)).toHaveCount(0); // once per comparison
    expect(errors).toEqual([]);

    const other = await browser.newContext({ timezoneId: 'Europe/Paris' });
    const inPagePage = await other.newPage();
    await openPlanner(inPagePage, { inPage: true });
    expect(await refineOnce(inPagePage)).toBe(adds);
    expect(await inPagePage.evaluate(() => window.__scanWorkers.refines)).toBe(0);
    expect(viaWorker).toEqual(await storedScan(inPagePage));
    await other.close();
  });

  test('stops at once on request and can compare again', async ({ page }) => {
    // The longest passage: its comparison takes seconds, time enough to stop it.
    const errors = await openPlanner(page, { passageId: 'biscay-321nm' });
    await scanButton(page).click();
    await expect(page.getByRole('button', { name: 'Stop comparing' })).toBeVisible();
    await page.waitForFunction(() => window.__scanWorkers.scans === 1); // the Worker has the comparison
    await page.getByRole('button', { name: 'Stop comparing' }).click();
    await expect(page.getByText('Comparison stopped.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__scanWorkers)).toMatchObject({ started: 1, terminated: 1 });
    await expect(page.getByRole('button', { name: 'Stop comparing' })).toHaveCount(0);
    expect((await storedScan(page))).toBeNull();
    await scanButton(page).click();
    await expect(page.getByText('Departure comparison ready.', { exact: false })).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => window.__scanWorkers)).toMatchObject({ started: 2, scans: 2 });
    expect(errors).toEqual([]);
  });
});
