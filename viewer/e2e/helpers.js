import { expect } from '@playwright/test';

export const SNAPSHOT_ID = '20260720T060000Z_44d2cd5f_f0703423';

export async function openAuditedSnapshot(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /cherbourg-plymouth-v1.*warning active/i }).first().click();
  await expect(page.getByText(/official warning active/i).first()).toBeVisible();
}
