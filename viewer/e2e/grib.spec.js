import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';
import { readGrib2 } from '../../engine/test/helpers/grib2Reader.ts';

test('Full forecast downloads each selected model through its own last step', async ({ page }, testInfo) => {
  const cycle = '2026-07-20T00:00Z';
  const transport = buildFixtureRun([
    ['weather', 'gfs_0p25', 96], ['weather-ecmwf', 'ecmwf_ifs_0p25', 144],
  ].map(([layer, model, horizon]) => ({
    layer, model, cycle, resolution_deg: 0.25,
    time_axes: { hourly: { base: cycle, offsets_h: Array.from({ length: horizon + 1 }, (_, i) => i) } },
    variables: ['wind_u_kt', 'wind_v_kt'].map(name => ({
      name, axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 8,
    })),
    tiles: [[50, -10]],
  })));
  await page.clock.setFixedTime(new Date('2026-07-20T06:30:00Z'));
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, route => route.abort());
  await page.route('**/data/forecast/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/data/forecast/', '');
    if (path === 'latest.json') return route.fulfill({ json: transport.latest });
    const key = path.replace(/^forecast-runs\//, '');
    const manifest = key.endsWith('/manifest.json') && transport.manifests.get(key.slice(0, -'/manifest.json'.length));
    if (manifest) return route.fulfill({ json: manifest });
    const tile = transport.tiles.get(key);
    return tile ? route.fulfill({ body: Buffer.from(tile), contentType: 'application/octet-stream' })
      : route.fulfill({ status: 404 });
  });
  await page.goto('/#plan/grib?area=50.6,50.8,-1.6,-1.3');
  const region = page.getByRole('region', { name: 'GRIB download' });
  await expect(region.getByRole('button', { name: 'Download wind' })).toBeEnabled();
  await region.getByRole('combobox', { name: 'Period' }).selectOption('full');
  await expect(region.getByText('Each model runs from now to the end of its available forecast.')).toBeVisible();
  for (const [name, horizon] of [['GFS', 96], ['ECMWF', 144]]) {
    await region.getByRole('radio', { name: new RegExp(`^${name}`) }).click();
    const pending = page.waitForEvent('download');
    await region.getByRole('button', { name: 'Download wind' }).click();
    const download = await pending;
    await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
    const messages = readGrib2(new Uint8Array(await readFile(await download.path())));
    const steps = [...new Set(messages.map(message => message.product.forecastTime))];
    expect(steps).toEqual(Array.from({ length: horizon - 6 + 1 }, (_, i) => i + 6));
    expect(new Set(messages.map(message => message.refTime))).toEqual(new Set(['2026-07-20T00:00:00Z']));
  }
  await page.screenshot({ path: testInfo.outputPath('full-forecast.png'), fullPage: true });
});

async function openGribPage(page) {
  // The box is drawn on the real Leaflet map; basemap tiles are irrelevant here.
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
  await page.goto('/#plan/grib');
  await expect(page.getByRole('heading', { name: 'Download GRIB files' })).toBeVisible();
  const map = page.locator('.leaflet-container');
  await map.waitFor();
  const frame = await map.boundingBox();
  const region = page.getByRole('region', { name: 'GRIB download' });
  return {
    region,
    at: (x, y) => [frame.x + frame.width * x, frame.y + frame.height * y],
    areaText: region.getByText(/°N–.*°N, .*°[WE]–.*°[WE]/),
  };
}

test('draws a GRIB box by dragging, resizes it from a corner, and keeps it in the address', async ({ page }) => {
  const { region, at, areaText } = await openGribPage(page);
  await expect(region.getByText('Draw your area first.')).toBeVisible();

  // Escape leaves draw mode without drawing anything
  await page.getByRole('button', { name: 'Draw a box' }).click();
  await expect(page.getByText('Drag across the chart to draw your area.').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Draw a box' })).toBeVisible();
  await expect(areaText).toHaveCount(0);

  // drag across the chart
  await page.getByRole('button', { name: 'Draw a box' }).click();
  await page.mouse.move(...at(0.3, 0.3));
  await page.mouse.down();
  await page.mouse.move(...at(0.6, 0.7), { steps: 5 });
  await page.mouse.up();
  await expect(areaText).toBeVisible();
  await expect(page).toHaveURL(/#plan\/grib\?area=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/);
  // once there is a box, the corners adjust it: no redraw button
  await expect(page.getByRole('button', { name: /Draw a box|Redraw/ })).toHaveCount(0);
  const drawn = await areaText.textContent();

  // drag the north-west corner up and to the left: the box grows and stays grown
  const handles = page.locator('.leaflet-marker-icon');
  await expect(handles).toHaveCount(4);
  const corner = await handles.first().boundingBox();
  const start = [corner.x + corner.width / 2, corner.y + corner.height / 2];
  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(start[0] - 60, start[1] - 40, { steps: 8 });
  await page.mouse.up();
  await expect(areaText).not.toHaveText(drawn);
  const resized = await areaText.textContent();
  const [north, west] = [/–([\d.]+)°N/, /, ([\d.]+)°W/].map((re) => Number(resized.match(re)?.[1]));
  const [northBefore, westBefore] = [/–([\d.]+)°N/, /, ([\d.]+)°W/].map((re) => Number(drawn.match(re)?.[1]));
  expect(north).toBeGreaterThan(northBefore);
  expect(west).toBeGreaterThan(westBefore);
  // the handles follow the new box
  const moved = await handles.first().boundingBox();
  expect(Math.abs(moved.x - (corner.x - 60))).toBeLessThan(20);

  // the box is remembered, and the address can be bookmarked
  const url = page.url();
  await page.reload();
  await expect(areaText).toHaveText(resized);
  await page.goto('/#plan');
  await page.goto(url);
  await expect(areaText).toHaveText(resized);
});

test('draws a GRIB box with two clicks on opposite corners', async ({ page }) => {
  const { at, areaText } = await openGribPage(page);
  await page.getByRole('button', { name: 'Draw a box' }).click();
  await page.mouse.click(...at(0.2, 0.4));
  await page.mouse.click(...at(0.45, 0.8));
  await expect(areaText).toBeVisible();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(4);
});

test('the planner map opens the GRIB page, and Plan leads back', async ({ page }) => {
  await page.goto('/#plan');
  await page.getByRole('button', { name: 'Export GRIB for this area' }).click();
  await expect(page).toHaveURL(/#plan\/grib/);
  await expect(page.getByRole('heading', { name: 'Download GRIB files' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
  await expect(page).toHaveURL(/#plan$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
});
