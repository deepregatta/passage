import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { renderBriefing } from '../../engine/dist/index.js';
import { openAuditedSnapshot } from './helpers.js';

const load = name => JSON.parse(readFileSync(new URL(`../test/fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/${name}.json`, import.meta.url), 'utf8'));
const findings = load('findings');
const original = load('briefing');
const name = 'Wind limit <img src=x onerror=alert(1)> Jul';
const synthetic = structuredClone(findings);
synthetic.gates = [];
const driver = synthetic.evidence.find(e => e.evidence_id === synthetic.verdict.driver_evidence_id);
Object.assign(driver, { source_kind: 'emulated', rule_id: 'W-GUST-01', units: 'kt', value: 28.1, limit: 28, valid_time: '2026-07-12T18:00:00Z' });
delete driver.member_fraction;
synthetic.legs.find(l => l.leg_id === driver.leg_id).name = name;
const decision = renderBriefing(synthetic).sections.find(s => s.id === 'decision');
const current = { ...original, sections: original.sections.map(s => s.id === 'decision' ? decision : s) };

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
  await page.route('**/*', route => ['POST', 'DELETE'].includes(route.request().method())
    ? route.fulfill({ status: 405 }) : route.fallback());
});

for (const language of ['en', 'fr']) {
  test(`served legacy, current IDs and whole-field fallback in ${language}`, async ({ page }, testInfo) => {
    let briefing = original;
    let servedFindings = findings;
    await page.route('**/data/snapshots/*/findings.json', route => route.fulfill({ json: servedFindings }));
    await page.route('**/data/snapshots/*/briefing.json', route => route.fulfill({ json: briefing }));
    await openAuditedSnapshot(page);
    if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
    await page.getByRole('button', { name: language === 'fr' ? 'Pourquoi cette évaluation' : 'Why this assessment' }).click();
    const plain = page.locator('[data-message-field="plain"]');
    await expect(plain).toHaveAttribute('data-message-status', 'legacy');
    const oldVerdict = await plain.textContent();
    briefing = current;
    servedFindings = synthetic;
    await page.reload();
    await page.getByRole('button', { name: language === 'fr' ? 'Pourquoi cette évaluation' : 'Why this assessment' }).click();
    await expect(plain).toHaveAttribute('data-message-status', 'translated');
    await expect(plain).toContainText(oldVerdict.split(language === 'fr' ? ' Signal principal' : ' The main signal')[0]);
    await expect(plain).toContainText(name);
    await expect(plain).toContainText(language === 'fr' ? 'rafales juste au-dessus de votre limite de 28 nd' : 'gusts just over your 28 kt limit');
    await expect(plain.locator('img')).toHaveCount(0);
    const pro = page.locator('[data-message-field="pro"]');
    await pro.evaluate(node => { node.closest('details').open = true; });
    await expect(pro).toContainText(language === 'fr' ? '28.1 nd' : '28.1 kt');
    for (const next of ['en', 'fr', language]) {
      await page.getByRole('button', { name: next === 'fr' ? 'Français' : 'English', exact: true }).click();
      await expect(plain).toContainText(name);
      await expect(plain).toContainText(next === 'fr' ? 'Signal principal' : 'The main signal');
    }
    await page.emulateMedia({ media: 'print' });
    await expect(plain).toContainText(language === 'fr' ? 'Signal principal' : 'The main signal');
    await page.emulateMedia({ media: 'screen' });
    await plain.scrollIntoViewIfNeeded();
    await expect(plain).toBeVisible();
    await plain.screenshot({ path: `../output/passage-07/decision-field-${language}-${testInfo.project.name}.png` });
    await page.screenshot({ path: `../output/passage-07/decision-${language}-${testInfo.project.name}.png`, fullPage: true });
    briefing = structuredClone(current);
    briefing.sections.find(s => s.id === 'decision').messages.plain.push({ message_id: 'future.message.v9', params: {} });
    await page.reload();
    await page.getByRole('button', { name: language === 'fr' ? 'Pourquoi cette évaluation' : 'Why this assessment' }).click();
    await plain.scrollIntoViewIfNeeded();
    await expect(plain).toBeVisible();
    await plain.screenshot({ path: `../output/passage-07/fallback-${language}-${testInfo.project.name}.png` });
    await expect(plain).toHaveAttribute('data-message-status', 'fallback');
    await expect(plain).toContainText(decision.register_plain);
    await expect(plain).toContainText(language === 'fr' ? 'Texte original en anglais' : 'Original English text');
    await expect(page.getByText(/EMULATED WARNING SCENARIO|SCÉNARIO D’ALERTE SIMULÉ/i).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`scratch browser snapshot preserves IDs and literal facts through reload in ${language}`, async ({ page }) => {
    await openAuditedSnapshot(page);
    await page.evaluate(async ({ current, name, synthetic }) => {
      const { useApp } = await import('/src/stores/appStore.js');
      const { localSnapshots } = await import('/src/lib/localSnapshots.js');
      const state = useApp.getState();
      const id = 'local-message-contract';
      const files = { 'snapshot.json': { ...state.snapshot, snapshot_id: id }, 'findings.json': { ...synthetic, snapshot_id: id },
        'briefing.json': { ...current, snapshot_id: id }, 'route.json': state.route, 'synoptic.json': state.synoptic };
      for (const [file, doc] of Object.entries(files)) await localSnapshots.write(id, file, JSON.stringify(doc));
      await useApp.getState().openSnapshot(id);
      if (useApp.getState().snapshotSource !== 'local') throw new Error('Local snapshot failed to open');
      if (!useApp.getState().briefing.sections.find(s => s.id === 'decision').messages.plain[1].params.leg_name.includes(name)) throw new Error('Message facts did not round trip');
    }, { current, name, synthetic });
    if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
    await page.reload();
    // Local IDs are intentionally omitted from the share URL; reopen the saved
    // check through the same loader after the browser context reloads.
    await page.evaluate(async () => {
      const { useApp } = await import('/src/stores/appStore.js');
      await useApp.getState().openSnapshot('local-message-contract');
      if (useApp.getState().snapshotSource !== 'local') throw new Error('Persisted local snapshot failed to reopen');
    });
    await page.getByRole('button', { name: language === 'fr' ? 'Pourquoi cette évaluation' : 'Why this assessment' }).click();
    const plain = page.locator('[data-message-field="plain"]');
    await expect(plain).toHaveAttribute('data-message-status', 'translated');
    await expect(plain).toContainText(name);
    await expect(plain).toContainText(language === 'fr' ? 'rafales juste au-dessus' : 'gusts just over');
    await expect(plain.locator('img')).toHaveCount(0);
  });
}
