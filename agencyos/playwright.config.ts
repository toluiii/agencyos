import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against production builds (`npm run build` first).
 * Next.js dev + Nest watch + Chromium did not fit in the 2 GB / 2 vCPU test machine,
 * so the suite deliberately targets `next start` + `node dist/src/main.js`.
 * `reuseExistingServer` lets a developer keep their own servers running locally.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // On CI, the `github` reporter turns each failure into an annotation on the run and the PR.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npm run start -w @agencyos/api', url: 'http://127.0.0.1:4000/api/v1/health/ready', reuseExistingServer: true, timeout: 120000 },
    { command: 'npm run start -w @agencyos/web', url: 'http://127.0.0.1:3000/login', reuseExistingServer: true, timeout: 120000 },
  ],
});
