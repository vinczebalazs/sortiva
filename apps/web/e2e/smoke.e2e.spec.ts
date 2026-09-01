import { expect, test } from '@playwright/test'

/**
 * The scaffold's own smoke test: proves the harness boots the app and can talk
 * to it. The real flows land with the screens they exercise — signup → plan →
 * claim → progress (T1.4), calendar operations (T4.2), draft review and override
 * (T5.x).
 */

test('the app serves its landing page', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
})

test('the health endpoint reports the service is up', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
})
