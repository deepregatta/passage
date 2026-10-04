import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';
import { GRIB_COPY } from '../src/metadata.js';

const origin = 'https://passage.deepregatta.com';
const live = process.env.PASSAGE_E2E_MODE === 'live';
const verification = 'passage-grib-20261004';
const area = '50.6,50.8,-1.6,-1.3';
const utm = { utm_source: 'bluesky', utm_medium: 'social', utm_campaign: 'water-remembers-2026q4', utm_content: 'grib-qa' };
const cycle = '2026-10-04T00:00:00Z';
const transport = buildFixtureRun([{
  layer: 'weather', model: 'gfs_0p25', cycle, resolution_deg: 0.25,
  time_axes: { hourly: { base: cycle, offsets_h: Array.from({ length: 97 }, (_, i) => i) } },
  variables: ['wind_u_kt', 'wind_v_kt'].map((name) => ({ name, axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 8 })),
  tiles: [[50, -10]],
}], '2026-10-04T06:00:00Z');

async function instrument(page, baseURL) {
  const events = [];
  const receipts = [];
  page.on('response', (response) => {
    if (response.url() === 'https://oscar.deepregatta.com/api/event') {
      const payload = response.request().postDataJSON();
      receipts.push({ event: payload.event, target: payload.props.target, status: response.status() });
    }
  });
  if (live) {
    page.on('request', (request) => {
      if (request.url() === 'https://oscar.deepregatta.com/api/event') events.push(request.postDataJSON());
    });
    return { events, receipts };
  }
  await page.clock.setFixedTime(new Date('2026-10-04T06:00:00Z'));
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.route('https://oscar.deepregatta.com/api/event', async (route) => {
    events.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': origin }, json: { ok: true } });
  });
  await page.route('https://forecast.deepregatta.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'Access-Control-Allow-Origin': origin };
    if (path === '/latest.json') return route.fulfill({ json: transport.latest, headers });
    const key = path.replace(/^\/forecast-runs\//, '');
    if (key.endsWith('/manifest.json')) {
      const manifest = transport.manifests.get(key.slice(0, -'/manifest.json'.length));
      if (manifest) return route.fulfill({ json: manifest, headers });
    }
    const tile = transport.tiles.get(key);
    return tile ? route.fulfill({ body: Buffer.from(tile), contentType: 'application/octet-stream', headers })
      : route.fulfill({ status: 404, headers });
  });
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
  return { events, receipts };
}

for (const [path, language, hash] of [['/', 'en', true], ['/fr/', 'fr', true], ['/grib', 'en', false], ['/fr/grib', 'fr', false]]) {
  test(`production build ${path}${hash ? '#plan/grib' : ''}: saved file, next steps and session attribution`, async ({ page, baseURL }, testInfo) => {
    const { events, receipts } = await instrument(page, baseURL);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const query = new URLSearchParams({ ...utm, dr_traffic: 'qa', dr_verification: verification, ...(hash ? {} : { area }) });
    await page.goto(`${origin}${path}?${query}${hash ? `#plan/grib?area=${area}` : ''}`);
    await expect(page).toHaveTitle(GRIB_COPY[language].title);
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(4);
    const tuple = await page.evaluate(() => sessionStorage.getItem('dr.utm.session'));
    expect(JSON.parse(tuple)).toEqual(utm);
    const session = await page.evaluate(() => sessionStorage.getItem('dr.sid'));
    await page.reload();
    await expect(page).toHaveTitle(GRIB_COPY[language].title);
    expect(await page.evaluate(() => sessionStorage.getItem('dr.sid'))).toBe(session);
    const plan = page.getByRole('button', { name: language === 'fr' ? 'Planifier une traversée dans cette zone' : 'Plan a passage in this area' });
    await expect(plan).toHaveCount(0);
    const downloadButton = page.getByRole('button', { name: language === 'fr' ? 'Télécharger le vent' : 'Download wind' });
    await expect(downloadButton).toBeEnabled();
    const pending = page.waitForEvent('download');
    await downloadButton.click();
    const download = await pending;
    await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 4).toString()).toBe('GRIB');
    await expect(plan).toBeVisible();
    const replay = page.getByRole('link', { name: /(?:Replay a race sailed here|Revoir une course disputée ici).*Rolex Fastnet 2025/ });
    await expect(replay).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('grib-next-steps.png'), fullPage: true });
    const destination = new URL(await replay.getAttribute('href'));
    expect(destination.searchParams.get('race')).toBe('fastnet2025');
    expect(destination.searchParams.get('lang')).toBe(language);
    for (const [key, value] of Object.entries(utm)) expect(destination.searchParams.get(key)).toBe(value);
    expect(destination.searchParams.get('dr_traffic')).toBe('qa');
    expect(destination.searchParams.has('area')).toBe(false);
    // Replay opens separately, preserving this download page and its receipts.
    if (!live) await page.context().route('https://oscar.deepregatta.com/?**', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    const pendingReplay = page.context().waitForEvent('page');
    await replay.click();
    const replayPage = await pendingReplay;
    await expect.poll(() => events.some((event) => event.event === 'grib_next_step' && event.props.target === 'fastnet2025')).toBe(true);
    if (live) {
      await expect(replayPage).toHaveURL(destination.href);
      await expect(replayPage.getByRole('button', { name: 'Rolex Fastnet 2025', exact: true })).toBeVisible();
    }
    await replayPage.close();
    await plan.click();
    await expect(page.getByRole('heading', { name: language === 'fr' ? 'Planifier une traversée' : 'Plan a passage', exact: true })).toBeVisible();
    await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1);
    await expect(page.locator('.leaflet-container')).toBeInViewport();
    expect(await page.evaluate(() => sessionStorage.getItem('dr.utm.session'))).toBe(tuple);
    await expect.poll(() => events.filter((event) => event.event === 'grib_next_step').length).toBe(2);
    for (const event of events.filter((row) => ['grib_export', 'grib_next_step'].includes(row.event))) {
      expect(event.session_id).toBe(session);
      expect(event.props).toMatchObject({ ...utm, event_contract: '2', traffic_class: 'qa', attribution_kind: 'session', verification_run: verification });
      if (event.event === 'grib_next_step') expect(Object.keys(event.props).sort()).toEqual([
        ...Object.keys(utm), 'target', 'product', 'event_contract', 'measurement_build', 'traffic_class', 'attribution_kind', 'verification_run',
      ].sort());
    }
    await expect.poll(() => receipts.filter((row) => row.event === 'grib_next_step').length).toBe(2);
    expect(receipts.filter((row) => ['grib_export', 'grib_next_step'].includes(row.event)).every((row) => row.status === 200)).toBe(true);
    await testInfo.attach('attribution', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      mode: live ? 'live' : 'build', path, language, sessionPreserved: true,
      events: events.filter((row) => ['grib_export', 'grib_next_step'].includes(row.event)).map(({ event, props }) => ({ event, props })), receipts,
    }, null, 2)) });
    expect(errors).toEqual([]);
  });
}

test('packaged EN/FR HTML and sitemap expose the GRIB canonicals before hydration', async ({ request, baseURL }) => {
  for (const [path, language] of [['/grib', 'en'], ['/fr/grib', 'fr']]) {
    const response = await request.get(`${baseURL}${path}?dr_traffic=qa`);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain(`<title>${GRIB_COPY[language].title}</title>`);
    expect(html).toContain(`<link rel="canonical" href="${origin}${path}"`);
    expect(html).toContain(`hreflang="en" href="${origin}/grib"`);
    expect(html).toContain(`hreflang="fr" href="${origin}/fr/grib"`);
  }
  const sitemap = await (await request.get(`${baseURL}/sitemap.xml?dr_traffic=qa`)).text();
  expect(sitemap).toContain(`<loc>${origin}/grib</loc>`);
  expect(sitemap).toContain(`<loc>${origin}/fr/grib</loc>`);
});
