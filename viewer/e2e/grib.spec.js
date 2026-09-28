import { expect, test } from '@playwright/test';

test('draws a GRIB box on the chart by dragging or two clicks, and keeps it in the address', async ({ page }) => {
  // The box is drawn on the real Leaflet map; basemap tiles are irrelevant here.
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
  await page.goto('/#plan/grib');
  await expect(page.getByRole('heading', { name: 'Download GRIB files' })).toBeVisible();
  const region = page.getByRole('region', { name: 'GRIB download' });
  await expect(region.getByText('Draw your area first.')).toBeVisible();

  const map = page.locator('.leaflet-container');
  await map.waitFor();
  const frame = await map.boundingBox();
  const at = (x, y) => [frame.x + frame.width * x, frame.y + frame.height * y];
  const areaText = region.getByText(/°N–.*°N, .*°[WE]–.*°[WE]/);

  // drag across the chart
  await page.getByRole('button', { name: 'Draw a box' }).click();
  await expect(page.getByText('Drag across the chart to draw your area.').first()).toBeVisible();
  await page.mouse.move(...at(0.3, 0.3));
  await page.mouse.down();
  await page.mouse.move(...at(0.6, 0.7), { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Redraw the box' })).toBeVisible();
  await expect(areaText).toBeVisible();
  await expect(page).toHaveURL(/#plan\/grib\?area=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/);
  const dragged = await areaText.textContent();

  // Escape leaves draw mode without touching the box
  await page.getByRole('button', { name: 'Redraw the box' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Redraw the box' })).toBeVisible();
  await expect(areaText).toHaveText(dragged);

  // two clicks, on opposite corners, draw a box too
  await page.getByRole('button', { name: 'Redraw the box' }).click();
  await page.mouse.click(...at(0.2, 0.4));
  await page.mouse.click(...at(0.45, 0.8));
  await expect(page.getByRole('button', { name: 'Redraw the box' })).toBeVisible();
  await expect(areaText).not.toHaveText(dragged);
  const clicked = await areaText.textContent();

  // the box is remembered, and the address can be bookmarked
  const url = page.url();
  await page.reload();
  await expect(areaText).toHaveText(clicked);
  await page.goto('/#plan/planner');
  await page.goto(url);
  await expect(areaText).toHaveText(clicked);
});

test('the planner opens the GRIB page from its Plan tab and its Passage panel', async ({ page }) => {
  await page.goto('/#plan/planner');
  await page.getByRole('navigation', { name: 'Plan views' }).getByRole('button', { name: 'GRIB files' }).click();
  await expect(page).toHaveURL(/#plan\/grib/);
  await expect(page.getByRole('heading', { name: 'Download GRIB files' })).toBeVisible();
  await page.goto('/#plan/planner');
  await page.getByRole('button', { name: 'Download GRIBs…' }).click();
  await expect(page.getByRole('heading', { name: 'Download GRIB files' })).toBeVisible();
});
