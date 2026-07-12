import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('evidence checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Deep dive' }).click();
  await expect(page.getByRole('heading', { name: /evidence & uncertainty/i })).toBeVisible();
  await expect(page).toHaveScreenshot('evidence.png', { fullPage: true });
});

test.fixme('headline, chart, limit, and inspector use one evidence claim', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Deep dive' }).click();
  await expect(page.getByText(/YOUR LIMIT/)).toBeVisible();
});
