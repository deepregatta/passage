import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test.use({ timezoneId: 'Europe/Paris' });

test('briefing checkpoint', async ({ page }) => {
  // Keep model-age labels aligned with the reference fixture. Otherwise this
  // full-page baseline changes every day and wraps differently on mobile.
  await page.clock.setFixedTime(new Date('2026-07-19T18:00:00Z'));
  // External tile availability/labels are not a UI baseline. Keep the route
  // overlays, map controls and attribution, but omit live raster tiles.
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
  await openAuditedSnapshot(page);
  await expect(page).toHaveScreenshot('briefing.png', { fullPage: true });
});

test('emulated warning uses a neutral test-pattern band', async ({ page }) => {
  await openAuditedSnapshot(page);
  await expect(page.getByText('EMULATED WARNING SCENARIO')).toBeVisible();
});

test('responsive shell uses horizontal stages without overflow', async ({ page }) => {
  await openAuditedSnapshot(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  const stages = page.getByRole('navigation', { name: 'Passage stages', exact: true });
  await expect(stages).toHaveCount(1);
  await expect(stages.getByRole('button')).toHaveCount(4);
  await expect(stages.getByRole('button', { name: /Brief$/ })).toHaveAttribute('aria-current', 'page');
  const box = await stages.boundingBox();
  const viewport = page.viewportSize();
  expect(box.width).toBeGreaterThan(box.height * 3);
  if (viewport.width < 768) {
    expect(box.x).toBe(0);
    expect(box.width).toBe(viewport.width);
    expect(box.y + box.height).toBe(viewport.height);
  } else {
    expect(box.y).toBeLessThan(60);
  }
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
  await expect(bulletin.getByText('Emulated bulletin', { exact: true })).toBeVisible();
  await expect(bulletin.getByText('EMULATED WARNING SCENARIO')).toBeVisible();
  await expect(bulletin.getByText('Emulated bulletin. Do not use for a real passage decision.')).toBeVisible();
  await bulletin.getByRole('button', { name: 'Close bulletin' }).click();
  await expect(bulletin).toHaveCount(0);
});

for (const language of ['en', 'fr']) {
  test(`recorded models and emulated bulletin disclosure (${language})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-19T18:00:00Z'));
    await openAuditedSnapshot(page);
    if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
    const french = language === 'fr';
    await expect(page.getByRole('button', { name: /safer departure|départ plus sûr/i })).toHaveCount(0);
    const summary = page.getByText(french ? 'Modèles et couverture' : 'Models and coverage', { exact: true });
    await summary.click();
    const panel = summary.locator('..');
    await expect(panel.getByText(french ? '51 membres' : '51 members')).toBeVisible();
    await expect(panel.getByText(french ? 'scénario' : 'scenario', { exact: true })).toHaveCount(4);
    await expect(panel.getByText(french ? 'Données de test' : 'Fixture data')).toHaveCount(4);
    await expect(panel.getByText(french ? 'portes de marée' : 'tidal gates').locator('..')).toContainText(french ? 'non évalué' : 'not assessed');
    await expect(panel.getByText(french ? 'alertes officielles' : 'official warnings').locator('..')).toContainText(french ? 'évalué (simulé)' : 'assessed emulated');
    await page.getByRole('button', { name: french ? 'Examiner le bulletin de l’exemple' : 'Inspect example bulletin', exact: true }).click();
    const bulletin = page.getByRole('dialog');
    await expect(bulletin.getByText(french ? 'SCÉNARIO D’ALERTE SIMULÉ' : 'EMULATED WARNING SCENARIO')).toBeVisible();
    await expect(bulletin.getByText(french ? 'Bulletin simulé. Ne l’utilisez pas pour prendre une décision de traversée réelle.' : 'Emulated bulletin. Do not use for a real passage decision.')).toBeVisible();
  });
}
