import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import type { ExistingTargetOutcome, QueryCluster } from '../contracts/opportunities'
import type { SubstanceInventory } from '../signals/substance'
import { runGate1, type Gate1Input } from './gate1'

/**
 * The table this card exists for: every combination of Gate 1's five checks,
 * against the one thing that matters — does a topic get admitted, held,
 * rejected, or converted, and does every non-clean answer carry a reason the
 * merchant can read main §8.6's rejection card from.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111'
const gates = rules().defaults.gates

const cluster: QueryCluster = {
  head: 'best trail running shoes',
  members: ['trail running shoes best'],
  intentClass: 'buying_guide',
  familyIds: [FAMILY],
}

const passingSubstance: SubstanceInventory = {
  familyIds: [FAMILY],
  distinctFacts: gates.substance_floor.distinct_facts_min,
  contributingProducts: gates.substance_floor.contributing_products_min,
  productsConsidered: gates.substance_floor.contributing_products_min,
  passes: true,
  clearsWithMargin: false,
  shortfalls: [],
}

const failingSubstance: SubstanceInventory = {
  ...passingSubstance,
  distinctFacts: 1,
  contributingProducts: 1,
  passes: false,
  shortfalls: [
    { productId: 'p1', title: 'Trail Runner', familyId: FAMILY, populatedFields: 1, missingFields: ['material'] },
  ],
}

const noMatch: ExistingTargetOutcome = { match: 'none' }
const weakMatch: ExistingTargetOutcome = {
  match: 'weak',
  url: 'https://shop.example/products/old-trail-shoe',
  action: 'CREATE_WITH_LINK',
  via: 'content_mapping',
}
const strongOptimizeMatch: ExistingTargetOutcome = {
  match: 'strong',
  url: 'https://shop.example/collections/trail-running',
  action: 'OPTIMIZE',
  via: 'gsc',
  position: 6.2,
}
const strongRefreshMatch: ExistingTargetOutcome = {
  match: 'strong',
  url: 'https://shop.example/blog/best-trail-shoes',
  action: 'REFRESH',
  via: 'content_mapping',
}

function input(overrides: Partial<Gate1Input> = {}): Gate1Input {
  return {
    cluster,
    monthlySearchVolume: 500,
    pinned: false,
    manual: false,
    winnability: gates.winnability.minimum + 0.1,
    limitedIntelligence: false,
    substance: passingSubstance,
    existingTarget: noMatch,
    gates,
    fetchedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('Gate 1 — a clean candidate', () => {
  it('is admitted with no reason card', () => {
    const result = runGate1(input())
    expect(result.outcome).toBe('admitted')
    expect(result.admitted).toBe(true)
    expect(result.reasonCard).toBeNull()
    expect(result.conversion).toBeNull()
    expect(result.linkTask).toBeNull()
  })
})

describe('Gate 1 — demand floor', () => {
  const rows: { name: string; volume: number | null; pinned: boolean; manual: boolean; expect: string }[] = [
    { name: 'well above the floor', volume: gates.demand_floor.monthly_search_volume_min * 2, pinned: false, manual: false, expect: 'admitted' },
    { name: 'exactly at the floor', volume: gates.demand_floor.monthly_search_volume_min, pinned: false, manual: false, expect: 'admitted' },
    { name: 'below the floor, auto', volume: gates.demand_floor.monthly_search_volume_min - 1, pinned: false, manual: false, expect: 'rejected_zero_volume' },
    { name: 'unknown volume, auto', volume: null, pinned: false, manual: false, expect: 'rejected_zero_volume' },
    { name: 'below the floor, pinned', volume: 0, pinned: true, manual: false, expect: 'admitted_pinned_despite_zero_volume' },
    { name: 'below the floor, manual (not pinned)', volume: 0, pinned: false, manual: true, expect: 'admitted_with_warning' },
    { name: 'below the floor, manual and pinned', volume: 0, pinned: true, manual: true, expect: 'admitted_pinned_despite_zero_volume' },
  ]

  for (const row of rows) {
    it(row.name, () => {
      const result = runGate1(input({ monthlySearchVolume: row.volume, pinned: row.pinned, manual: row.manual }))
      expect(result.outcome).toBe(row.expect)
    })
  }

  it('rejection carries a reason card that retries on the next search scan', () => {
    const result = runGate1(input({ monthlySearchVolume: 1, manual: false }))
    expect(result.reasonCard?.templateKey).toBe('gate1.rejected_zero_volume')
    expect(result.reasonCard?.retryCondition).toBe('on_next_search_scan')
  })

  it('the manual warning still carries a reason card, and the topic is admitted', () => {
    const result = runGate1(input({ monthlySearchVolume: 0, manual: true }))
    expect(result.admitted).toBe(true)
    expect(result.reasonCard?.templateKey).toBe('gate1.rejected_zero_volume')
  })
})

describe('Gate 1 — winnability', () => {
  it('rejects below the minimum, manual or not', () => {
    const below = gates.winnability.minimum - 0.01
    expect(runGate1(input({ winnability: below, manual: false })).outcome).toBe('rejected_not_winnable')
    expect(runGate1(input({ winnability: below, manual: true })).outcome).toBe('rejected_not_winnable')
  })

  it('admits at exactly the minimum', () => {
    expect(runGate1(input({ winnability: gates.winnability.minimum })).outcome).toBe('admitted')
  })

  it('is not softened by a zero-volume manual warning already pending', () => {
    const result = runGate1(
      input({ monthlySearchVolume: 0, manual: true, winnability: gates.winnability.minimum - 0.01 }),
    )
    expect(result.outcome).toBe('rejected_not_winnable')
  })
})

describe('Gate 1 — intent & commercial relevance', () => {
  it('rejects a cluster mapped to nothing the store sells', () => {
    const result = runGate1(input({ cluster: { ...cluster, familyIds: [] } }))
    expect(result.outcome).toBe('rejected_off_catalog')
    expect(result.reasonCard?.retryCondition).toBe('on_catalog_update')
  })
})

describe('Gate 1 — substance inventory', () => {
  it('holds a topic whose mapped families do not say enough yet', () => {
    const result = runGate1(input({ substance: failingSubstance }))
    expect(result.outcome).toBe('held_insufficient_substance')
    expect(result.admitted).toBe(false)
    expect(result.reasonCard?.retryCondition).toBe('on_catalog_update')
    expect(result.reasonCard?.params.products_needing_detail).toBe(1)
  })
})

describe('Gate 1 — existing-target / cannibalization check (main §7.7, same function)', () => {
  it('a strong OPTIMIZE match converts, and admits nothing', () => {
    const result = runGate1(input({ existingTarget: strongOptimizeMatch }))
    expect(result.outcome).toBe('converted_to_optimize')
    expect(result.admitted).toBe(false)
    expect(result.conversion).toEqual({
      action: 'optimize',
      url: strongOptimizeMatch.url,
      via: 'gsc',
      position: 6.2,
    })
    expect(result.reasonCard?.redirectUrl).toBe(strongOptimizeMatch.url)
    expect(result.reasonCard?.retryCondition).toBe('never')
  })

  it('a strong REFRESH match converts to a refresh, not an optimize', () => {
    const result = runGate1(input({ existingTarget: strongRefreshMatch }))
    expect(result.outcome).toBe('converted_to_refresh')
    expect(result.conversion?.action).toBe('refresh')
  })

  it('a weak match does not block admission, and carries a link task', () => {
    const result = runGate1(input({ existingTarget: weakMatch }))
    expect(result.outcome).toBe('admitted')
    expect(result.admitted).toBe(true)
    expect(result.linkTask).toEqual({ existingUrl: weakMatch.url, via: 'content_mapping' })
  })

  it('no match admits cleanly with no link task', () => {
    const result = runGate1(input({ existingTarget: noMatch }))
    expect(result.linkTask).toBeNull()
    expect(result.conversion).toBeNull()
  })

  it('a strong match wins even over a pending manual zero-volume warning', () => {
    const result = runGate1(input({ existingTarget: strongOptimizeMatch, monthlySearchVolume: 0, manual: true }))
    expect(result.outcome).toBe('converted_to_optimize')
  })
})

describe('Gate 1 — evidence', () => {
  it('always carries the keyword, intent class and existing-target match strength', () => {
    const result = runGate1(input())
    const keys = result.evidence.map((fact) => fact.key)
    expect(keys).toContain('keyword')
    expect(keys).toContain('intent_class')
    expect(keys).toContain('existing_target_match')
    for (const fact of result.evidence) expect(fact.fetchedAt).toBe('2026-03-01T00:00:00.000Z')
  })
})
