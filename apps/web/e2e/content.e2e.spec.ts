import { expect, test, type Page } from '@playwright/test'

/**
 * What a merchant does on the Content screens, in a real browser: change their
 * mind about a planned topic, rearrange the plan, add one of their own, read
 * why a day produced nothing, and decide what to do with a draft that did not
 * meet the bar.
 *
 * It runs against the site with its API answered by `e2e/mock-api-server.ts`,
 * which for these routes holds a small amount of state anchored to the day the
 * run happens on. Half of what the calendar renders depends on which side of
 * today a day sits, and vetoing a topic and then finding it gone is the
 * assertion itself — neither survives a fixed response body. Every page,
 * component and sentence under test is the real one.
 *
 * The flow that matters most asserts an absence: a day that has passed with
 * nothing on it renders nothing at all. We write at most one article a day and
 * never make a quiet day up afterwards, so a screen that marked such a day, or
 * offered to fill it, would be contradicting the product.
 */

const DAY_MS = 86_400_000

function day(offset: number): string {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Brings a date into view. The grid shows one month at a time and the run's
 * dates are relative to today, so a day a few either side can sit in the
 * neighbouring month.
 */
async function showDay(page: Page, date: string) {
  const cell = page.locator(`[data-day="${date}"]`)
  for (const direction of ['next', 'previous'] as const) {
    for (let step = 0; step < 2; step += 1) {
      if ((await cell.count()) > 0) return cell
      await page.locator(`[data-calendar-month="${direction}"]`).click()
    }
    // Back to where we started before trying the other direction.
    const back = direction === 'next' ? 'previous' : 'next'
    for (let step = 0; step < 2; step += 1) {
      await page.locator(`[data-calendar-month="${back}"]`).click()
    }
  }
  await expect(cell).toHaveCount(1)
  return cell
}

// Every flow below changes the calendar, and the fixture server holds that
// change for the length of the run. Starting each from the same place is what
// stops one flow's veto deciding the next one's outcome.
test.beforeEach(async ({ request }) => {
  await request.post('http://localhost:3100/api/_e2e/reset')
})

test.describe('the content calendar', () => {
  test('a day that produced nothing is shown as nothing, and only a future day is an opening', async ({
    page,
  }) => {
    await page.goto('/content')
    await expect(page.locator('.sortiva-calendar')).toBeVisible()

    const behind = await showDay(page, day(-3))
    // No marker, no tally, nothing to press. A quiet day is a normal outcome.
    await expect(behind).toHaveAttribute('data-day-empty', 'blank')
    await expect(behind.locator('[data-day-add]')).toHaveCount(0)

    const ahead = await showDay(page, day(6))
    await expect(ahead).toHaveAttribute('data-day-empty', 'open')
    await expect(ahead.locator('[data-day-add]')).toHaveCount(1)

    // Today is neither: the day's job may already have run, so offering to fill
    // it would be exactly the catching-up the product refuses to do.
    const now = await showDay(page, day(0))
    await expect(now.locator('[data-day-add]')).toHaveCount(0)

    // And the screen says so in words rather than leaving it to be inferred.
    await expect(page.locator('[data-gap-note]')).toContainText('Empty days are normal')
    // The grid itself never marks or counts a quiet day. The only place the
    // word appears on the screen is the note above, saying nothing was.
    await expect(page.locator('.sortiva-calendar__grid')).not.toContainText(/missed|of \d/)
  })

  test('a past day that was held back explains itself, in our words', async ({ page }) => {
    await page.goto('/content')
    const held = await showDay(page, day(-1))
    await expect(held.locator('[data-topic-state="rejected_by_gate"]')).toBeVisible()

    await held.locator('.sortiva-chip__open').click()
    const popover = page.locator('[data-topic-popover]')
    await expect(popover.locator('.sortiva-rejection')).toBeVisible()
    await expect(popover.locator('.sortiva-rejection')).toContainText('Draft grading')
    // The canonical sentence, reached through the string catalogue rather than
    // written by a model.
    await expect(popover.locator('.sortiva-rejection__reason')).toHaveText(
      'We held this topic back because the store does not contain enough factual product information yet.',
    )
    await expect(popover.locator('.sortiva-rejection__reason')).toHaveAttribute(
      'data-why-known',
      'true',
    )
  })

  test('vetoing a planned topic can be taken back, and otherwise takes its opportunity with it', async ({
    page,
  }) => {
    await page.goto('/content')
    const cell = await showDay(page, day(1))
    await cell.locator('.sortiva-chip__open').click()
    await page.locator('[data-popover-action="veto"]').click()

    // The chip goes at once, and the undo is on offer.
    await expect(cell.locator('.sortiva-chip')).toHaveCount(0)
    const undo = page.locator('[data-toast-undo]')
    await expect(undo).toBeVisible()
    await undo.click()

    // Nothing was sent, and the topic is back.
    await expect(cell.locator('.sortiva-chip')).toHaveCount(1)
    const afterUndo = await page.request.get('/api/_e2e/calls')
    expect(((await afterUndo.json()) as { calls: string[] }).calls).not.toContain(
      'veto aaaaaaaa-0004-4000-8000-000000000004',
    )

    // This time, let the window close.
    await cell.locator('.sortiva-chip__open').click()
    await page.locator('[data-popover-action="veto"]').click()
    await expect(cell.locator('.sortiva-chip')).toHaveCount(0)

    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/_e2e/calls')
          return ((await response.json()) as { calls: string[] }).calls
        },
        { timeout: 15_000 },
      )
      .toEqual(
        expect.arrayContaining([
          'veto aaaaaaaa-0004-4000-8000-000000000004',
          // The opportunity that produced the topic goes under the same undo.
          'dismiss 22222222-2222-4222-8222-222222222222',
        ]),
      )
  })

  test('a topic already being written asks before its draft is thrown away', async ({ page }) => {
    await page.goto('/content')
    const cell = await showDay(page, day(0))
    await cell.locator('.sortiva-chip__open').click()

    const veto = page.locator('[data-popover-action="veto"]')
    await expect(veto).toHaveAttribute('data-veto-kind', 'cancel_publication')
    await expect(veto).toHaveText('Cancel publication')
    await veto.click()

    const confirm = page.locator('[data-confirm="veto"]')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('the cost is ours, not yours')
    await confirm.locator('[data-confirm-action="keep"]').click()
    await expect(cell.locator('.sortiva-chip')).toHaveCount(1)
  })

  test('a topic drags to an open day, and is refused by a pinned one with a shake', async ({
    page,
  }) => {
    await page.goto('/content')
    const from = await showDay(page, day(4))
    const pinned = await showDay(page, day(2))

    await expect(pinned.locator('[data-topic-pinned="true"]')).toBeVisible()

    // Dropping on a pinned day is refused where it landed, without a round trip.
    await from.locator('.sortiva-chip').dragTo(pinned)
    await expect(pinned).toHaveAttribute('data-day-refused', 'true')
    await expect(pinned.locator('[data-day-refusal]')).toContainText('pinned')
    await expect(from.locator('.sortiva-chip')).toHaveCount(1)

    // An open day takes it.
    const to = await showDay(page, day(6))
    await from.locator('.sortiva-chip').dragTo(to)
    await expect(to.locator('.sortiva-chip')).toHaveCount(1)
    await expect(from.locator('.sortiva-chip')).toHaveCount(0)
  })

  test('a topic added by hand is checked, and answers honestly in each of its four ways', async ({
    page,
  }) => {
    await page.goto('/content')

    for (const [offset, typed, expected, saying] of [
      [7, 'winter fell running for beginners', 'planned', 'Added'],
      [8, 'a quiet corner of the sport', 'planned_with_warning', 'Heads-up'],
      [9, 'shoes we are already ranked for', 'converted', 'You already rank for this'],
      [10, 'nonsense nobody searches', 'rejected', "We didn't add this one"],
    ] as const) {
      const cell = await showDay(page, day(offset))
      await cell.locator('[data-day-add]').click()

      const form = page.locator('[data-add-topic-date]')
      await expect(form).toBeVisible()
      await form.locator('input[name="title"]').fill(typed)
      await form.getByRole('button', { name: 'Check and add' }).click()

      await expect(form).toHaveAttribute('data-add-state', expected)
      await expect(form.locator('[data-add-answer]')).toContainText(saying)
      await form.getByRole('button', { name: 'Close' }).click()
    }

    // The one that converted links to the opportunity it became instead.
    const converted = await showDay(page, day(9))
    await converted.locator('[data-day-add]').click()
    await page.locator('[data-add-topic-date] input[name="title"]').fill('shoes we are already ranked for')
    await page.getByRole('button', { name: 'Check and add' }).click()
    await expect(page.locator('[data-add-answer="converted"] a')).toHaveAttribute(
      'href',
      /#44444444-4444-4444-8444-444444444444$/,
    )
  })
})

test.describe('an article', () => {
  test('is readable and has nowhere to type', async ({ page }) => {
    await page.goto('/content/articles')
    await page.getByRole('link', { name: 'Best trail shoes under eighty pounds' }).click()

    await expect(page.locator('[data-article-body]')).toBeVisible()
    await expect(page.locator('[data-article-body] h1')).toBeVisible()

    // The commitment, asserted as an absence: no editor, in any form.
    await expect(page.locator('textarea')).toHaveCount(0)
    await expect(page.locator('[contenteditable]')).toHaveCount(0)
    await expect(page.locator('input[type="text"], input:not([type])')).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
  })

  test('a draft waiting for review is approved outright, with one click and no editor in sight', async ({
    page,
  }) => {
    await page.goto('/content/articles')
    await page.getByRole('link', { name: 'Choosing a drop height for fell running' }).click()

    await expect(page.locator('[data-article-state="in_review"]')).toBeVisible()
    // Both decisions are on offer; only one of them writes nothing further.
    await expect(page.locator('[data-article-action="discard"]')).toBeVisible()

    await page.locator('[data-article-action="approve"]').click()

    await expect(page.locator('[data-article-notice]')).toHaveText(
      'Approved. It publishes at your publishing hour.',
    )
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/_e2e/calls')
        return ((await response.json()) as { calls: string[] }).calls
      })
      .toContain('article approve 99999999-0000-4000-8000-000000000007')
  })

  test('held back, it shows the judge’s own objection and lets it be overruled deliberately', async ({
    page,
  }) => {
    await page.goto('/content/articles')
    await page.getByRole('link', { name: 'Best trail shoes under eighty pounds' }).click()

    const report = page.locator('[data-quality-report="failed"]')
    await expect(report).toBeVisible()
    await expect(report.locator('[data-justification="informationGain"]')).toContainText(
      'repeats specifications',
    )
    // The score, with no floor beside it: the thresholds live in the rules
    // package and a copy in the browser would be a second quality gate.
    await expect(report).not.toHaveText(/\d\s*(of|\/)\s*\d/)

    await page.locator('[data-article-action="publish-anyway"]').click()
    const dialog = page.locator('[data-confirm="override"]')
    await expect(dialog).toBeVisible()
    // The dialog restates what is being overruled, by name.
    await expect(dialog.locator('[data-override-criteria]')).toContainText('Information gain')
    await expect(dialog).toContainText('hurt rather than help your rankings')
    await expect(dialog).toContainText('kept out of our quality tuning')

    await dialog.locator('[data-override-action="confirm"]').click()
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/_e2e/calls')
        return ((await response.json()) as { calls: string[] }).calls
      })
      .toContain('article publish-anyway 77777777-0000-4000-8000-000000000009')
  })

  test('exported, it offers its files and asks where it was published', async ({ page }) => {
    await page.goto('/content/articles')
    const row = page.locator('[data-article-delivery="export"]')

    await expect(row.locator('[data-article-badge="awaiting-url"]')).toBeVisible()
    for (const extension of ['md', 'html', 'json']) {
      await expect(row.locator(`[data-article-download="${extension}"]`)).toBeVisible()
    }

    const field = row.locator('[data-article-url="pending"]')
    await field.locator('input').fill('https://competitor.example/blogs/winter-kit')
    await field.locator('[data-article-url-submit]').click()
    // An address on somebody else's site would credit this store with their
    // traffic, so it never leaves the browser.
    await expect(field.locator('[data-article-url-error="off_domain"]')).toBeVisible()

    await field.locator('input').fill('https://example-outdoor.com/blogs/winter-kit')
    await field.locator('[data-article-url-submit]').click()
    await expect(row.locator('[data-article-url="confirmed"]')).toBeVisible()
  })
})
