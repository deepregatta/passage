// The browser responsiveness measurement (docs/maintenance/2026-11-12-scan-responsiveness.md).
// Not part of `npm run test:e2e` (a different test directory and file suffix, *.perf.js).
//
//   npm run perf:prepare        once: engine build, production viewer build, synthetic forecast files
//   npm run perf:browser        the measurement; writes output/perf/browser.json
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PASSAGE_PERF_PORT ?? process.env.PASSAGE_E2E_PORT ?? 5194);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/perf',
  testMatch: '**/*.perf.js',
  outputDir: '../output/perf/playwright-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  reporter: 'list',
  use: { baseURL, timezoneId: 'Europe/Paris' },
  webServer: {
    command: 'node e2e/perf/serve.js',
    cwd: import.meta.dirname,
    env: { PASSAGE_PERF_PORT: String(port) },
    url: `${baseURL}/index.html`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 30_000,
  },
});
