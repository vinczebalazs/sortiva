import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { QueryCluster, SeoDataProvider } from '@sortiva/core'
import { silentLogger } from '@sortiva/core'
import { accountScope, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { DbExistingTargetCheck } from '../scan'
import { admitManualTopic } from './admit-manual-topic'

/**
 * The manual-add path end to end, against a real Postgres: a topic the
 * merchant typed by hand, run through the same gate a scheduled one would be,
 * with the two things this card's done-when names checked against real rows —
 * a match converting to an OPTIMIZE with a real opportunity id, and a
 * rejection leaving a `gate_decisions` row with `reason_user_facing` behind.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-02T07:00:00.000Z')

describe.skipIf(!available)('the manual-add path, admitted against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_admit_manual_topic')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'admit-manual@example.com')
  })

  /**
   * None of these tests connect Search Console *or* seed a domain/persona,
   * so every account here runs Limited Intelligence — and the existing-target
   * check's own proxy fallback bails out before ever calling the vendor
   * (`findDomainForAccount`/`readPersona` come back empty first). This double
   * exists only to satisfy the type; a call reaching it is this suite's bug.
   */
  const uncalledSeo: SeoDataProvider = {
    keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
    serpTop: () => Promise.reject(new Error('not expected to be called')),
    rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
  }

  function deps() {
    return {
      db,
      existingTargetCheck: new DbExistingTargetCheck({ db, seo: uncalledSeo, now: () => NOW, logger: silentLogger }),
      now: () => NOW,
      logger: silentLogger,
    }
  }

  async function seedFamilyWithSubstance(familyId: string): Promise<void> {
    const scope = accountScope(accountId)
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
      name: 'Trail running shoes',
      groupingSource: 'collection',
      confidence: 'high',
    })

    for (let i = 0; i < 3; i += 1) {
      const [product] = await db
        .insert(schema.products)
        .values({
          accountId: scope.accountId,
          shopifyProductId: `shopify-${i}`,
          title: `Trail Runner ${i}`,
          familyId,
        })
        .returning()
      await db.insert(schema.productFacts).values({
        productId: product!.id,
        factsJson: {
          material: `mesh-and-rubber-${i}`,
          dimensions: `size chart ${i}`,
          weight: `${280 + i}g`,
          capacity: null,
          compatibility: [],
          use_cases_stated: [`trail running variant ${i}`],
          care: 'wipe clean',
          variant_axes: [],
          price_range: null,
          certifications: [],
          origin: null,
          verifiable_claims: [`grip tested to variant ${i}`],
          fluff_discarded: true,
          fact_count: 6,
        },
        factCount: 6,
        fluffDiscarded: 1,
        promptVersion: 'v1',
        modelId: 'test-model',
      })
    }
  }

  function cluster(familyId: string, overrides: Partial<QueryCluster> = {}): QueryCluster {
    return {
      head: 'best trail running shoes',
      members: [],
      intentClass: 'buying_guide',
      familyIds: [familyId],
      ...overrides,
    }
  }

  it('admits a clean manual topic and logs an admitted gate decision', async () => {
    const familyId = '11111111-1111-4111-8111-111111111111'
    await seedFamilyWithSubstance(familyId)
    await db.insert(schema.keywords).values({
      accountId,
      term: 'best trail running shoes',
      language: 'en',
      country: 'us',
      volume: rules().defaults.gates.demand_floor.monthly_search_volume_min * 2,
      source: 'manual',
    })

    const result = await admitManualTopic(deps(), {
      accountId,
      title: 'Best trail running shoes for wide feet',
      cluster: cluster(familyId),
      scheduledDate: '2026-03-10',
    })

    expect(result.outcome).toBe('planned')
    expect(result.topic).not.toBeNull()
    expect(result.topic?.state).toBe('planned')
    expect(result.topic?.opportunityId).toBeTruthy()

    const decisions = await db.select().from(schema.gateDecisions).where(eq(schema.gateDecisions.accountId, accountId))
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.outcome).toBe('admitted')
    expect(decisions[0]?.reasonUserFacing).toBeNull()
  })

  it('warns rather than rejects a manual topic with no measured demand', async () => {
    const familyId = '22222222-2222-4222-8222-222222222222'
    await seedFamilyWithSubstance(familyId)

    const result = await admitManualTopic(deps(), {
      accountId,
      title: 'A very niche topic',
      cluster: cluster(familyId, { head: 'a very niche search' }),
      scheduledDate: '2026-03-11',
    })

    expect(result.outcome).toBe('planned_with_warning')
    expect(result.warning?.templateKey).toBe('gate1.rejected_zero_volume')
    expect(result.topic?.state).toBe('planned')
  })

  it('rejects a manual topic that maps to nothing the store sells, and logs why', async () => {
    await db.insert(schema.keywords).values({
      accountId,
      term: 'unrelated topic',
      language: 'en',
      country: 'us',
      volume: rules().defaults.gates.demand_floor.monthly_search_volume_min * 2,
      source: 'manual',
    })

    const result = await admitManualTopic(deps(), {
      accountId,
      title: 'Something off catalog',
      cluster: { head: 'unrelated topic', members: [], intentClass: 'informational', familyIds: [] },
      scheduledDate: '2026-03-12',
    })

    expect(result.outcome).toBe('rejected')
    expect(result.topic).toBeNull()
    expect(result.rejection?.templateKey).toBe('gate1.rejected_off_catalog')

    const decisions = await db.select().from(schema.gateDecisions).where(eq(schema.gateDecisions.accountId, accountId))
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.outcome).toBe('rejected_off_catalog')
    expect(decisions[0]?.reasonUserFacing).toBe('gate1.rejected_off_catalog')

    const topics = await db.select().from(schema.topics).where(eq(schema.topics.accountId, accountId))
    expect(topics).toHaveLength(1)
    expect(topics[0]?.state).toBe('rejected_by_gate')
    expect(decisions[0]?.topicId).toBe(topics[0]?.id)
  })

  it('converts a manual topic that matches an inventory page into an OPTIMIZE, with a real opportunity id', async () => {
    const familyId = '33333333-3333-4333-8333-333333333333'
    await db.insert(schema.storePages).values({
      accountId,
      url: 'https://shop.example/collections/trail-running',
      pageType: 'collection',
      familyIds: [familyId],
      intentClass: 'buying_guide',
    })

    const result = await admitManualTopic(deps(), {
      accountId,
      title: 'Best trail running shoes',
      cluster: cluster(familyId),
      scheduledDate: '2026-03-13',
    })

    expect(result.outcome).toBe('converted')
    expect(result.topic).toBeNull()
    expect(result.convertedToOpportunityId).toBeTruthy()

    const opportunities = await db.select().from(schema.opportunities).where(eq(schema.opportunities.accountId, accountId))
    expect(opportunities).toHaveLength(1)
    expect(opportunities[0]?.id).toBe(result.convertedToOpportunityId)
    expect(opportunities[0]?.recommendedAction).toBe('optimize')
    expect(opportunities[0]?.signalType).toBe('cannibalization')

    // A second manual attempt at the same page reuses the open opportunity
    // rather than fighting it for the dedupe index (invariant 10).
    const again = await admitManualTopic(deps(), {
      accountId,
      title: 'Best trail running shoes (again)',
      cluster: cluster(familyId),
      scheduledDate: '2026-03-14',
    })
    expect(again.convertedToOpportunityId).toBe(result.convertedToOpportunityId)
    const stillOne = await db.select().from(schema.opportunities).where(eq(schema.opportunities.accountId, accountId))
    expect(stillOne).toHaveLength(1)
  })
})
