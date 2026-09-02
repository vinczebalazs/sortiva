import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 *
 * The public funnel — landing page, sign-in, plan — runs as a second project
 * against a fixture-backed copy of the same site (`e2e/mock-api-server.ts`),
 * because two of its steps reach vendors this repository has no credentials
 * for. Both projects drive the same app; only the answers differ.
 */

/**
 * The app reads its configuration from the repository's `.env`, which Next only
 * picks up when it is started from the directory holding it. Playwright starts
 * it from `apps/web`, so the file is read here and handed over explicitly —
 * otherwise the server refuses to start over a missing encryption key.
 */
function repoEnv(): Record<string, string> {
  const values: Record<string, string> = {}
  let contents: string
  try {
    contents = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
  } catch {
    return values
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    const name = match?.[1]
    if (!name) continue
    values[name] = (match?.[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1')
  }
  // The app refuses to start without a key for encrypting merchant tokens, and
  // the repository ships none — correctly, since a committed key is not a key.
  // The flows here store no token, so a throwaway one made per run is enough to
  // let the server boot, and it is never written anywhere.
  values.ENCRYPTION_MASTER_KEY ||= randomBytes(32).toString('base64')
  return values
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PUBLIC_FUNNEL = '**/public-funnel.e2e.spec.ts'
const mockedSiteURL = 'http://localhost:3100'
const deployed = Boolean(process.env.E2E_BASE_URL)

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: PUBLIC_FUNNEL },
    // Skipped against a deployed environment, where the fixture server is not
    // running and the real endpoints answer for themselves.
    ...(deployed
      ? []
      : [
          {
            name: 'public-funnel',
            testMatch: PUBLIC_FUNNEL,
            use: { ...devices['Desktop Chrome'], baseURL: mockedSiteURL },
          },
        ]),
  ],
  ...(deployed
    ? {}
    : {
        webServer: [
          {
            command: 'pnpm --filter @sortiva/web run dev',
            url: baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
            // The in-process worker would start picking up jobs mid-test; the
            // flows under test drive their own state.
            env: { ...repoEnv(), WORKER_ENABLED: 'false' },
          },
          {
            command: 'pnpm exec tsx e2e/mock-api-server.ts',
            url: `${mockedSiteURL}/api/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
          },
        ],
      }),
})
