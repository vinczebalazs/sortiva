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
/**
 * The Content screens run against the same fixture-backed site as the public
 * funnel, because their flows need a calendar that remembers what was done to
 * it and dates anchored to the day the run happens on — neither of which a
 * seeded database gives without also giving a scheduler that would move things
 * mid-test.
 */
const CONTENT = '**/content.e2e.spec.ts'
/**
 * The M9 exit gate (`T9.8`): onboarding end to end, and the Opportunities
 * screen's own actions carried onto the Content screens' calendar. Both need
 * the same fixture-backed site and the same run-length state as Content, for
 * the same reason — a claimed domain, a scheduled topic, a generated
 * recommendation are all things a second read has to find where the first
 * request left them.
 */
const ONBOARDING = '**/onboarding.e2e.spec.ts'
const OPPORTUNITIES = '**/opportunities.e2e.spec.ts'
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
  // Content, Opportunities and onboarding all mutate the one `ContentState` /
  // `OnboardingState` pair the mock server holds for the length of a run.
  // Two of those files' tests racing in different workers could see each
  // other's writes — a schedule from one test landing on a day another test
  // is asserting is empty. Serial locally is the cheap fix for a suite this
  // small; a deployed run never touches the mock server at all.
  workers: deployed ? undefined : 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [PUBLIC_FUNNEL, CONTENT, ONBOARDING, OPPORTUNITIES],
    },
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
          {
            name: 'content',
            testMatch: CONTENT,
            use: { ...devices['Desktop Chrome'], baseURL: mockedSiteURL },
          },
          {
            name: 'onboarding',
            testMatch: ONBOARDING,
            use: { ...devices['Desktop Chrome'], baseURL: mockedSiteURL },
          },
          {
            name: 'opportunities',
            testMatch: OPPORTUNITIES,
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
