import { expect, test } from '@playwright/test'

/**
 * The whole of onboarding, in one browser: a merchant with no domain yet,
 * through the Shopify grant, the seven-row progress list, skipping Search
 * Console, confirming the profile, and landing on Opportunities with the
 * activation headline.
 *
 * `T9.3` proved every one of these screens on its own, against MSW mocks
 * inside a component test. This is the same screens wired to the same real
 * routes a merchant's browser calls, run together for the first time — which
 * is the point of `T9.8`: nothing here is new product behaviour, it is the
 * five separately-built cards of milestone 9 proven as one running app.
 *
 * The dashboard route decides what is on screen entirely from `GET
 * /api/account` and `GET /api/ingestion/status`, so the fixture server holds
 * a small run of state (`e2e/onboarding-state.ts`) rather than a fixed body —
 * the same shape `e2e/content-state.ts` already uses for the calendar.
 *
 * Two vendors sit behind this flow that the repository has no credentials
 * for. Shopify's grant is answered the way the public funnel already answers
 * Google's sign-in: the mock server hands back its own address instead of
 * Shopify's, the browser is sent there for real, and it redirects back having
 * moved the run on a step — a real navigation, not an intercepted one.
 * Search Console is answered by skipping it, which is a real, always-visible
 * path through the actual screen rather than a second OAuth simulation for
 * coverage `SearchConsoleStep`'s own component tests already have.
 */

test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:3100/api/_e2e/onboarding-reset')
})

test('a store with no domain walks itself to the Opportunities activation screen', async ({ page }) => {
  await page.goto('/dashboard')

  // No domain yet: the address field.
  await page.locator('#sortiva-connect-domain').fill('wideworldshoes.example')
  await page.getByRole('button', { name: 'Connect domain' }).click()

  // The Shopify grant blocks, carrying the read-only trust copy verbatim.
  const shopifyCard = page.locator('[data-onboarding-card="shopify_blocking"]')
  await expect(shopifyCard).toBeVisible()
  await expect(shopifyCard).toContainText(
    "Read-only — we can't change anything in your store with this permission.",
  )

  // A real navigation to Shopify's consent screen and back — not intercepted,
  // driven the same way the public funnel already drives Google's sign-in.
  await shopifyCard.getByRole('button', { name: 'Connect Shopify' }).click()
  await page.waitForURL('**/dashboard')

  // The seven-row list is up, and the steps between the grant and Search
  // Console advance on their own — the assertion waits for the one step that
  // genuinely pauses on a person, rather than a fixed sleep.
  await expect(page.locator('[data-step="connect_store"]')).toHaveAttribute('data-step-state', 'done')
  await expect(page.locator('[data-step="search_console"]')).toHaveAttribute(
    'data-step-state',
    'active',
    { timeout: 10_000 },
  )

  // Soft-required: "Skip for now" carries equal weight to connecting, and is
  // always on screen.
  const gscCard = page.locator('[data-onboarding-card="gsc_connect"]')
  await expect(gscCard).toBeVisible()
  await gscCard.locator('.sortiva-gsc__skip').click()

  // Review: the seven sections, pre-filled from the run.
  await expect(page.locator('[data-confirm-sections="7"]')).toBeVisible({ timeout: 10_000 })
  await page.locator('.sortiva-confirm__footer .sortiva-onboarding-card__primary').click()

  // The wait between confirming and the first scan.
  await expect(page.locator('[data-onboarding-card="finding_opportunities"]')).toBeVisible()

  // Activation: navigated to Opportunities (not the dashboard) with the
  // canonical headline, and the Limited Intelligence badge because Search
  // Console was skipped this run.
  await page.waitForURL('**/opportunities', { timeout: 10_000 })
  const headline = page.locator('.sortiva-activation__headline')
  await expect(headline).toHaveText('We found 2 ways to grow your store organically')
  await expect(page.locator('[data-activation-limited="true"]')).toBeVisible()

  // The one-time explainer strip: one sentence per action type.
  for (const action of ['create', 'optimize', 'refresh']) {
    await expect(page.locator(`[data-action-type="${action}"]`)).toBeVisible()
  }

  // And the list underneath is the real one, not an empty shell.
  await expect(page.locator('.sortiva-opp')).toHaveCount(2)
})
