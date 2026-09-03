import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { silentLogger, type SeoDataProvider } from '@sortiva/core'
import { accountScope, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DbExistingTargetCheck } from '../scan'
import { addManualTopic } from './add-manual-topic'

/**
 * The founder-authorised real path for `POST /api/calendar/topics`: a typed
 * title classified by one model call, then run through the same Gate 1 the
 * manual-add path already had (`admitManualTopic`). See DECISIONS
 * 2026-09-03 T4.2.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-02T07:00:00.000Z')
const PROMPT = loadPrompt('topic-classify', 1)

describe.skipIf(!available)('addManualTopic against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_add_manual_topic')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'add-manual-topic@example.com')
  })

  const uncalledSeo: SeoDataProvider = {
    keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
    serpTop: () => Promise.reject(new Error('not expected to be called')),
    rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
  }

  function deps(llm: MockLlmClient) {
    return {
      db,
      llm,
      prompt: PROMPT,
      existingTargetCheck: new DbExistingTargetCheck({ db, seo: uncalledSeo, now: () => NOW, logger: silentLogger }),
      now: () => NOW,
      logger: silentLogger,
    }
  }

  async function seedFamily(): Promise<string> {
    const familyId = '11111111-1111-4111-8111-111111111111'
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
        .values({ accountId: scope.accountId, shopifyProductId: `shopify-${i}`, title: `Trail Runner ${i}`, familyId })
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
    return familyId
  }

  it('classifies a typed title with a real model call and admits it through Gate 1', async () => {
    const familyId = await seedFamily()
    await db.insert(schema.keywords).values({
      accountId,
      term: 'best trail running shoes for wide feet',
      language: 'en',
      country: 'us',
      volume: 5000,
      source: 'manual',
    })

    const llm = new MockLlmClient()
    llm.enqueue(
      'topic_classify',
      JSON.stringify({
        head: 'best trail running shoes for wide feet',
        members: [],
        intentClass: 'buying_guide',
        familyIds: [familyId],
      }),
    )

    const result = await addManualTopic(deps(llm), {
      accountId,
      title: 'Best trail running shoes for wide feet',
      scheduledDate: '2026-03-10',
    })

    expect(result.outcome).toBe('planned')
    expect(result.topic?.familyIds).toEqual([familyId])
    expect(result.topic?.intentClass).toBe('buying_guide')
    expect(llm.countOf('topic_classify')).toBe(1)
  })

  it('drops a family id the model invented, and the store the merchant does not have', async () => {
    await seedFamily()
    const llm = new MockLlmClient()
    llm.enqueue(
      'topic_classify',
      JSON.stringify({
        head: 'best trail running shoes',
        members: [],
        intentClass: 'buying_guide',
        familyIds: ['99999999-9999-4999-8999-999999999999'],
      }),
    )

    const result = await addManualTopic(deps(llm), {
      accountId,
      title: 'Best trail running shoes',
      scheduledDate: '2026-03-11',
    })

    // Off-catalog: the only family id the model returned was filtered out as
    // not belonging to this account, so the cluster maps to nothing.
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.templateKey).toBe('gate1.rejected_off_catalog')
  })

  it('degrades to pause rather than guessing when the model call fails, writing nothing', async () => {
    const llm = new MockLlmClient()
    // No enqueue and no default: MockLlmClient throws for an unanswered call type.

    const result = await addManualTopic(deps(llm), {
      accountId,
      title: 'Best trail running shoes',
      scheduledDate: '2026-03-12',
    })

    expect(result.outcome).toBe('rejected')
    expect(result.topic).toBeNull()
    expect(result.rejection?.templateKey).toBe('appendixA.outage')

    const topics = await db.select().from(schema.topics).where(eq(schema.topics.accountId, accountId))
    expect(topics).toHaveLength(0)
    const decisions = await db.select().from(schema.gateDecisions).where(eq(schema.gateDecisions.accountId, accountId))
    expect(decisions).toHaveLength(0)
  })
})
