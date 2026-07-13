import { expect } from '@playwright/test';

export const SNAPSHOT_ID = '20260720T060000Z_44d2cd5f_64ea971e';

export async function openAuditedSnapshot(page) {
  // the app lands on Plan a passage; briefings live one subview over.
  // Pick the EXAMPLE (latest demo) briefing explicitly — the previous/latest
  // list order depends on snapshot-id sort and flips on fixture regeneration.
  await page.goto('/#plan/briefings');
  await page.getByRole('button', { name: /cherbourg plymouthEXAMPLE.*official warning/i }).first().click();
  await expect(page.getByText(/EMULATED WARNING SCENARIO/i).first()).toBeVisible();
  // the decision band is the first-screen contract; charts render lazily behind it
  await page.getByTestId('decision-band').waitFor();
  await page.getByTestId('condition-strip').waitFor();
}
