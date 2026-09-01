import { defineConfig, devices } from '@playwright/test'

/**
 * The UI flows — onboarding, calendar operations, review, override — run under
 * Playwright. Locally and in CI they run against `next dev` on a seeded
 * development database (`pnpm db:seed`); against a deployed environment, set
 * `E2E_BASE_URL` and no server is started.
 *
 * Browsers are not installed by `pnpm install`. Before the first run:
 *
 *   pnpm exec playwright install chromium
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  // A UI flow that only passes on the third try is a flow that will fail for a
  // merchant; retries hide that. One retry in CI covers infrastructure blips.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @sortiva/web run dev',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          // The in-process worker would start picking up jobs mid-test; the
          // flows under test drive their own state.
          env: { WORKER_ENABLED: 'false' },
        },
      }),
})
