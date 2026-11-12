// Main-thread blocking of the planner's Compute and computed departure scan, in a mobile
// viewport under Chrome DevTools CPU throttling. A measurement, not a test: it asserts only
// that each run finished. See docs/maintenance/2026-11-12-scan-responsiveness.md for the
// method, what it does not measure, and how to repeat it on a phone.
//
// Prepare once:   npm run perf:prepare
// Run:            npm run perf:browser            (output/perf/browser.json, a table on the console)
//
// Environment:    PERF_PASSAGES  comma list of passage ids       (default coastal-20nm,channel-63nm,biscay-321nm)
//                 PERF_RATES     CPU throttle factors            (default 1,4,6)
//                 PERF_RUNS      runs per case                   (default 3 at 1x, 2 at 4x and 6x)
//                 PERF_VARIANTS  tiles, prepared-covering, prepared-runs-out, prepared-small
//                                (default tiles; the prepared ones apply to channel-63nm only)
//                 PERF_REFINE    1 to also time the comparison's refinement (D2) after the scan (default off)
import { expect, test, devices } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const outDir = path.resolve(import.meta.dirname, '../../../output/perf');
const probeFile = path.resolve(import.meta.dirname, 'probe.js');
const meta = JSON.parse(readFileSync(path.join(outDir, 'fixtures/meta.json'), 'utf8'));
const csv = (value, fallback) => (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const passages = csv(process.env.PERF_PASSAGES, 'coastal-20nm,channel-63nm,biscay-321nm').map((id) => {
  const found = meta.passages.find((p) => p.id === id);
  if (!found) throw new Error(`unknown passage ${id}`);
  return found;
});
const rates = csv(process.env.PERF_RATES, '1,4,6').map(Number);
const variants = csv(process.env.PERF_VARIANTS, 'tiles');
const refine = process.env.PERF_REFINE === '1';
const runsFor = (rate) => Number(process.env.PERF_RUNS ?? (rate === 1 ? 3 : 2));

const allRuns = [];
const environment = {};
test.afterAll(() => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'browser.json'), JSON.stringify({ generatedAt: new Date().toISOString(), environment, rates, variants, runs: allRuns }, null, 2));
  console.log(`\nwrote ${path.join(outDir, 'browser.json')}`);
});

for (const passage of passages) {
  for (const variant of variants) {
    if (variant !== 'tiles' && passage.id !== 'channel-63nm') continue;
    for (const rate of rates) {
      test(`${passage.id} ${variant} at ${rate}x`, async ({ browser }) => {
        for (let run = 1; run <= runsFor(rate); run++) {
          // A fresh browser context per run: empty tile cache, nothing decoded, as a first visit.
          environment.chromium = browser.version();
          environment.cpu = `${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} threads)`;
          environment.platform = `${os.platform()} ${os.release()}`;
          const context = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'Europe/Paris' });
          await context.clock.setFixedTime(new Date(meta.nowIso));
          await context.addInitScript({ path: probeFile });
          await context.addInitScript(({ meta, id }) => window.__perfSeed(meta, id), { meta, id: passage.id });
          await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
          await context.route('**/api/event', (route) => route.fulfill({ status: 204 }));
          if (variant.startsWith('prepared-')) {
            const grid = meta.prepared[variant.slice('prepared-'.length)];
            await context.route('**/forecast/prepared/latest.json', (route) => route.fulfill({ json: { run_id: grid.run_id, artifacts: { current_grid: grid.artifact } } }));
          }
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto('/#plan');
          const compute = page.getByRole('button', { name: 'Compute route', exact: true });
          await expect(compute).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(1500); // let the page settle: ports, map tiles aborted, first paints

          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          const viewport = page.viewportSize();
          const padX = viewport.width - 28;
          const padY = viewport.height - 28;
          const tapLoop = (state) => (async () => {
            while (!state.stop) {
              try { await page.touchscreen.tap(padX, padY); } catch { /* page busy or closing */ }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          })();

          const record = { passage: passage.id, label: passage.label, variant, rate, run, errors };
          const act = async (key, locator, needle) => {
            await page.evaluate(({ key, needle }) => window.__perfArm(key, needle), { key, needle });
            const state = { stop: false };
            const loop = tapLoop(state);
            await locator.click();
            await page.waitForFunction((key) => window.__perf.resultAt[key]?.paint != null || window.__perf.alert, key, { timeout: 35 * 60_000, polling: 250 });
            state.stop = true;
            await loop;
            await page.waitForTimeout(600); // let queued taps and the paint settle
            const failure = await page.evaluate(() => window.__perf.alert);
            record[key] = await page.evaluate((key) => window.__perfSummary(key), key);
            if (!record[key]) throw new Error(`${key} failed: ${failure}`);
          };
          // an idle tap first: the baseline for input delay on this device and throttle
          await page.touchscreen.tap(padX, padY);
          await page.waitForTimeout(300);
          record.idleTapDelayMs = (await page.evaluate(() => window.__perf.events.filter(([name]) => name === 'pointerdown').length)) === 0 ? '<16' : 'slow';

          await act('compute', compute, 'Weather-routed');
          record.computeCaption = (await page.locator('p:has-text("Weather-routed")').first().textContent())?.replace(/\s+/g, ' ').trim();
          await act('scan', page.getByRole('button', { name: 'Compare departure times (next 5 days)' }), 'Departure comparison ready');
          record.scanCandidatesShown = await page.getByRole('region', { name: 'Departure comparison' }).locator('button[title]').count();
          if (refine) {
            await act('refine', page.getByRole('button', { name: 'Refine around the least-exposure times' }), 'Refined:');
            record.refineCandidatesShown = await page.getByRole('region', { name: 'Departure comparison' }).locator('button[title]').count();
            console.log(`  refine: ${record.refine.totalMs} ms (longest block ${record.refine.longTasks.longestMs}, taps max delay ${record.refine.taps.maxDelayMs} ms, frames ${record.refine.frames}), ${record.refineCandidatesShown - record.scanCandidatesShown} times added`);
          }
          allRuns.push(record);
          console.log(`${passage.id} ${variant} ${rate}x run ${run}: Compute ${record.compute.totalMs} ms (longest block ${record.compute.longTasks.longestMs}), Scan ${record.scan.totalMs} ms (longest block ${record.scan.longTasks.longestMs}, taps max delay ${record.scan.taps.maxDelayMs} ms, frames ${record.scan.frames})`);
          expect(errors, 'page errors').toEqual([]);
          await context.close();
        }
      });
    }
  }
}
