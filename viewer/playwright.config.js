import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const launch = JSON.parse(readFileSync(path.join(repo, '.claude/launch.json'), 'utf8'))
  .configurations.find((item) => item.name === 'viewer-demo');
const baseURL = `http://127.0.0.1:${launch.port}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: '../output/playwright-results',
  snapshotDir: './e2e/__screenshots__',
  globalSetup: './playwright.global-setup.js',
  fullyParallel: false,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1568, height: 1003 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: [launch.runtimeExecutable, ...launch.runtimeArgs].join(' '),
    cwd: repo,
    env: launch.env,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
