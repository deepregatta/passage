import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test.use({ timezoneId: 'Europe/Paris' });

test('briefing checkpoint', async ({ page }) => {
  // Keep model-age labels aligned with the reference fixture. Otherwise this
  // full-page baseline changes every day and wraps differently on mobile.
  await page.clock.setFixedTime(new Date('2026-07-19T18:00:00Z'));
  // External tile availability/labels are not a UI baseline. Keep the route
  // overlays, map controls and attribution, but omit live raster tiles.
  await page.route(/^https:\/\/(basemaps\.cartocdn\.com|tiles\.openseamap\.org)\//, (route) => route.abort());
  await openAuditedSnapshot(page);
  await expect(page).toHaveScreenshot('briefing.png', { fullPage: true });
});

test('emulated warning uses a neutral test-pattern band', async ({ page }) => {
  await openAuditedSnapshot(page);
  await expect(page.getByText('EMULATED WARNING SCENARIO')).toBeVisible();
});

test('mobile shell has no permanent rail or horizontal overflow', async ({ page }) => {
  await openAuditedSnapshot(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await expect(page.locator('nav.w-44')).toHaveCount(0);
});

test('playback scrub synchronizes the story phase and evidence focus', async ({ page }) => {
  await openAuditedSnapshot(page);
  const ruler = page.getByRole('slider', { name: 'Passage time' });
  await ruler.evaluate((element) => {
    // React tracks the value property: plain `element.value = …` updates the
    // tracker too and the dispatched event is ignored — use the native setter
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, '1');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByText(/while you are out there/i)).toBeVisible();
  await expect(page.getByText(/system L1 · boat L/i)).toBeVisible();
});

test('example decision band prioritizes bulletin inspection before charts', async ({ page }) => {
  await openAuditedSnapshot(page);
  const band = page.getByTestId('decision-band');
  await expect(band.getByRole('heading', { name: /official warning active/i })).toBeVisible();
  await expect(band.getByText('EMULATED WARNING SCENARIO')).toBeVisible();
  await expect(band.getByRole('button', { name: /find a departure that fits/i })).toHaveCount(0);
  const inspectBulletin = band.getByRole('button', { name: 'Inspect example bulletin', exact: true });
  await expect(inspectBulletin).toBeVisible();
  const bandBox = await band.boundingBox();
  const heroBox = await page.getByRole('button', { name: 'Full screen' }).boundingBox();
  expect(bandBox.y).toBeLessThan(heroBox.y);
  await inspectBulletin.click();
  const bulletin = page.getByRole('dialog');
  await expect(bulletin.getByText('Source bulletin', { exact: true })).toBeVisible();
  await bulletin.getByRole('button', { name: 'Close bulletin' }).click();
  await expect(bulletin).toHaveCount(0);
});
