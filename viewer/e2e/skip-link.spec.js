import { expect, test } from '@playwright/test';
import { SNAPSHOT_ID } from './helpers.js';

for (const language of ['en', 'fr']) {
  test(`skip link preserves the ${language} briefing through keyboard activation and reload`, async ({ page }, testInfo) => {
    await page.goto(`/${language === 'fr' ? 'fr/' : ''}?utm_source=skip-test#brief/story?snapshot=${SNAPSHOT_ID}`);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    const url = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const skip = page.getByRole('link', {
      name: language === 'fr' ? 'Aller au contenu du briefing' : 'Skip to briefing content',
    });
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.screenshot({ path: `../output/playwright/iv-7/skip-${language}-${testInfo.project.name}.png` });
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(url);
    await expect(page.getByRole('main')).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => document.querySelector('main').contains(document.activeElement))).toBe(true);

    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await expect(page.getByText(language === 'fr' ? 'SCÉNARIO D’ALERTE SIMULÉ' : 'EMULATED WARNING SCENARIO', { exact: false }).first()).toBeVisible();
  });
}
