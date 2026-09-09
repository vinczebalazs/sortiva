import { describe, expect, it } from 'vitest'
import {
  OPTIMIZE_OUTCOME_KEY,
  optimizeOutcomeJson,
  optimizeOutcomeLabel,
  readOptimizeOutcome,
  storeMedianImpressions,
  type OptimizeOutcomeConfig,
  type OptimizeWindowTotals,
} from './outcome'
import { readRepairOutcome, repairOutcome } from '../repair'

/**
 * The verdict on a page four weeks after a merchant said they did the work.
 *
 * These cases are all about the two ways a verdict can lie. It can call a
 * collapse a success, because a page losing four fifths of its impressions
 * posts a better click-through on what remains. And it can call an accident a
 * success, because a page nobody is shown swings twenty ranking places on one
 * lucky day. The guard against the first is the impressions floor; the guard
 * against the second is the store's own median, which is also what makes the
 * whole thing work identically for a shop with forty clicks a month and one
 * with forty thousand.
 */

const CONFIG: OptimizeOutcomeConfig = {
  improved_position_delta_min: 2,
  improved_ctr_relative_delta_min: 0.2,
  impressions_not_collapsed_ratio_min: 0.5,
}

function totals(
  clicks: number,
  impressions: number,
  position: number | null,
): OptimizeWindowTotals {
  return { clicks, impressions, position }
}

describe('the verdict on a page whose owner did the work', () => {
  it('calls a ranking gain improved when the page carries the store\'s ordinary traffic', () => {
    // Click-through is 4% in both windows, deliberately: the only thing that
    // moved is the ranking, so this and the two cases after it isolate that
    // route rather than passing on a click-through gain nobody asked about.
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 11.4),
        after: totals(44, 1100, 8.1),
        storeMedian: 900,
        config: CONFIG,
      }),
    ).toBe('improved')
  })

  it('calls the same ranking gain neutral on a page below the store\'s own middle', () => {
    // Identical arithmetic to the case above — a 3.3-place gain on unchanged
    // click-through — and the only
    // thing that changed is that this store's other pages are busier. That is
    // the whole of "relative to the store's own median": the page has to matter
    // to *this* store before a ranking move is treated as a result.
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 11.4),
        after: totals(44, 1100, 8.1),
        storeMedian: 5000,
        config: CONFIG,
      }),
    ).toBe('neutral')
  })

  it('judges a forty-click store and a forty-thousand-click store by the same rule', () => {
    // The two stores differ by three orders of magnitude and nothing else. Both
    // pages sit at their own store's middle and both moved the same distance,
    // so both get the same word.
    const small = optimizeOutcomeLabel({
      before: totals(4, 100, 12),
      after: totals(5, 125, 9),
      storeMedian: 100,
      config: CONFIG,
    })
    const large = optimizeOutcomeLabel({
      before: totals(4000, 100_000, 12),
      after: totals(5000, 125_000, 9),
      storeMedian: 100_000,
      config: CONFIG,
    })
    expect([small, large]).toEqual(['improved', 'improved'])
  })

  it('refuses a ranking gain on a store that has no middle to be measured against', () => {
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 11.4),
        after: totals(44, 1100, 8.1),
        storeMedian: null,
        config: CONFIG,
      }),
    ).toBe('neutral')
  })

  it('calls a click-through gain improved when impressions held up', () => {
    // 4% to 5.2%: a 30% relative gain, on impressions that barely moved.
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 9),
        after: totals(52, 1000, 9),
        storeMedian: 5000,
        config: CONFIG,
      }),
    ).toBe('improved')
  })

  it('does not call a page that lost four fifths of its impressions a win', () => {
    // 4% to 10% click-through, which any rule reading CTR alone would call a
    // triumph. It is a page Google stopped showing.
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 9),
        after: totals(20, 200, 9),
        storeMedian: 100,
        config: CONFIG,
      }),
    ).toBe('worse')
  })

  it('calls a real decline worse', () => {
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 8),
        after: totals(38, 950, 14),
        storeMedian: 900,
        config: CONFIG,
      }),
    ).toBe('worse')
  })

  it('calls a page that barely moved neutral', () => {
    expect(
      optimizeOutcomeLabel({
        before: totals(40, 1000, 9),
        after: totals(42, 1020, 8.5),
        storeMedian: 900,
        config: CONFIG,
      }),
    ).toBe('neutral')
  })

  it('does not treat a page that was never ranked as having improved to the top', () => {
    // A null position means "never shown". Subtracting it as though it were
    // zero would read as an improvement from first place, and this page — which
    // went from invisible to five clicks — would be recorded as a success on
    // arithmetic that means nothing.
    //
    // What it gets instead is `neutral`, which is this function's way of saying
    // it cannot tell. That is as far as this case reaches: it does **not**
    // prove the merchant sees no verdict, because `neutral` is a verdict. The
    // thing that stops it being written at all is the empty before window, and
    // that lives in the job rather than here — `measure.test.ts` covers it
    // against a real database.
    expect(
      optimizeOutcomeLabel({
        before: totals(0, 0, null),
        after: totals(5, 100, 4),
        storeMedian: 50,
        config: CONFIG,
      }),
    ).toBe('neutral')
  })
})

describe('the store\'s own middle', () => {
  it('is the middle of the pages the store was actually shown for', () => {
    expect(
      storeMedianImpressions([totals(0, 10, 9), totals(0, 100, 9), totals(0, 1000, 9)]),
    ).toBe(100)
  })

  it('ignores pages nobody was shown, which would otherwise drag it to nothing', () => {
    expect(
      storeMedianImpressions([
        totals(0, 0, null),
        totals(0, 0, null),
        totals(0, 0, null),
        totals(0, 100, 9),
        totals(0, 1000, 9),
      ]),
    ).toBe(550)
  })

  it('is null for a store with no shown pages at all', () => {
    expect(storeMedianImpressions([totals(0, 0, null)])).toBeNull()
  })
})

describe('what gets written into the opportunity row', () => {
  const measured = {
    measured: true,
    action: 'optimize',
    label: 'improved',
    pageUrl: 'https://shop.example/collections/boots',
    beforeWindow: { startDate: '2026-08-03', endDate: '2026-08-30' },
    afterWindow: { startDate: '2026-09-01', endDate: '2026-09-28' },
    before: totals(40, 1000, 11.4),
    after: totals(60, 1100, 8.1),
    storeMedianImpressions: 900,
    measuredAt: '2026-09-29T00:00:00.000Z',
  } as const

  it('puts the three fields the drawer and the performance table already read at the top level', () => {
    // Those two screens were built against this column before anything wrote
    // to it: the drawer wants `label`, `before` and `after`, and the
    // performance table wants `label`. Writing anywhere else would leave both
    // showing nothing for a page we did measure.
    expect(optimizeOutcomeJson(measured)).toMatchObject({
      label: 'improved',
      before: 40,
      after: 60,
    })
  })

  it('writes no label at all when there was nothing to measure', () => {
    const json = optimizeOutcomeJson({
      measured: false,
      action: 'optimize',
      reason: 'page_no_longer_in_store',
      pageUrl: 'https://shop.example/collections/boots',
      measuredAt: '2026-09-29T00:00:00.000Z',
    })
    // The absence is the point. Both screens read `label` and neither has any
    // other way to tell "we could not look" from "it went badly", so the only
    // honest answer is to give them nothing to render.
    expect(json).not.toHaveProperty('label')
    expect(json).not.toHaveProperty('before')
    expect(json).not.toHaveProperty('after')
    expect(readOptimizeOutcome(json)?.measured).toBe(false)
  })

  it('sits beside a repair log on the same row without either erasing the other', () => {
    // A repair and a measurement can both land on one opportunity. Merged the
    // way the database merges them, which is what the repository does.
    const repair = repairOutcome({
      kind: 'product_deleted',
      route: 'mechanical_auto',
      repairedAt: '2026-09-10T00:00:00.000Z',
      references: [],
    })
    const merged = { ...repair, ...optimizeOutcomeJson(measured) }

    expect(readRepairOutcome(merged)?.repairedAt).toBe('2026-09-10T00:00:00.000Z')
    expect(readOptimizeOutcome(merged)?.action).toBe('optimize')
    expect(Object.keys(merged)).toContain(OPTIMIZE_OUTCOME_KEY)
  })

  it('reads back nothing from a row that only holds a repair', () => {
    const repair = repairOutcome({
      kind: 'product_deleted',
      route: 'mechanical_auto',
      repairedAt: '2026-09-10T00:00:00.000Z',
      references: [],
    })
    expect(readOptimizeOutcome(repair)).toBeUndefined()
  })
})
