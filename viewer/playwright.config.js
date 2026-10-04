import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const live = process.env.PASSAGE_E2E_MODE === 'live';
const production = live || process.env.PASSAGE_E2E_MODE === 'build';
const launch = JSON.parse(readFileSync(path.join(repo, '.claude/launch.json'), 'utf8'))
  .configurations.find((item) => item.name === (production ? 'static-dist' : 'viewer-demo'));
const port = Number(process.env.PASSAGE_E2E_PORT ?? launch.port);
const baseURL = live ? 'https://passage.deepregatta.com' : `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: '../output/playwright-results',
  snapshotDir: './e2e/__screenshots__',
  globalSetup: production ? undefined : './playwright.global-setup.js',
  ...(production ? { testMatch: '**/*.production.spec.js' } : { testIgnore: '**/*.production.spec.js' }),
  fullyParallel: false,
  use: {
    baseURL,
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1568, height: 1003 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
  webServer: live ? undefined : {
    command: [launch.runtimeExecutable, ...launch.runtimeArgs,
      ...(!production && port !== launch.port ? ['--port', String(port)] : [])].join(' '),
    cwd: repo,
    env: { ...launch.env, ...(production ? { PORT: String(port) } : {}) },
    url: baseURL,
    stdout: 'pipe',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
