import { describe, expect, it } from 'vitest'
import {
  articleAgeDays,
  labelExclusions,
  labelStore,
  labelWindows,
  ratedLabels,
  type ArticleLabelConfig,
  type ArticleLabelFacts,
  type ArticleLabelResult,
  type LabelWindowTotals,
} from './labels'

/**
 * The numbers the shipped config carries. Restated here rather than loaded so a
 * change to the config file breaks nothing silently in this file — but the
 * `packages/rules` suite is what holds the file to these values, and this suite
 * is only testing the rule's shape.
 */
const CONFIG: ArticleLabelConfig = {
  maturityDays: 28,
  winnerClicksStoreMedianMultipleMin: 2,
  winnerPositionImprovementMin: 5,
  underperformerClicksStoreMedianMultipleMax: 0.25,
  underperformerPositionMin: 30,
  underperformerAgeDaysMin: 90,
}

const NOW = '2026-09-01T00:00:00.000Z'

/** `days` before `NOW`, as an ISO instant. */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
}

function totals(
  clicks: number,
  impressions: number,
  position: number | null,
): LabelWindowTotals {
  return { clicks, impressions, position }
}

/** A healthy, unremarkable published article, 200 days old. Every test starts from this and changes one thing. */
function article(overrides: Partial<ArticleLabelFacts> = {}): ArticleLabelFacts {
  return {
    articleId: 'a-mid',
    published: true,
    publishedAt: daysAgo(200),
    publishedViaOverride: false,
    delivery: 'auto',
    publishedUrl: 'https://shop.example/blogs/news/mid',
    repairPending: false,
    current: totals(10, 1000, 12),
    prior: totals(10, 1000, 12),
    ...overrides,
  }
}

/**
 * Four ordinary articles at 10 clicks each, so the store's middle article is 10
 * clicks and 1,000 impressions. Every test that needs a baseline builds it from
 * these, so the yardstick is a real store rather than a number chosen to make a
 * case pass.
 */
function ordinaryStore(): ArticleLabelFacts[] {
  return [0, 1, 2, 3].map((n) =>
    article({ articleId: `a-ordinary-${n}`, current: totals(10, 1000, 12), prior: totals(10, 1000, 12) }),
  )
}

function resultFor(results: readonly ArticleLabelResult[], articleId: string): ArticleLabelResult {
  const found = results.find((result) => result.articleId === articleId)
  if (!found) throw new Error(`no result for ${articleId}`)
  return found
}

describe('articleAgeDays', () => {
  it('counts whole days since publication', () => {
    expect(articleAgeDays(daysAgo(27), NOW)).toBe(27)
    expect(articleAgeDays(daysAgo(28), NOW)).toBe(28)
  })

  it('has no age for an article that was never published', () => {
    expect(articleAgeDays(null, NOW)).toBeNull()
  })

  it('treats a publish date in the future as zero days old, not as an enormous age', () => {
    const tomorrow = new Date(Date.parse(NOW) + 86_400_000).toISOString()
    expect(articleAgeDays(tomorrow, NOW)).toBe(0)
  })
})

describe('the maturity gate', () => {
  it('gives no verdict on the day before the article comes of age', () => {
    const subject = article({ articleId: 'a-young', publishedAt: daysAgo(27) })
    const { results } = labelStore([...ordinaryStore(), subject], CONFIG, NOW)

    const young = resultFor(results, 'a-young')
    expect(young.label).toBe('unrated')
    expect(young).toMatchObject({ excludedBecause: ['too_young'], ageDays: 27 })
  })

  it('gives a verdict on the day it does', () => {
    const subject = article({ articleId: 'a-mature', publishedAt: daysAgo(28) })
    const { results } = labelStore([...ordinaryStore(), subject], CONFIG, NOW)

    const mature = resultFor(results, 'a-mature')
    expect(mature.label).not.toBe('unrated')
    expect(mature).toMatchObject({ ageDays: 28 })
  })

  it('an article one day too young cannot be a winner even on figures that would crown it', () => {
    // The same article graded at 28 days is a winner; at 27 it is unrated. What
    // is being proved is the refusal, not the arithmetic.
    const spectacular = { articleId: 'a-star', current: totals(500, 40_000, 2), prior: totals(0, 0, null) }
    const store = ordinaryStore()

    const young = labelStore([...store, article({ ...spectacular, publishedAt: daysAgo(27) })], CONFIG, NOW)
    const old = labelStore([...store, article({ ...spectacular, publishedAt: daysAgo(28) })], CONFIG, NOW)

    expect(resultFor(young.results, 'a-star').label).toBe('unrated')
    expect(resultFor(old.results, 'a-star').label).toBe('winner')
  })
})

describe('winner', () => {
  it('is earned by clicks well above the store’s own middle article', () => {
    const subject = article({ articleId: 'a-star', current: totals(20, 1000, 12) })
    const { results, baseline } = labelStore([...ordinaryStore(), subject], CONFIG, NOW)

    expect(baseline.medianClicks).toBe(10)
    expect(resultFor(results, 'a-star').label).toBe('winner')
  })

  it('is the same 20 clicks in a busier store that are not enough', () => {
    // The point of "relative to the store's own median": 20 clicks wins in a
    // store whose middle is 10 and does not in a store whose middle is 40.
    const busy = [0, 1, 2, 3].map((n) =>
      article({ articleId: `a-busy-${n}`, current: totals(40, 8000, 6), prior: totals(40, 8000, 6) }),
    )
    const subject = article({ articleId: 'a-star', current: totals(20, 1000, 12) })
    const { results, baseline } = labelStore([...busy, subject], CONFIG, NOW)

    expect(baseline.medianClicks).toBe(40)
    expect(resultFor(results, 'a-star').label).not.toBe('winner')
  })

  it('is earned by a real climb that enough people saw', () => {
    const subject = article({
      articleId: 'a-climber',
      current: totals(3, 1500, 7),
      prior: totals(1, 1400, 12),
    })
    const { results } = labelStore([...ordinaryStore(), subject], CONFIG, NOW)

    expect(resultFor(results, 'a-climber').label).toBe('winner')
  })

  it('is refused to a climb nobody saw', () => {
    // Position 40 to position 7 on an article shown nine times: a lucky day,
    // not a result. Without the impressions floor this is a winner the planner
    // would learn from.
    const subject = article({
      articleId: 'a-fluke',
      current: totals(1, 9, 7),
      prior: totals(0, 4, 40),
    })
    const { results } = labelStore([...ordinaryStore(), subject], CONFIG, NOW)

    expect(resultFor(results, 'a-fluke').label).toBe('neutral')
  })

  it('is refused to every article in a store whose middle article gets no clicks at all', () => {
    // 2 x 0 is 0, and every article has at least zero clicks. Without the
    // "there must be a middle to multiply" guard, a store nobody has found yet
    // reads back as a store of winners.
    const silent = [0, 1, 2, 3].map((n) =>
      article({ articleId: `a-silent-${n}`, current: totals(0, 30, 60), prior: totals(0, 30, 60) }),
    )
    const { results, baseline } = labelStore(silent, CONFIG, NOW)

    expect(baseline.medianClicks).toBe(0)
    expect(results.every((result) => result.label === 'neutral')).toBe(true)
  })
})

describe('underperformer', () => {
  const buried = {
    articleId: 'a-buried',
    publishedAt: daysAgo(200),
    current: totals(1, 800, 45),
    prior: totals(1, 800, 45),
  }

  it('is a store-relative click floor and a position past finding, on an old enough article', () => {
    const { results } = labelStore([...ordinaryStore(), article(buried)], CONFIG, NOW)
    expect(resultFor(results, 'a-buried').label).toBe('underperformer')
  })

  it('is withheld from an article mature enough to grade but not old enough to fail', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ ...buried, publishedAt: daysAgo(89) })],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-buried').label).toBe('neutral')
  })

  it('is withheld from an article that ranks perfectly well and simply gets few clicks', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ ...buried, current: totals(1, 800, 4), prior: totals(1, 800, 4) })],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-buried').label).toBe('neutral')
  })

  it('is withheld from an article we have no position for at all', () => {
    // Never shown is not the same as shown and ignored. Absence of data is not
    // failure, and a merchant told their article underperformed on the strength
    // of no data has been told something false.
    const { results } = labelStore(
      [
        ...ordinaryStore(),
        article({ ...buried, current: totals(0, 0, null), prior: totals(0, 0, null) }),
      ],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-buried').label).toBe('neutral')
  })

  it('loses to a winner when an article could be argued as both', () => {
    // Clicks far below the store's middle, buried at position 45 on the old
    // window — but it has climbed 20 places into a well-seen position this
    // window. That is a story about improvement.
    const { results } = labelStore(
      [
        ...ordinaryStore(),
        article({
          articleId: 'a-turning',
          current: totals(1, 2000, 25),
          prior: totals(1, 800, 45),
        }),
      ],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-turning').label).toBe('winner')
  })
})

/**
 * Each of these plants an article whose figures are a genuine collapse — a real
 * winner or a real failure by the arithmetic — and asserts that no verdict comes
 * out. What is proved is the refusal, not the numbers happening to land on
 * `neutral` anyway.
 */
describe('the articles that are never judged', () => {
  const COLLAPSED = { current: totals(0, 4000, 70), prior: totals(90, 5000, 4) }
  const TRIUMPH = { current: totals(400, 30_000, 2), prior: totals(2, 900, 40) }

  it('an override-published article gets no verdict, however badly it did', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ articleId: 'a-override', publishedViaOverride: true, ...COLLAPSED })],
      CONFIG,
      NOW,
    )
    const overridden = resultFor(results, 'a-override')
    expect(overridden.label).toBe('unrated')
    expect(overridden).toMatchObject({ excludedBecause: ['published_via_override'] })
  })

  it('an override-published article gets no verdict, however well it did', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ articleId: 'a-override', publishedViaOverride: true, ...TRIUMPH })],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-override').label).toBe('unrated')
  })

  it('an article with a repair queued against it gets no verdict', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ articleId: 'a-broken', repairPending: true, ...COLLAPSED })],
      CONFIG,
      NOW,
    )
    const broken = resultFor(results, 'a-broken')
    expect(broken.label).toBe('unrated')
    expect(broken).toMatchObject({ excludedBecause: ['repair_pending'] })
  })

  it('an export article whose address the merchant never confirmed gets no verdict', () => {
    const { results } = labelStore(
      [
        ...ordinaryStore(),
        article({ articleId: 'a-unconfirmed', delivery: 'export', publishedUrl: null, ...COLLAPSED }),
      ],
      CONFIG,
      NOW,
    )
    const unconfirmed = resultFor(results, 'a-unconfirmed')
    expect(unconfirmed.label).toBe('unrated')
    expect(unconfirmed).toMatchObject({ excludedBecause: ['export_url_unconfirmed'] })
  })

  it('an export article whose address the merchant did confirm is judged like any other', () => {
    const { results } = labelStore(
      [
        ...ordinaryStore(),
        article({
          articleId: 'a-confirmed',
          delivery: 'export',
          publishedUrl: 'https://shop.example/blog/confirmed',
          ...TRIUMPH,
        }),
      ],
      CONFIG,
      NOW,
    )
    expect(resultFor(results, 'a-confirmed').label).toBe('winner')
  })

  it('an unpublished draft gets no verdict and has no age', () => {
    const { results } = labelStore(
      [...ordinaryStore(), article({ articleId: 'a-draft', published: false, publishedAt: null })],
      CONFIG,
      NOW,
    )
    const draft = resultFor(results, 'a-draft')
    expect(draft.label).toBe('unrated')
    expect(draft).toMatchObject({ excludedBecause: ['not_published', 'too_young'], ageDays: null })
  })

  it('reports every reason at once rather than the first one found', () => {
    const excluded = labelExclusions(
      article({
        published: false,
        publishedAt: null,
        publishedViaOverride: true,
        repairPending: true,
        delivery: 'export',
        publishedUrl: null,
      }),
      CONFIG,
      NOW,
    )
    expect(excluded).toEqual([
      'not_published',
      'too_young',
      'published_via_override',
      'repair_pending',
      'export_url_unconfirmed',
    ])
  })
})

describe('the store’s own middle article', () => {
  it('is built from the articles that may be graded, so an excluded one cannot move the yardstick', () => {
    // Four ordinary articles at 10 clicks. An override article at 1,000 clicks
    // would drag the median to 25 if it counted, which would demote a genuine
    // 20-click winner to neutral. It must not count.
    const subject = article({ articleId: 'a-star', current: totals(20, 1000, 12) })
    const loud = article({
      articleId: 'a-override',
      publishedViaOverride: true,
      current: totals(1000, 90_000, 1),
      prior: totals(1000, 90_000, 1),
    })

    const { results, baseline } = labelStore([...ordinaryStore(), subject, loud], CONFIG, NOW)

    expect(baseline.medianClicks).toBe(10)
    expect(baseline.ratedN).toBe(5)
    expect(resultFor(results, 'a-star').label).toBe('winner')
  })

  it('counts articles the store was never shown for, rather than lifting the middle past them', () => {
    // Two articles at 10 clicks and two silent ones: the middle is 5, not 10.
    // Dropping the silent ones would raise the bar until only the store's very
    // best cleared it, which is the opposite of judging a store against itself.
    const store = [
      article({ articleId: 'a-seen-0', current: totals(10, 1000, 12) }),
      article({ articleId: 'a-seen-1', current: totals(10, 1000, 12) }),
      article({ articleId: 'a-silent-0', current: totals(0, 0, null) }),
      article({ articleId: 'a-silent-1', current: totals(0, 0, null) }),
    ]
    const { baseline } = labelStore(store, CONFIG, NOW)

    expect(baseline.medianClicks).toBe(5)
  })

  it('is nothing at all for a store with no gradeable article, and no verdict follows from nothing', () => {
    const { results, baseline } = labelStore(
      [article({ articleId: 'a-young', publishedAt: daysAgo(3), current: totals(900, 90_000, 1) })],
      CONFIG,
      NOW,
    )

    expect(baseline).toMatchObject({ medianClicks: null, medianImpressions: null, ratedN: 0 })
    expect(resultFor(results, 'a-young').label).toBe('unrated')
  })
})

describe('what the rest of the loop is handed', () => {
  it('returns one answer per article, in the order they were given', () => {
    const store = [
      article({ articleId: 'a-1' }),
      article({ articleId: 'a-2', publishedViaOverride: true }),
      article({ articleId: 'a-3' }),
    ]
    const { results } = labelStore(store, CONFIG, NOW)
    expect(results.map((result) => result.articleId)).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('hands pattern learning only the graded articles', () => {
    const { results } = labelStore(
      [
        ...ordinaryStore(),
        article({ articleId: 'a-override', publishedViaOverride: true }),
        article({ articleId: 'a-young', publishedAt: daysAgo(5) }),
      ],
      CONFIG,
      NOW,
    )

    const rated = ratedLabels(results)
    expect(rated.map((label) => label.articleId)).toEqual([
      'a-ordinary-0',
      'a-ordinary-1',
      'a-ordinary-2',
      'a-ordinary-3',
    ])
  })

  it('offers no exported way to grade one article without the store it belongs to', async () => {
    // The exclusions and the baseline are the same question, so the module
    // publishes no per-article verdict function a caller could reach for with a
    // baseline of its own choosing. This asserts the shape of the module's
    // exports; it cannot see a caller who reimplements the arithmetic itself.
    const module = await import('./labels')
    expect(Object.keys(module).sort()).toEqual([
      'articleAgeDays',
      'labelExclusions',
      'labelStore',
      'labelWindows',
      'ratedLabels',
    ])
  })
})

describe('labelWindows', () => {
  it('measures the four weeks ending on the store’s last day of data against the four before', () => {
    expect(labelWindows('2026-08-29')).toEqual({
      current: { startDate: '2026-08-02', endDate: '2026-08-29' },
      prior: { startDate: '2026-07-05', endDate: '2026-08-01' },
    })
  })
})
