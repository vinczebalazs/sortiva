import { expect, test, type Page } from '@playwright/test'

/**
 * What a merchant does on the Opportunities screen, in a real browser, and
 * what it leaves behind on the screen that executes it.
 *
 * `T9.4` proved the card and the drawer against injected props. Two things
 * only a real network round trip can show: that scheduling a CREATE opens a
 * real slot on the same calendar `T9.5` built, and that generating an
 * OPTIMIZE recommendation, downloading it and marking it applied is one
 * continuous flow through the drawer rather than three unrelated clicks —
 * `packages/ui/src/opportunities/OpportunitiesScreen.tsx`'s drawer view had
 * never been re-read after any of its own actions until this ran it for real
 * (fixed alongside this card: `reloadDetail`).
 *
 * It runs against the same fixture-backed site and `ContentState` the Content
 * flows use — scheduling adds to the very calendar `content.e2e.spec.ts`
 * exercises — so the two suites cannot disagree about what "the calendar"
 * means.
 */

const DAY_MS = 86_400_000
function day(offset: number): string {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)
}

const OPTIMIZE_ID = '22222222-2222-4222-8222-222222222222'
const CREATE_ID = '33333333-3333-4333-8333-333333333333'
const SCHEDULED_DAY = day(3)

async function showDay(page: Page, date: string) {
  const cell = page.locator(`[data-day="${date}"]`)
  for (const direction of ['next', 'previous'] as const) {
    for (let step = 0; step < 2; step += 1) {
      if ((await cell.count()) > 0) return cell
      await page.locator(`[data-calendar-month="${direction}"]`).click()
    }
    const back = direction === 'next' ? 'previous' : 'next'
    for (let step = 0; step < 2; step += 1) {
      await page.locator(`[data-calendar-month="${back}"]`).click()
    }
  }
  await expect(cell).toHaveCount(1)
  return cell
}

test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:3100/api/_e2e/reset')
})

test('scheduling a CREATE opportunity puts a topic on the calendar it names', async ({ page }) => {
  await page.goto('/opportunities')

  const card = page.locator(`[data-opportunity-id="${CREATE_ID}"]`)
  await expect(card).toBeVisible()
  await card.locator('[data-opp-action="schedule"]').click()

  // The list re-reads itself after scheduling and says when — the scheduled
  // opportunity itself then falls out of the list's default Status filter
  // (open = new/accepted/blocked, ui §5.1), which is the product working as
  // specified rather than something this flow should route around.
  await expect(page.locator('[role="status"]')).toContainText('On calendar')

  await page.goto('/content')
  const cell = await showDay(page, SCHEDULED_DAY)
  const chip = cell.locator('.sortiva-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip.locator('.sortiva-chip__title')).toHaveText('"trail running shoes for wide feet"')
  // The chip's own link back to where it came from names the opportunity that
  // was actually scheduled, not a coincidence of two flows sharing a fixture.
  await expect(chip.locator('[data-topic-signal]')).toHaveAttribute('href', `/opportunities#${CREATE_ID}`)
})

test('generating an OPTIMIZE recommendation, downloading it and marking it applied is one flow through the drawer', async ({
  page,
}) => {
  await page.goto('/opportunities')

  const card = page.locator(`[data-opportunity-id="${OPTIMIZE_ID}"]`)
  await card.locator('.sortiva-opp__title-button').click()

  const drawer = page.locator(`[data-opportunity-drawer="${OPTIMIZE_ID}"]`)
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('[data-rec-action="generate"]')).toBeVisible()

  await drawer.locator('[data-rec-action="generate"]').click()
  // The generate button only leaves once the drawer has re-read its own
  // subject and found a finished recommendation on it — asserted as an
  // absence with the mock's own generation delay behind it, so the test
  // cannot pass by the drawer simply never noticing the request settled.
  await expect(drawer.locator('[data-rec-action="generate"]')).toHaveCount(0, { timeout: 5_000 })

  // Ready: the fields the recommendation produced, each with a copy button,
  // are the drawer showing what actually came back — not the button the
  // merchant clicked a moment ago.
  const titleField = drawer.locator('[data-rec-field="title"]')
  await expect(titleField).toBeVisible({ timeout: 5_000 })
  await expect(titleField.locator('[data-rec-side="suggested"]')).toContainText(
    'Trail running shoes for wide feet',
  )

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    drawer.locator('[data-rec-download="markdown"]').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.md$/)

  const openTask = drawer.locator('[data-task-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')
  await expect(openTask.locator('[data-task-action="applied"]')).toBeVisible()

  await drawer.locator('[data-rec-action="mark_all_applied"]').click()

  // The task the drawer reads is the one the request just marked, not a copy
  // of what it looked like before the click.
  await expect(openTask.locator('[data-task-state="applied"]')).toBeVisible({ timeout: 5_000 })
  await expect(openTask.locator('[data-task-action="applied"]')).toHaveCount(0)
})
