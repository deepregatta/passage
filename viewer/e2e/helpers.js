import { expect } from '@playwright/test';

export const SNAPSHOT_ID = 'snapshot_v2_406ad333228b0a73';

export async function openAuditedSnapshot(page) {
  // the app lands on Plan a passage; checked passages live in My passages.
  // The example passage groups the demo pair; opening it opens its latest
  // check, the EXAMPLE briefing.
  await page.goto('/#passages');
  await page.getByRole('button', { name: /^(open|ouvrir) cherbourg → plymouth/i }).first().click();
  // the passage page is one lazy chunk; a cold dev server can take a while to serve it
  await expect(page.getByText(/EMULATED WARNING SCENARIO/i).first()).toBeVisible({ timeout: 15_000 });
  // the decision band is the first-screen contract; charts render lazily behind it
  await page.getByTestId('decision-band').waitFor();
  await page.getByTestId('condition-strip').waitFor();
}

/** A passage's evidence, changes and outcome are sections of its one page. */
export async function openSection(page, name) {
  await page.getByRole('navigation', { name: /Passage sections|Sections de la traversée/ }).getByRole('button', { name, exact: true }).click();
}
