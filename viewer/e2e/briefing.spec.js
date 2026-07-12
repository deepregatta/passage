import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('briefing checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await expect(page).toHaveScreenshot('briefing.png', { fullPage: true });
});

test.fixme('emulated warning uses a neutral test-pattern band', async ({ page }) => {
  await openAuditedSnapshot(page);
  await expect(page.getByText('EMULATED WARNING SCENARIO')).toBeVisible();
});

test.fixme('mobile shell has no permanent rail or horizontal overflow', async ({ page }) => {
  await openAuditedSnapshot(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
