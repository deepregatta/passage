import { expect, test } from '@playwright/test';
import path from 'node:path';

const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;
const DEPARTURE = '2026-07-20T00:00:00Z';
const grid = (id, extra = {}) => ({ schema_version: 1, kind: 'surface_current', run_id: id,
  generated_at: DEPARTURE, lat0: 39, lon0: 2, dlat: 1, dlon: 1, nlat: 3, nlon: 3,
  time_axis: [DEPARTURE, '2026-07-30T00:00Z'], u_kt: Array(18).fill(0), v_kt: Array(18).fill(0),
  source: { mode: 'synthetic', dataset_id: 'scratch-current' }, ...extra });
async function settleMap(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
}
const findings = page => page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().findings);
async function plan(page) {
  await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
  await settleMap(page);
}

for (const invalid of ['outside', 'expired', 'empty']) {
  test(`Check/Scan pin visible limits, refresh prepared data and report ${invalid} coverage`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(DEPARTURE));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const writes = [];
    await page.route('**/data/**', async request => {
      if (request.request().method() === 'POST') {
        writes.push(request.request().url());
        await request.fulfill({ status: 403 });
      } else await request.continue();
    });
    await page.route(/^https:\/\//, request => request.abort());
    await page.route('**/api/event', request => request.fulfill({ status: 204 }));
    let pointer = 'prepared-invalid';
    let failFirst = true;
    const artifacts = {
      'prepared-invalid': grid('prepared-invalid', invalid === 'outside' ? { lat0: 49, lon0: -5 }
        : invalid === 'expired' ? { time_axis: ['2026-07-18T00:00Z', '2026-07-19T00:00Z'] }
        : { u_kt: Array(18).fill(null) }),
      'prepared-fresh': grid('prepared-fresh'),
    };
    await page.route('**/data/runs/latest.json', async request => {
      if (failFirst) { failFirst = false; await request.fulfill({ status: 503 }); return; }
      await request.fulfill({ json: { run_id: pointer, model: 'scratch', artifacts: { current_grid: `runs/${pointer}/current.json` } } });
    });
    await page.route('**/data/runs/*/current.json', request => request.fulfill({ json: artifacts[request.request().url().split('/').at(-2)] }));
    await page.goto('/#plan');
    await page.evaluate(async ({ engineUrl, tileGrid, departure }) => {
      const engine = await import(engineUrl);
      const { auditStore } = await import('/test/fixtures/routingTiming.js');
      const { forecastStore } = await import('/src/lib/forecastStore.js');
      const fixture = auditStore(engine, tileGrid);
      const readForecast = fixture.getPointForecasts.bind(fixture);
      fixture.getPointForecasts = async (...args) => {
        const result = await readForecast(...args);
        result.forecasts.forEach(forecast => { forecast.gust_kt = forecast.gust_kt.map(() => 25); });
        return result;
      };
      const store = forecastStore();
      window.scratchActionReads = { current: 0, profiles: [] };
      for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getWindGrid']) store[method] = fixture[method].bind(fixture);
      store.getCurrentGrid = async () => { window.scratchActionReads.current++; return tileGrid; };
      store.refresh = async () => [];
      store.lastCheckedMs = () => Date.now();
      const { usePlanner } = await import('/src/stores/plannerStore.js');
      const { toLocalDateTimeValue } = await import('/src/lib/format.js');
      usePlanner.getState().patch({ mode: 'draw', waypoints: [{ lat: 40, lng: 3 }, { lat: 40, lng: 3.1 }],
        speeds: { slow: 4, nominal: 5, fast: 6 }, departureLocal: toLocalDateTimeValue(departure), name: 'Scratch action' });
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'deepweather.profile-draft') throw new DOMException('full', 'QuotaExceededError');
        return nativeSet.call(this, key, value);
      };
    }, { engineUrl, tileGrid: grid('tile-empty', { u_kt: Array(18).fill(null) }), departure: DEPARTURE });
    await page.getByRole('button', { name: testInfo.project.name === 'mobile' ? 'Limits' : 'Edit my limits', exact: true }).click();
    await page.getByLabel('Max gusts').fill('23');
    await expect(page.getByRole('status')).toContainText('could not be saved');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await settleMap(page);
    const check = () => page.getByRole('button', { name: 'Check this passage', exact: true });
    await check().click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    const first = await findings(page);
    const profileRecord = first.evidence.find(item => item.rule_id === 'W-GUST-01');
    expect(profileRecord.limit).toBe(23);
    await page.getByText('Models and coverage', { exact: true }).click();
    const row = page.getByRole('region', { name: 'Recorded coverage' }).locator('li').filter({ hasText: 'tidal currents' });
    await expect(row).toContainText('not assessed');
    // Next action recovers the transient pointer failure, admits by coverage, and
    // still uses exactly one fallback grid when the prepared grid is invalid.
    await plan(page);
    await page.evaluate(async () => {
      const { usePlanner } = await import('/src/stores/plannerStore.js');
      const { toLocalDateTimeValue } = await import('/src/lib/format.js');
      usePlanner.getState().patch({ departureLocal: toLocalDateTimeValue('2026-07-20T06:00:00Z') });
    });
    await check().click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    const second = await findings(page);
    expect(second.inputs.forecast_tiles.find(input => input.layer === 'currents').current_source).toBe('tiles');
    const savedId = second.snapshot_id;
    // New action sees the new prepared artifact; previous saved input records stay fixed.
    pointer = 'prepared-fresh';
    await plan(page);
    await page.getByRole('button', { name: 'Compare departure times (next 5 days)' }).click();
    await expect(page.getByRole('region', { name: 'Departure comparison' })).toBeVisible();
    const scan = await page.evaluate(async () => (await import('/src/stores/plannerStore.js')).usePlanner.getState().scan);
    expect(scan.input_records.find(input => input.layer === 'currents')).toMatchObject({ current_source: 'prepared', run_id: 'prepared-fresh' });
    expect(scan.input_records.find(input => input.layer === 'action').profile_revision).toBe(second.inputs.profile_hash);
    await page.evaluate(async id => (await import('/src/stores/appStore.js')).useApp.getState().openSnapshot(id), savedId);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect((await findings(page)).inputs).toEqual(second.inputs);
    await page.getByText('Models and coverage', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Recorded coverage' }).locator('li').filter({ hasText: 'tidal currents' })).toContainText('not assessed');
    expect(errors).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    await testInfo.attach('action-input-provenance', { body: JSON.stringify({ invalid, first: first.inputs, second: second.inputs, scan: scan.input_records, writes }, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('saved-coverage.png'), fullPage: true });
  });
}
