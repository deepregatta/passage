import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('briefing checkpoint', async ({ page }) => {
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

test('decision band answers can-I-go before any chart', async ({ page }) => {
  await openAuditedSnapshot(page);
  const band = page.getByTestId('decision-band');
  await expect(band.getByRole('heading', { name: /official warning active/i })).toBeVisible();
  await expect(band.getByRole('button', { name: /find a departure that fits/i })).toBeVisible();
  const bandBox = await band.boundingBox();
  const heroBox = await page.getByRole('button', { name: 'Full screen' }).boundingBox();
  expect(bandBox.y).toBeLessThan(heroBox.y);
});
