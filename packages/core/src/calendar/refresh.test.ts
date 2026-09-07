import { rules } from '@sortiva/rules'
import { describe, expect, it } from 'vitest'
import { standardCurve } from '../search/ctr-curve'
import {
  MERCHANT_REQUEST_BLOCKERS,
  isRefreshCandidate,
  merchantRefreshBlockers,
  rankRefreshCandidates,
  refreshBlockers,
  refreshExpectedGain,
  withinRefreshCooldown,
  type RefreshCandidateFacts,
  type RefreshEligibilityConfig,
} from './refresh'

const config: RefreshEligibilityConfig = {
  positionMin: rules().defaults.learning.refresh.position_min,
  positionMax: rules().defaults.learning.refresh.position_max,
  cooldownDays: rules().defaults.learning.refresh.cooldown_days,
}

const NOW = '2026-09-07T00:00:00.000Z'

/** An article that qualifies on every rule, so each test can break exactly one thing. */
function eligible(overrides: Partial<RefreshCandidateFacts> = {}): RefreshCandidateFacts {
  return {
    articleId: 'art_1',
    published: true,
    publishedViaOverride: false,
    lastRefreshedAt: null,
    repairPending: false,
    meanPosition: 8,
    impressions: 4000,
    storeMedianImpressions: 1200,
    ...overrides,
  }
}

describe('which of our own articles may be rewritten', () => {
  it('admits a published article inside the band, above the store middle, never refreshed', () => {
    expect(refreshBlockers(eligible(), config, NOW)).toEqual([])
    expect(isRefreshCandidate(eligible(), config, NOW)).toBe(true)
  })

  it('refuses an article refreshed 30 days ago and admits the same one at 60', () => {
    const thirtyDaysAgo = '2026-08-08T00:00:00.000Z'
    expect(refreshBlockers(eligible({ lastRefreshedAt: thirtyDaysAgo }), config, NOW)).toEqual([
      'within_cooldown',
    ])

    // 2026-07-09 is 60 days before 2026-09-07: the cooldown has run out to the day.
    const sixtyDaysAgo = '2026-07-09T00:00:00.000Z'
    expect(refreshBlockers(eligible({ lastRefreshedAt: sixtyDaysAgo }), config, NOW)).toEqual([])
  })

  it('measures the cooldown in whole days, so an hour either side of the deadline does not decide it', () => {
    const justInside = '2026-07-09T23:00:00.000Z'
    expect(withinRefreshCooldown(justInside, NOW, config.cooldownDays)).toBe(true)
    expect(withinRefreshCooldown(null, NOW, config.cooldownDays)).toBe(false)
  })

  it('refuses a page Google puts too far down to be worth editing, and one already high enough', () => {
    expect(refreshBlockers(eligible({ meanPosition: 22 }), config, NOW)).toContain('position_outside_band')
    expect(refreshBlockers(eligible({ meanPosition: 2 }), config, NOW)).toContain('position_outside_band')
    expect(refreshBlockers(eligible({ meanPosition: 5 }), config, NOW)).toEqual([])
    expect(refreshBlockers(eligible({ meanPosition: 15 }), config, NOW)).toEqual([])
  })

  it('refuses an article shown less often than this store’s middle article', () => {
    expect(
      refreshBlockers(eligible({ impressions: 900, storeMedianImpressions: 1200 }), config, NOW),
    ).toEqual(['impressions_below_store_median'])
    expect(
      refreshBlockers(eligible({ impressions: 1200, storeMedianImpressions: 1200 }), config, NOW),
    ).toEqual([])
  })

  it('refuses an article the merchant published over our objection', () => {
    expect(refreshBlockers(eligible({ publishedViaOverride: true }), config, NOW)).toEqual([
      'published_via_override',
    ])
  })

  it('refuses an article already queued for a factual repair', () => {
    expect(refreshBlockers(eligible({ repairPending: true }), config, NOW)).toEqual(['repair_pending'])
  })

  it('refuses an article that is not live', () => {
    expect(refreshBlockers(eligible({ published: false }), config, NOW)).toEqual(['not_published'])
  })

  it('treats a missing measurement as a failure to clear the rule, never as a pass', () => {
    const noSearchData = eligible({ meanPosition: null, impressions: null, storeMedianImpressions: null })
    expect(refreshBlockers(noSearchData, config, NOW)).toEqual([
      'position_outside_band',
      'impressions_below_store_median',
    ])
  })

  it('reports every reason at once rather than stopping at the first', () => {
    const bad = eligible({
      published: false,
      publishedViaOverride: true,
      repairPending: true,
      lastRefreshedAt: '2026-09-01T00:00:00.000Z',
      meanPosition: 40,
      impressions: 1,
      storeMedianImpressions: 1000,
    })
    expect(refreshBlockers(bad, config, NOW)).toHaveLength(6)
  })
})

describe('what a merchant pressing the button is refused for', () => {
  it('is refused inside the cooldown', () => {
    expect(
      merchantRefreshBlockers(eligible({ lastRefreshedAt: '2026-08-08T00:00:00.000Z' }), config, NOW),
    ).toEqual(['within_cooldown'])
  })

  it('is not refused for ranking too low or being shown too little — they asked for this one', () => {
    const unpromising = eligible({ meanPosition: 40, impressions: 5, storeMedianImpressions: 5000 })
    expect(refreshBlockers(unpromising, config, NOW).length).toBe(2)
    expect(merchantRefreshBlockers(unpromising, config, NOW)).toEqual([])
  })

  it('is still refused for the three rules that protect the merchant from us', () => {
    expect(MERCHANT_REQUEST_BLOCKERS).toEqual([
      'not_published',
      'published_via_override',
      'repair_pending',
      'within_cooldown',
    ])
    expect(merchantRefreshBlockers(eligible({ repairPending: true }), config, NOW)).toEqual([
      'repair_pending',
    ])
    expect(merchantRefreshBlockers(eligible({ publishedViaOverride: true }), config, NOW)).toEqual([
      'published_via_override',
    ])
  })
})

describe('what a rewrite is worth', () => {
  const curve = standardCurve(rules().defaults.ctr_curve)
  const targetPosition = rules().defaults.scoring.existing_page.striking_distance_target_position

  it('ranks a busy page near the front above a quiet page further back', () => {
    const busyNear = refreshExpectedGain({ impressions: 10000, currentPosition: 6, targetPosition, curve })
    const quietFar = refreshExpectedGain({ impressions: 800, currentPosition: 12, targetPosition, curve })
    expect(busyNear).not.toBeNull()
    expect(quietFar).not.toBeNull()
    expect(busyNear!).toBeGreaterThan(quietFar!)
  })

  it('never reports a negative gain for a page already better than the target', () => {
    expect(refreshExpectedGain({ impressions: 10000, currentPosition: 1, targetPosition, curve })).toBe(0)
  })

  it('says nothing rather than zero when there is no curve to read', () => {
    expect(
      refreshExpectedGain({ impressions: 10000, currentPosition: 6, targetPosition, curve: {} }),
    ).toBeNull()
  })

  it('orders the pool best first, and orders it the same way twice', () => {
    const pool = [
      { articleId: 'c', expectedGain: 70 },
      { articleId: 'a', expectedGain: 590 },
      { articleId: 'b', expectedGain: 590 },
    ]
    expect(rankRefreshCandidates(pool).map((c) => c.articleId)).toEqual(['a', 'b', 'c'])
    expect(rankRefreshCandidates([...pool].reverse()).map((c) => c.articleId)).toEqual(['a', 'b', 'c'])
  })
})
