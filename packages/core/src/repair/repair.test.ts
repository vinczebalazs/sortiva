import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import {
  buildDriftOpportunity,
  driftFromCatalogChangeKind,
  driftPolicies,
  driftPolicyFor,
  driftTasks,
  factOverlap,
  outOfStockLongEnough,
  pickInFamilyEquivalent,
  planRepair,
  readRepairOutcome,
  repairOutcome,
  routeRepair,
  routeWritesToShop,
  type DriftObservation,
  type SubstituteCandidate,
} from './index'
import { axesFromSections, sectionsFor } from '../generation/shapes'

const scoring = rules().defaults.scoring

function observation(over: Partial<DriftObservation> = {}): DriftObservation {
  return {
    accountId: 'acc-1',
    articleId: 'art-1',
    articleTitle: 'Best water bottles',
    kind: 'product_deleted',
    references: [
      {
        placeholderKey: 'p1',
        productId: 'prod-1',
        productTitle: 'Steel bottle 750',
        refType: 'recommendation',
      },
    ],
    occurredAt: '2026-09-01T10:00:00.000Z',
    ...over,
  }
}

describe('the drift policy table', () => {
  it('has no price row: a price change queues nothing', () => {
    expect(driftPolicies().map((policy) => policy.kind)).toEqual([
      'product_deleted',
      'product_out_of_stock',
      'family_axes_changed',
      'collection_deleted',
    ])
  })

  it('reads a price change out of the store as drift of no kind at all', () => {
    expect(driftFromCatalogChangeKind('price_changed')).toBeUndefined()
  })

  it('reads stock moving as no drift on its own — only a fortnight of it counts', () => {
    expect(driftFromCatalogChangeKind('availability_changed')).toBeUndefined()
  })

  it('reads a withdrawn product as a broken reference', () => {
    expect(driftFromCatalogChangeKind('product_deleted')).toBe('product_deleted')
    expect(driftPolicyFor('product_deleted')).toEqual({
      kind: 'product_deleted',
      queue: 'repair',
      signalType: 'broken_product_reference',
    })
  })

  it('sends a range whose attributes moved to the rewriting queue', () => {
    expect(driftPolicyFor('family_axes_changed').queue).toBe('refresh')
  })
})

describe('how long unbuyable is too long', () => {
  const config = rules().defaults.signals.product_change_impact.out_of_stock_days_min
  const now = new Date('2026-09-20T00:00:00.000Z')

  it('does not count a product that has only just gone out of stock', () => {
    expect(outOfStockLongEnough(new Date('2026-09-15T00:00:00.000Z'), now, config)).toBe(false)
  })

  it('counts one that has been unbuyable for the configured stretch', () => {
    expect(outOfStockLongEnough(new Date('2026-09-01T00:00:00.000Z'), now, config)).toBe(true)
  })

  it('counts nothing when we cannot say when the stock last moved', () => {
    expect(outOfStockLongEnough(null, now, config)).toBe(false)
  })
})

describe('choosing a stand-in for a withdrawn product', () => {
  const overlapMin = rules().defaults.signals.broken_product_reference.substitute_fact_overlap_min
  const gone = { productId: 'prod-1', familyId: 'fam-1', factKeys: ['material', 'capacity', 'lid'] }

  const candidate = (over: Partial<SubstituteCandidate>): SubstituteCandidate => ({
    productId: 'prod-2',
    title: 'Steel bottle 500',
    familyId: 'fam-1',
    available: true,
    factKeys: ['material', 'capacity', 'lid'],
    ...over,
  })

  it('measures overlap against what we knew about the product that went', () => {
    expect(factOverlap(['a', 'b'], ['a', 'b', 'c'])).toBe(1)
    expect(factOverlap(['a', 'b'], ['a'])).toBe(0.5)
    expect(factOverlap([], ['a'])).toBe(0)
  })

  it('takes the closest match in the same family', () => {
    const choice = pickInFamilyEquivalent(
      gone,
      [
        candidate({ productId: 'prod-2', factKeys: ['material', 'capacity'] }),
        candidate({ productId: 'prod-3', title: 'Steel bottle 1000', factKeys: ['material', 'capacity', 'lid'] }),
      ],
      overlapMin,
    )
    expect(choice?.productId).toBe('prod-3')
    expect(choice?.overlap).toBe(1)
  })

  it('will not stand a product in from another family', () => {
    expect(
      pickInFamilyEquivalent(gone, [candidate({ familyId: 'fam-2' })], overlapMin),
    ).toBeUndefined()
  })

  it('will not stand in something nobody can buy either', () => {
    expect(
      pickInFamilyEquivalent(gone, [candidate({ available: false })], overlapMin),
    ).toBeUndefined()
  })

  it('refuses a product too unlike the one that went', () => {
    expect(
      pickInFamilyEquivalent(gone, [candidate({ factKeys: ['colour'] })], overlapMin),
    ).toBeUndefined()
  })

  it('picks the same one every time when two are equally close', () => {
    const twins = [
      candidate({ productId: 'prod-9' }),
      candidate({ productId: 'prod-3' }),
    ]
    expect(pickInFamilyEquivalent(gone, twins, overlapMin)?.productId).toBe('prod-3')
    expect(pickInFamilyEquivalent(gone, [...twins].reverse(), overlapMin)?.productId).toBe('prod-3')
  })
})

describe('who does the repair', () => {
  it('mends and republishes for a store that asked us to publish', () => {
    expect(
      routeRepair('product_deleted', {
        delivery: 'auto',
        autoRepair: true,
        substituteAvailable: true,
      }),
    ).toEqual({ action: 'FIX', route: 'mechanical_auto', reason: 'swap_in_family' })
  })

  it('never touches the shop of a store that publishes by downloading', () => {
    const routing = routeRepair('product_deleted', {
      delivery: 'export',
      autoRepair: true,
      substituteAvailable: true,
    })
    expect(routing.route).toBe('action_card')
    expect(routeWritesToShop(routing.route)).toBe(false)
  })

  it('hands a card to a store that switched automatic repair off', () => {
    expect(
      routeRepair('product_deleted', {
        delivery: 'auto',
        autoRepair: false,
        substituteAvailable: true,
      }).route,
    ).toBe('action_card')
  })

  it('sends a repair with nothing to swap in back through writing and grading', () => {
    expect(
      routeRepair('product_deleted', {
        delivery: 'auto',
        autoRepair: true,
        substituteAvailable: false,
      }),
    ).toEqual({ action: 'REFRESH', route: 'gate3_refresh', reason: 'no_in_family_substitute' })
  })

  it('never mends a long-unbuyable recommendation mechanically, however the store publishes', () => {
    for (const delivery of ['auto', 'export'] as const) {
      expect(
        routeRepair('product_out_of_stock', {
          delivery,
          autoRepair: true,
          substituteAvailable: true,
        }).route,
      ).toBe('gate3_refresh')
    }
  })
})

describe('the repair as an opportunity', () => {
  const context = {
    rulesVersion: 'test-rules',
    detectedAt: '2026-09-04T00:00:00.000Z',
    limitedIntelligence: false,
  }

  it('names the article, so two broken articles are two cards', () => {
    const first = planRepair(
      observation(),
      { delivery: 'auto', autoRepair: true, substituteAvailable: true },
      context,
      scoring,
    ).draft
    const second = planRepair(
      observation({ articleId: 'art-2' }),
      { delivery: 'auto', autoRepair: true, substituteAvailable: true },
      context,
      scoring,
    ).draft
    expect(first.entityType).toBe('article')
    expect(first.entityRef).toBe('art-1')
    expect(second.entityRef).toBe('art-2')
  })

  it('carries evidence stamped with where every fact came from', () => {
    const draft = buildDriftOpportunity(
      observation(),
      { ...context, routing: routeRepair('product_deleted', { delivery: 'auto', autoRepair: true, substituteAvailable: true }) },
      scoring,
    )
    expect(draft.evidence.length).toBeGreaterThan(0)
    for (const fact of draft.evidence) {
      expect(fact.source).toBe('catalog')
      expect(fact.fetchedAt).toBe(context.detectedAt)
    }
    expect(draft.evidence.map((fact) => fact.key)).toContain('reference_p1')
  })

  it('is accepted on sight rather than waiting for an opinion', () => {
    const draft = buildDriftOpportunity(
      observation(),
      { ...context, routing: routeRepair('product_deleted', { delivery: 'auto', autoRepair: true, substituteAvailable: true }) },
      scoring,
    )
    expect(draft.status).toBe('accepted')
    expect(draft.recommendedAction).toBe('FIX')
    expect(draft.rulesVersion).toBe('test-rules')
    expect(draft.reasonTemplateKey).toBe('broken_product_reference.fix')
  })

  it('asks the merchant to download the repaired version when it may not touch their site', () => {
    const routing = routeRepair('product_deleted', {
      delivery: 'export',
      autoRepair: true,
      substituteAvailable: true,
    })
    const tasks = driftTasks(observation(), routing)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.kind).toBe('repair_reference')
    expect(tasks[0]!.description).toContain('Download the repaired version')
  })

  it('asks for a calendar slot when the prose itself has to change', () => {
    const routing = routeRepair('product_out_of_stock', {
      delivery: 'auto',
      autoRepair: true,
      substituteAvailable: true,
    })
    const tasks = driftTasks(observation({ kind: 'product_out_of_stock' }), routing)
    expect(tasks[0]!.kind).toBe('schedule_topic')
  })

  it('ranks an article with three broken recommendations above one with a single mention', () => {
    const many = planRepair(
      observation({
        references: ['p1', 'p2', 'p3'].map((placeholderKey) => ({
          placeholderKey,
          productId: placeholderKey,
          productTitle: placeholderKey,
          refType: 'recommendation' as const,
        })),
      }),
      { delivery: 'auto', autoRepair: true, substituteAvailable: true },
      context,
      scoring,
    ).draft
    const one = planRepair(
      observation(),
      { delivery: 'auto', autoRepair: true, substituteAvailable: true },
      context,
      scoring,
    ).draft
    expect(many.rawScore).toBeGreaterThan(one.rawScore)
  })
})

describe('the repair log', () => {
  it('sits under its own key so a later outcome can be written beside it', () => {
    const outcome = {
      ...repairOutcome({
        kind: 'product_deleted',
        route: 'mechanical_auto',
        repairedAt: '2026-09-04T00:00:00.000Z',
        references: [
          {
            placeholderKey: 'p1',
            fromProductId: 'prod-1',
            fromProductTitle: 'Steel bottle 750',
            toProductId: 'prod-3',
            toProductTitle: 'Steel bottle 1000',
            overlap: 1,
          },
        ],
        revisionN: 1,
      }),
      measured: 'something the learning loop wrote',
    }
    const record = readRepairOutcome(outcome)
    expect(record?.references[0]?.fromProductTitle).toBe('Steel bottle 750')
    expect(record?.references[0]?.toProductTitle).toBe('Steel bottle 1000')
    expect(outcome.measured).toBe('something the learning loop wrote')
  })

  it('reads nothing out of an outcome that holds no repair', () => {
    expect(readRepairOutcome(null)).toBeUndefined()
    expect(readRepairOutcome({ measured: 'x' })).toBeUndefined()
  })
})

describe('the axes an article was built around', () => {
  it('reads back exactly what the section names were built from', () => {
    const sections = sectionsFor('buying_guide', ['terrain', 'drop'])
    expect(axesFromSections(sections)).toEqual(['terrain', 'drop'])
  })

  it('reads nothing off a shape whose sections never named an axis', () => {
    expect(axesFromSections(sectionsFor('how_to', ['terrain']))).toEqual([])
  })
})
