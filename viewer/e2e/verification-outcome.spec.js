import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, openSection } from './helpers.js';

// Produced by the actual Python matcher, contract-checked in Python as well.
const producerCase = JSON.parse(readFileSync(new URL('../test/fixtures/verification-case-v2.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/*', (route) => ['POST', 'DELETE'].includes(route.request().method())
    ? route.fulfill({ status: 405 }) : route.fallback());
});

for (const language of ['en', 'fr']) {
  const french = language === 'fr';
  test(`Python-generated and missing verification are truthful in ${language}`, async ({ page }, testInfo) => {
    let doc = producerCase;
    await page.route('**/data/verification/cases/index.json', (route) => route.fulfill({ json: { cases: [{ snapshot_id: doc.snapshot_id }] } }));
    await page.route(`**/data/verification/cases/${producerCase.snapshot_id}.json`, (route) => route.fulfill({ json: doc }));
    await openAuditedSnapshot(page);
    if (french) await page.getByRole('button', { name: 'Français' }).click();
    await openSection(page, french ? 'Ce qui s’est produit' : 'How it turned out');
    const scope = page.locator('[data-section="outcome"]');
    await expect(scope).toContainText(french ? 'SOURCE DES OBSERVATIONS · test-station' : 'OBSERVATION SOURCE · test-station');
    await expect(scope).toContainText(french ? 'Depuis le contrôle: 4 h' : 'Since check: 4 h');
    await expect(scope).toContainText(french ? 'Échéance du modèle: 12 h' : 'Model lead: 12 h');
    await expect(scope).toContainText(french ? 'Il ne démontre ni la chronologie' : 'It does not establish event timing');
    await expect(scope.locator('tbody tr')).toHaveCount(1);
    await page.screenshot({ path: `../output/passage-04/outcome-${language}-${testInfo.project.name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Adverse and empty evidence stay neutral through actual reload/fetch.
    doc = { ...producerCase, pairs: [{ ...producerCase.pairs[0], observed: 40, error: -22 }] };
    await page.reload();
    await expect(scope).toContainText(french ? 'Prévision inférieure à l’observation' : 'Forecast below observation');
    await expect(scope).not.toContainText(/caught the event direction|a saisi l’évolution/);
    doc = { ...producerCase, pairs: [], coverage_summary: { not_independently_observed: 1 }, not_independently_observed: ['L1'] };
    await page.reload();
    await expect(scope).toContainText(french ? 'Son résultat reste non vérifié.' : 'Its outcome remains unverified.');
    await expect(scope.locator('tbody tr')).toHaveCount(0);
    doc = { ...producerCase, pairs: [{ ...producerCase.pairs[0], error: null, observed: null }] };
    await page.reload();
    await expect(scope).toContainText(french ? 'Le cas de vérification publié est invalide' : 'The published verification case is invalid');
    await expect(scope.locator('table')).toHaveCount(0);
  });

  test(`browser-local check discloses no automatic verifier in ${language}`, async ({ page }, testInfo) => {
    // Scratch persistence in this fresh Playwright context, with all writes mocked.
    await openAuditedSnapshot(page);
    await openSection(page, 'How it turned out');
    await expect(page.locator('[data-section="outcome"]')).toContainText('EMULATED DEMO · NOT A SKILL CLAIM');
    await page.evaluate(async () => {
      const { localSnapshots } = await import('/src/lib/localSnapshots.js');
      const { useApp } = await import('/src/stores/appStore.js');
      const state = useApp.getState();
      const id = 'local-verification-check';
      const files = { 'snapshot.json': { ...state.snapshot, snapshot_id: id },
        'findings.json': { ...state.findings, snapshot_id: id }, 'briefing.json': state.briefing,
        'route.json': state.route, 'synoptic.json': state.synoptic };
      for (const [name, doc] of Object.entries(files)) await localSnapshots.write(id, name, JSON.stringify(doc));
    });
    let publicRequests = 0;
    await page.route('**/data/verification/cases/**', (route) => { publicRequests++; return route.fulfill({ json: { cases: [] } }); });
    await page.evaluate(async () => {
      const { useApp } = await import('/src/stores/appStore.js');
      await useApp.getState().openSnapshot('local-verification-check');
      if (useApp.getState().snapshotSource !== 'local') throw new Error('Scratch local snapshot did not open');
    });
    if (french) await page.getByRole('button', { name: 'Français' }).click();
    await openSection(page, french ? 'Ce qui s’est produit' : 'How it turned out');
    const scope = page.locator('[data-section="outcome"]');
    await expect(scope).toContainText(french ? 'La vérification automatique est indisponible' : 'Automatic verification is unavailable');
    await expect(scope).toContainText(french ? 'Cette fonction n’est pas encore disponible.' : 'This is not available yet.');
    await expect(scope).not.toContainText(/job will match|sera comparée aux observations/);
    expect(publicRequests).toBe(0);
    await page.screenshot({ path: `../output/passage-04/local-${language}-${testInfo.project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: french ? 'Mes traversées' : 'My passages', exact: true }).first().click();
    await expect(page.getByText(french ? 'Dans ce navigateur uniquement' : 'Local only', { exact: true })).toBeVisible();
  });
}
