import { describe, expect, it } from 'vitest'
import {
  aggregatePatterns,
  type LabelledArticle,
  type PatternAxis,
  type PatternConfig,
} from './patterns'

/**
 * The numbers the shipped config carries, restated rather than loaded — the
 * `packages/rules` suite is what holds the file to these values; this suite
 * tests the rule's shape.
 */
const CONFIG: PatternConfig = {
  activationMinRated: 3,
  dominanceShareMin: 0.6667,
  winnerDominantMultiplier: 1.25,
  underperformerDominantMultiplier: 0.8,
  mixedMultiplier: 1.0,
  clampMin: 0.5,
  clampMax: 2.0,
  dimensions: ['intent_class', 'family_id', 'keyword_cluster', 'action_type'],
}

const WEEK_1 = '2026-06-01T00:00:00.000Z'
const WEEK_2 = '2026-06-08T00:00:00.000Z'
const WEEK_3 = '2026-06-15T00:00:00.000Z'

function article(
  articleId: string,
  label: LabelledArticle['label'],
  axes: readonly PatternAxis[],
  labelledAt: string = WEEK_1,
): LabelledArticle {
  return { articleId, label, labelledAt, axes }
}

/** `n` articles on one intent class, all with the same verdict. */
function cohort(
  label: LabelledArticle['label'],
  n: number,
  value = 'buying_guide',
  prefix = 'a',
): LabelledArticle[] {
  return Array.from({ length: n }, (_, i) =>
    article(`${prefix}-${i}`, label, [{ dimension: 'intent_class', value }]),
  )
}

describe('one lucky article is not a pattern', () => {
  it('returns nothing for a group below the activation minimum', () => {
    expect(aggregatePatterns(cohort('winner', CONFIG.activationMinRated - 1), CONFIG)).toEqual([])
  })

  it('returns the group at exactly the activation minimum', () => {
    const records = aggregatePatterns(cohort('winner', CONFIG.activationMinRated), CONFIG)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ dimension: 'intent_class', value: 'buying_guide', ratedN: 3 })
  })

  it('counts articles, not weekly verdicts: one article judged every week for a month is still one article', () => {
    // The recompute writes a fresh row for every article every week, so within
    // the 90-day window one article carries a dozen verdicts. Summing rows
    // would let it clear the minimum by itself — exactly what the minimum is
    // for. Four verdicts, one article, no pattern.
    const oneArticleFourWeeks = [
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_1),
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_2),
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_3),
      article(
        'a-0',
        'winner',
        [{ dimension: 'intent_class', value: 'buying_guide' }],
        '2026-06-22T00:00:00.000Z',
      ),
    ]
    expect(aggregatePatterns(oneArticleFourWeeks, CONFIG)).toEqual([])

    // The same four verdicts spread over three articles is a pattern, so what
    // the assertion above proves is the deduplication and not an inert fixture.
    const threeArticles = [
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_1),
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_2),
      article('a-1', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_2),
      article('a-2', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }], WEEK_2),
    ]
    expect(aggregatePatterns(threeArticles, CONFIG)).toHaveLength(1)
  })

  it('takes each article’s most recent verdict, whatever order the history arrives in', () => {
    // Three articles that were winners in June and underperformers since. The
    // current picture is the recent one; if the older verdicts won, this would
    // come back winner-dominant.
    const history = [
      article('a-0', 'underperformer', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_3),
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_1),
      article('a-1', 'winner', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_1),
      article('a-1', 'underperformer', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_3),
      article('a-2', 'winner', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_1),
      article('a-2', 'underperformer', [{ dimension: 'intent_class', value: 'how_to' }], WEEK_3),
    ]
    expect(aggregatePatterns(history, CONFIG)).toEqual([
      {
        dimension: 'intent_class',
        value: 'how_to',
        ratedN: 3,
        winnerN: 0,
        underperformerN: 3,
        multiplier: CONFIG.underperformerDominantMultiplier,
      },
    ])
  })
})

describe('what a group’s record earns it', () => {
  it('gives a winner-dominant group the winner multiplier', () => {
    const records = aggregatePatterns(cohort('winner', 3), CONFIG)
    expect(records[0]?.multiplier).toBe(CONFIG.winnerDominantMultiplier)
  })

  it('gives an underperformer-dominant group the underperformer multiplier', () => {
    const records = aggregatePatterns(cohort('underperformer', 3), CONFIG)
    expect(records[0]?.multiplier).toBe(CONFIG.underperformerDominantMultiplier)
  })

  it('gives a mixed group no tilt at all', () => {
    const mixed = [
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }]),
      article('a-1', 'neutral', [{ dimension: 'intent_class', value: 'buying_guide' }]),
      article('a-2', 'underperformer', [{ dimension: 'intent_class', value: 'buying_guide' }]),
    ]
    expect(aggregatePatterns(mixed, CONFIG)[0]?.multiplier).toBe(CONFIG.mixedMultiplier)
  })

  it('does not tilt a group that is exactly two-thirds winners, because the shipped share sits above two-thirds', () => {
    // Two winners in three is 0.6666…, which is under the configured 0.6667,
    // so this group reads as mixed. §9.6.3 describes the rule as "≥ ⅔", and a
    // share written as four decimal places of ⅔ rounds the wrong way for it:
    // *every* exactly-two-thirds group is excluded, at any size. At the
    // activation minimum of three that means a group must be unanimous to earn
    // a multiplier at all.
    //
    // Left as it behaves rather than corrected here, for two reasons. The
    // number lives in `packages/rules`, which is another lane's file, and the
    // multiplier reader already shipped in `packages/jobs/generation/replenish.ts`
    // compares the same way against the same value — so nudging only this side
    // would make the two disagree about which patterns are winner-dominant.
    // Raised in `DECISIONS.md`; the fix is one digit in the config.
    const twoInThree = [
      article('a-0', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }]),
      article('a-1', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }]),
      article('a-2', 'neutral', [{ dimension: 'intent_class', value: 'buying_guide' }]),
    ]
    expect(aggregatePatterns(twoInThree, CONFIG)[0]?.multiplier).toBe(CONFIG.mixedMultiplier)

    // And the group one winner larger does tilt, so what the assertion above
    // shows is where the boundary fell and not that the rule never fires.
    const threeInFour = [
      ...twoInThree,
      article('a-3', 'winner', [{ dimension: 'intent_class', value: 'buying_guide' }]),
    ]
    expect(aggregatePatterns(threeInFour, CONFIG)[0]?.multiplier).toBe(
      CONFIG.winnerDominantMultiplier,
    )
  })

  it('counts neutrals towards the group without tilting it', () => {
    // Two winners and four neutrals is a third winners, which is not a lesson.
    const diluted = [
      ...cohort('winner', 2, 'buying_guide', 'w'),
      ...cohort('neutral', 4, 'buying_guide', 'n'),
    ]
    expect(aggregatePatterns(diluted, CONFIG)[0]).toMatchObject({
      ratedN: 6,
      winnerN: 2,
      multiplier: CONFIG.mixedMultiplier,
    })
  })

  it('never stores a multiplier outside the clamp, whatever the config asks for', () => {
    // Inverting the burden: rather than listing the three multipliers somebody
    // remembered, this drives the config to each extreme and asserts the stored
    // number is bounded. A fourth multiplier added to the config later is
    // covered by the same assertion.
    const wild: PatternConfig = {
      ...CONFIG,
      winnerDominantMultiplier: 99,
      underperformerDominantMultiplier: -4,
      mixedMultiplier: 1000,
    }
    const everyKind = [
      ...cohort('winner', 3, 'w-class', 'w'),
      ...cohort('underperformer', 3, 'u-class', 'u'),
      ...[
        article('m-0', 'winner', [{ dimension: 'intent_class', value: 'm-class' }]),
        article('m-1', 'neutral', [{ dimension: 'intent_class', value: 'm-class' }]),
        article('m-2', 'underperformer', [{ dimension: 'intent_class', value: 'm-class' }]),
      ],
    ]
    const records = aggregatePatterns(everyKind, wild)
    expect(records).toHaveLength(3)
    for (const record of records) {
      expect(record.multiplier).toBeGreaterThanOrEqual(CONFIG.clampMin)
      expect(record.multiplier).toBeLessThanOrEqual(CONFIG.clampMax)
    }
  })
})

describe('the axes a pattern can be about', () => {
  it('aggregates each of the four dimensions the config names', () => {
    // Driven from the config rather than a list written here, so an axis added
    // to `packages/rules` and not to the aggregation fails this.
    const articles = CONFIG.dimensions.flatMap((dimension) =>
      Array.from({ length: 3 }, (_, i) =>
        article(`${dimension}-${i}`, 'winner', [{ dimension, value: `v-${dimension}` }]),
      ),
    )
    const records = aggregatePatterns(articles, CONFIG)
    expect(records.map((r) => r.dimension).sort()).toEqual([...CONFIG.dimensions].sort())
  })

  it('produces no rows for an axis the config does not name', () => {
    const config: PatternConfig = { ...CONFIG, dimensions: ['intent_class'] }
    const articles = Array.from({ length: 3 }, (_, i) =>
      article(`a-${i}`, 'winner', [
        { dimension: 'intent_class', value: 'buying_guide' },
        { dimension: 'action_type', value: 'create' },
      ]),
    )
    expect(aggregatePatterns(articles, config).map((r) => r.dimension)).toEqual(['intent_class'])
  })

  it('counts an article once per axis-value even when it lists one twice', () => {
    const articles = Array.from({ length: 3 }, (_, i) =>
      article(`a-${i}`, 'winner', [
        { dimension: 'family_id', value: 'f-1' },
        { dimension: 'family_id', value: 'f-1' },
      ]),
    )
    expect(aggregatePatterns(articles, CONFIG)[0]?.ratedN).toBe(3)
  })

  it('counts an article towards every family it is about', () => {
    const articles = Array.from({ length: 3 }, (_, i) =>
      article(`a-${i}`, 'winner', [
        { dimension: 'family_id', value: 'f-1' },
        { dimension: 'family_id', value: 'f-2' },
      ]),
    )
    expect(aggregatePatterns(articles, CONFIG).map((r) => r.value)).toEqual(['f-1', 'f-2'])
  })

  it('ignores an axis with no value rather than grouping on the empty string', () => {
    const articles = Array.from({ length: 3 }, (_, i) =>
      article(`a-${i}`, 'winner', [{ dimension: 'keyword_cluster', value: '' }]),
    )
    expect(aggregatePatterns(articles, CONFIG)).toEqual([])
  })
})

describe('nothing is learned permanently', () => {
  it('draws the whole picture from the history handed in and nothing else', () => {
    // The function has no memory: the same call with the older half of the
    // history removed forgets the pattern entirely. That is what makes a
    // recompute over the trailing window able to *un*-learn, provided the
    // writer replaces rather than merges — which is the writer's assertion,
    // not this one's, and this test cannot see it.
    const inWindow = cohort('winner', 3, 'seasonal')
    expect(aggregatePatterns(inWindow, CONFIG)).toHaveLength(1)
    expect(aggregatePatterns(inWindow.slice(0, 1), CONFIG)).toEqual([])
  })

  it('orders rows the same way for the same history, whatever order it arrives in', () => {
    const articles = [
      ...cohort('winner', 3, 'z-class', 'z'),
      ...cohort('winner', 3, 'a-class', 'a'),
    ]
    const forwards = aggregatePatterns(articles, CONFIG)
    const backwards = aggregatePatterns([...articles].reverse(), CONFIG)
    expect(forwards).toEqual(backwards)
    expect(forwards.map((r) => r.value)).toEqual(['a-class', 'z-class'])
  })
})

describe('what an excluded article can do here', () => {
  it('has no shape in which it could arrive: the input admits only the three real verdicts', async () => {
    // Invariant 12 — an override-published article is kept out of pattern
    // learning — is held one layer up, where the verdicts are read: an
    // excluded article is `unrated`, and `unrated` is not a member of this
    // module's label type, so there is no value a caller could construct to
    // smuggle one in. That is a compile-time guarantee and this assertion
    // cannot see it; what it can see is that the module offers no second
    // entry point that takes a wider input.
    const module = await import('./patterns')
    expect(Object.keys(module)).toEqual(['aggregatePatterns'])
  })
})
