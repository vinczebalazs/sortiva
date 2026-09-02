import { expect, test } from '@playwright/test'

/**
 * The whole of what a stranger does before they are a customer: paste an
 * address, read what we understood, follow the teaser, sign in, and leave for
 * Stripe.
 *
 * It runs against the site with its API answered from the frozen fixtures
 * (`e2e/mock-api-server.ts`), because reading a stranger's website costs a
 * model call and both Stripe and Google want credentials this repository does
 * not have. Every page, every component and every piece of copy under test is
 * the real one.
 *
 * Two sentences are asserted character for character because the product may
 * not reword them: the teaser, which decides how the product is positioned, and
 * the plan's cap line, which is a quality promise rather than a count.
 *
 * **These do not pass today, and not because of the screens.** The application
 * cannot currently start on a developer's machine: its start-up hook pulls the
 * threshold-config loader into the web bundle, where the loader's way of
 * finding its own file on disk does not survive bundling, and the server aborts
 * before serving anything. Every route answers 500, including the health check
 * that predates any of this — the smoke test beside this file fails the same
 * way. Reported for the integrator; nothing in these flows changes when it is
 * fixed.
 */

const TEASER = 'See your organic growth opportunities →'
const CAP_LINE = 'Up to 1 article per day, quality permitting'
const PREVIEWED_DOMAIN = 'example-outdoor.com'

test.describe('the public funnel', () => {
  test('address → card → teaser → sign in → plan → Stripe Checkout', async ({ page }) => {
    await page.goto('/')

    // ── The address, and the card it produces ────────────────────────────────
    await page.getByLabel('Your site address').fill(PREVIEWED_DOMAIN)
    await page.getByRole('button', { name: 'Analyze my site' }).click()

    const card = page.locator('[data-preview-state="result"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText(`Here's what we understood about ${PREVIEWED_DOMAIN}`)

    // ── The teaser, verbatim ─────────────────────────────────────────────────
    const teaser = page.getByTestId('preview-teaser')
    await expect(teaser).toHaveText(TEASER)
    await teaser.click()

    // ── Signing in, carrying the address as a suggestion ─────────────────────
    await expect(page).toHaveURL(new RegExp(`/signin\\?domain=${PREVIEWED_DOMAIN}$`))
    await expect(page.getByTestId('previewed-domain')).toContainText(PREVIEWED_DOMAIN)
    await page.getByTestId('signin-google').click()

    // ── The plan: one card, the cap line, and one button ─────────────────────
    await expect(page).toHaveURL(/\/plan$/)
    await expect(page.getByTestId('plan-cap-line')).toHaveText(CAP_LINE)
    await expect(page.getByTestId('plan-price')).toContainText('$')
    await expect(page.locator('input')).toHaveCount(0)

    // ── Out to Stripe ────────────────────────────────────────────────────────
    // Stripe's own page is not ours to load; what is under test is that the one
    // button hands the browser to the URL Stripe gave us and does nothing else.
    await page.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe</title>' }),
    )
    await page.getByTestId('subscribe').click()
    await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//)
  })

  test('a site we cannot read gets the same invitation, never an error', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Your site address').fill('unreadable.example')
    await page.getByRole('button', { name: 'Analyze my site' }).click()

    const card = page.locator('[data-preview-state="generic"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText(
      "We couldn't read this site automatically — sign up and we'll take a deeper look.",
    )
    await expect(card.getByTestId('preview-teaser')).toHaveText(TEASER)
  })

  test('too many requests is told to wait, with no bot check to redo', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Your site address').fill('ratelimited.example')
    await page.getByRole('button', { name: 'Analyze my site' }).click()

    const card = page.locator('[data-preview-state="rate_limited"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Too many requests — try again in a minute.')
    await expect(page.getByTestId('preview-teaser')).toHaveCount(0)
  })

  test('backing out of Checkout says nothing was charged, and offers the plan again', async ({
    page,
  }) => {
    await page.goto('/plan?checkout=canceled')

    const returned = page.getByTestId('checkout-canceled')
    await expect(returned).toBeVisible()
    await expect(returned).toContainText('No charge was made.')
    await expect(page.getByTestId('plan-cap-line')).toHaveText(CAP_LINE)
  })

  test('the landing page states the cap line and promises no number of articles', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('plan-cap-line')).toHaveText(CAP_LINE)

    // Invariant 23: the cap is a ceiling, never "x of y" or "x/30".
    const visible = await page.locator('body').innerText()
    expect(visible).not.toMatch(/\b\d+\s*(?:of|\/)\s*\d+\b/)
  })
})
