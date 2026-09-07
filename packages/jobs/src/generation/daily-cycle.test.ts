import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ACCOUNT_PAUSED_FLAG,
  silentLogger,
  type LlmClient,
  type SeoDataProvider,
} from '@sortiva/core'
import { accountScope, articlesReadyForDelivery, schema, tripAccountFlag, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from './prompts'
import type { PageFetcher } from '@sortiva/providers'
import { DbNotificationEmitter } from '../notify/emitter'
import { runDailyGenerationForAccount } from './daily-cycle'

/**
 * The day's article, against a real Postgres. This is where this card's own
 * done-when criteria are actually checked:
 *
 *  - a day with nothing planned writes nothing, and tomorrow's topic is
 *    untouched afterwards;
 *  - an unpaid account, a merchant on holiday and a raised kill switch each
 *    stop the day before anything is spent;
 *  - two passes on one day dequeue once;
 *  - an account that asked to see drafts first gets one waiting in `in_review`.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T07:00:00.000Z')
const TODAY = '2026-09-03'
const TOMORROW = '2026-09-04'

const CLAIM_PLAN_PROMPT = loadPrompt('claim-plan', 1)
const DRAFT_PROMPT = loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION)
const JUDGE_PROMPT = loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION)
const CONTRADICTION_PROMPT = loadPrompt('contradiction', 1)
const REVISE_PROMPT = loadPrompt('revise', 1)

const seo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: async () => ({
    data: [
      { position: 1, url: 'https://rival.example/guide', domain: 'rival.example', title: 'Water bottle guide' },
    ],
    meta: { endpoint: 'serp_top', cacheHit: false, billable: true, usdCost: 0.01 },
  }),
  rankedKeywords: () => Promise.reject(new Error('not expected to be called')),
}

const pageFetcher: PageFetcher = {
  fetch: async (request) => ({
    finalUrl: request.url,
    status: 200,
    contentType: 'text/html',
    body: '<h1>Water bottle buying guide</h1><p>Look for a wide mouth and a leakproof lid when choosing a bottle.</p>',
    bytes: 200,
    chain: [request.url],
    headers: {},
  }),
}

describe.skipIf(!available)('the daily generation cycle', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_daily_cycle')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'daily-cycle@example.com')
    await seedEntitledConnectedStore()
  })

  /** A paid-up store with a live Shopify connection, a confirmed profile and default settings. */
  async function seedEntitledConnectedStore(over: { draftReview?: boolean; vacationMode?: boolean } = {}) {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db.insert(schema.accountSettings).values({
      accountId,
      timezone: 'UTC',
      draftReview: over.draftReview ?? false,
      vacationMode: over.vacationMode ?? false,
    })
    await db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: `store-${accountId.slice(0, 8)}.myshopify.com`,
      accessToken: 'cipher',
      grantedScopes: ['read_products'],
    })
    await db.insert(schema.personas).values({
      accountId,
      description: 'A shop selling reusable water bottles.',
      productCategories: ['bottles'],
      language: 'en',
      country: 'US',
      promptVersion: 'v1',
      modelId: 'test-model',
    })
  }

  /** The same shoe-shaped fixture `generate-article.test.ts` uses: enough distinct facts to clear Gate 2. */
  async function seedFamily(): Promise<{ familyId: string; productIds: string[] }> {
    const familyId = '11111111-1111-4111-8111-111111111111'
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId,
      name: 'Water bottles',
      differentiationAxes: ['capacity'],
      groupingSource: 'collection',
      confidence: 'high',
    })
    const productIds: string[] = []
    const materials = ['stainless steel', 'glass', 'tritan plastic']
    const origins = ['Germany', 'Portugal', 'Vietnam']
    for (let i = 0; i < 3; i += 1) {
      const [product] = await db
        .insert(schema.products)
        .values({ accountId, shopifyProductId: `shopify-${i}`, title: `Bottle ${i}`, familyId })
        .returning()
      productIds.push(product!.id)
      await db.insert(schema.productFacts).values({
        productId: product!.id,
        factsJson: {
          material: materials[i],
          dimensions: null,
          weight: null,
          capacity: null,
          compatibility: [],
          use_cases_stated: [],
          care: null,
          variant_axes: [],
          price_range: null,
          certifications: [],
          origin: origins[i],
          verifiable_claims: [],
          fluff_discarded: false,
          fact_count: 2,
        },
        factCount: 2,
        fluffDiscarded: 0,
        promptVersion: 'v1',
        modelId: 'test-model',
      })
    }
    return { familyId, productIds }
  }

  async function seedTopic(familyId: string, scheduledDate: string, title = 'Best water bottles'): Promise<string> {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `${title}|${scheduledDate}`,
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'scheduled',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    const [topic] = await db
      .insert(schema.topics)
      .values({
        accountId,
        opportunityId: opportunity!.id,
        title,
        targetKeyword: title.toLowerCase(),
        intentClass: 'buying_guide',
        familyIds: [familyId],
        kind: 'new',
        source: 'auto',
        scheduledDate,
        state: 'planned',
      })
      .returning()
    return topic!.id
  }

  function enqueueWholeRun(llm: MockLlmClient, productMentionProductId: string): void {
    llm.enqueue(
      'claim_plan',
      JSON.stringify({
        claims: [
          {
            text: 'For everyday use, the stainless steel bottle is the safer pick.',
            kind: 'recommendation',
            confidence: 'medium',
            evidenceRefs: ['c1'],
            quote: null,
          },
        ],
        gaps: [],
      }),
    )
    llm.enqueue(
      'draft',
      JSON.stringify({
        title: 'Best water bottles: a buying guide',
        metaDescription: 'How to choose a water bottle, by material and capacity.',
        intro:
          'For most kitchens, the stainless steel bottle is the right default[[c1]]. It survives being dropped, it does not hold flavours from yesterday, and it keeps a cold drink cold through an afternoon. Glass suits someone who cares about taste and is careful with a bottle; plastic suits someone for whom weight settles it.',
        sections: [
          {
            heading: 'The decision',
            body: 'Two things decide this: what the bottle is made of, and where it was made[[c1]][[c2]]. Everything else — lid design, colour, finish — follows from those and matters far less in daily use. Work out which of the three materials suits how you actually drink, then narrow down within it.',
          },
          {
            heading: 'Selection criteria: by capacity',
            body: 'Larger sizes suit long days away from a tap, and smaller ones fit a bag and a hand better[[c7]]. If the bottle spends its life on a desk, size is close to irrelevant; if it goes in a rucksack, it decides whether you refill once or three times.',
          },
          {
            heading: 'Recommended types',
            body: 'Steel resists dents and holds temperature well[[c1]]. Glass gives the cleanest taste and is the one to avoid if it will be knocked about. Plastic weighs least of the three, and replacing one costs little when it eventually wears out.',
          },
          {
            heading: 'Common mistakes',
            body: 'The usual one is picking a bottle before checking that the lid seals. The second is buying for a use case you do not have — a vacuum-insulated flask is wasted on someone who refills at a desk twice a day.',
          },
          {
            heading: 'Products',
            body: 'The {{p1}} is a solid all-rounder for someone who has not settled on a preference yet.',
          },
        ],
        faq: [],
        productMentions: [{ id: 'p1', productId: productMentionProductId, refType: 'recommendation', fields: ['price'] }],
      }),
    )
    const scores = {
      informationGain: 4,
      factualGrounding: 4,
      searchIntentMatch: 3,
      actionability: 3,
      languageQuality: 3,
      ecommerceUsefulness: 3,
    }
    llm.enqueue(
      'judge',
      JSON.stringify({
        scores,
        justifications: Object.fromEntries(Object.keys(scores).map((k) => [k, `graded on ${k}`])),
      }),
    )
  }

  function deps(llm: LlmClient) {
    return {
      db,
      pool: ctx.pool,
      llm,
      seo,
      pageFetcher,
      claimPlanPrompt: CLAIM_PLAN_PROMPT,
      draftPrompt: DRAFT_PROMPT,
      judgePrompt: JUDGE_PROMPT,
      contradictionPrompt: CONTRADICTION_PROMPT,
      revisePrompt: REVISE_PROMPT,
      // The real bell against the real tables, not a double: the thing worth
      // proving is that a retried day writes one row, and that is the unique
      // constraint's job rather than a stub's.
      notifications: new DbNotificationEmitter(db),
      now: () => NOW,
      logger: silentLogger,
    }
  }

  /** A model client that answers normally until the named call type, then dies — a crash mid-pipeline. */
  function failAfter(inner: MockLlmClient, callType: string): LlmClient {
    return {
      complete: async (request) => {
        if (request.callType === callType) throw new Error('the judge went down')
        return inner.complete(request)
      },
    } as LlmClient
  }

  async function topicStates(): Promise<Record<string, string>> {
    const rows = await db
      .select({ date: schema.topics.scheduledDate, state: schema.topics.state })
      .from(schema.topics)
      .where(eq(schema.topics.accountId, accountId))
    return Object.fromEntries(rows.map((r) => [r.date, r.state]))
  }

  it('writes nothing on a day with nothing planned, and leaves tomorrow alone', async () => {
    const { familyId } = await seedFamily()
    await seedTopic(familyId, TOMORROW, 'Tomorrow topic')

    const llm = new MockLlmClient()
    const result = await runDailyGenerationForAccount(deps(llm), accountId)

    expect(result).toEqual({ status: 'skipped', reason: 'no_topic_today' })
    // Nothing was spent: the model was never reached.
    expect(llm.callCount).toBe(0)
    // Done-when: the future topic is untouched — not pulled forward, not flipped.
    expect(await topicStates()).toEqual({ [TOMORROW]: 'planned' })
    const articles = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(articles).toHaveLength(0)
  })

  /**
   * The day an article belongs to is the day it appears on the shop, not the
   * day it was written. A Berlin store publishing at 02:00 starts writing at
   * 20:00 the evening before; the topic it must take is the *next* day's,
   * because that is the day a reader sees the article. Taking the evening's own
   * date would leave the calendar and the shop permanently one day apart.
   */
  it('takes the topic for the day the article will appear on, not the evening it is written', async () => {
    await db
      .update(schema.accountSettings)
      .set({ timezone: 'Europe/Berlin', publishHour: 2 })
      .where(eq(schema.accountSettings.accountId, accountId))

    const { familyId, productIds } = await seedFamily()
    await seedTopic(familyId, '2026-09-02', 'The evening we are writing on')
    await seedTopic(familyId, '2026-09-03', 'The day it appears on')

    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productIds[0]!)
    // 18:00 UTC on the 2nd is 20:00 in Berlin — six hours before 02:00 on the 3rd.
    const evening = new Date('2026-09-02T18:00:00.000Z')
    const result = await runDailyGenerationForAccount({ ...deps(llm), now: () => evening }, accountId)

    expect(result.status).toBe('generated')
    const states = await topicStates()
    expect(states['2026-09-02']).toBe('planned')
    expect(states['2026-09-03']).not.toBe('planned')

    const [article] = await db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.accountId, accountId))
    const [taken] = await db
      .select()
      .from(schema.topics)
      .where(eq(schema.topics.id, article!.topicId))
    expect(taken!.scheduledDate).toBe('2026-09-03')
  })

  it('stops before spending anything when the payment failed', async () => {
    const { familyId } = await seedFamily()
    await seedTopic(familyId, TODAY)
    await db
      .update(schema.subscriptions)
      .set({ status: 'past_due' })
      .where(eq(schema.subscriptions.accountId, accountId))

    const llm = new MockLlmClient()
    expect(await runDailyGenerationForAccount(deps(llm), accountId)).toEqual({
      status: 'skipped',
      reason: 'not_entitled',
    })
    expect(llm.callCount).toBe(0)
    expect(await topicStates()).toEqual({ [TODAY]: 'planned' })
  })

  it('stops while the merchant is away', async () => {
    const { familyId } = await seedFamily()
    await seedTopic(familyId, TODAY)
    await db
      .update(schema.accountSettings)
      .set({ vacationMode: true })
      .where(eq(schema.accountSettings.accountId, accountId))

    const llm = new MockLlmClient()
    expect(await runDailyGenerationForAccount(deps(llm), accountId)).toEqual({
      status: 'skipped',
      reason: 'vacation',
    })
    expect(llm.callCount).toBe(0)
  })

  it('stops on a raised kill switch, which is also how a spend cap stops it', async () => {
    const { familyId } = await seedFamily()
    await seedTopic(familyId, TODAY)
    await tripAccountFlag(db, accountScope(accountId), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'spend_cap_sweep',
      reason: 'daily spend over the hard cap',
      trippedBy: 'auto',
    })

    const llm = new MockLlmClient()
    expect(await runDailyGenerationForAccount(deps(llm), accountId)).toMatchObject({
      status: 'skipped',
      reason: 'paused',
    })
    expect(llm.callCount).toBe(0)
  })

  it('stops when the store connection has been lost', async () => {
    const { familyId } = await seedFamily()
    await seedTopic(familyId, TODAY)
    await db
      .update(schema.shopifyConns)
      .set({ invalidatedAt: NOW })
      .where(eq(schema.shopifyConns.accountId, accountId))

    const llm = new MockLlmClient()
    expect(await runDailyGenerationForAccount(deps(llm), accountId)).toEqual({
      status: 'skipped',
      reason: 'shopify_disconnected',
    })
    expect(llm.callCount).toBe(0)
  })

  it('dequeues once across two passes on the same day, and spends once', async () => {
    const { familyId, productIds } = await seedFamily()
    await seedTopic(familyId, TODAY)
    await seedTopic(familyId, TOMORROW, 'Tomorrow topic')

    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productIds[0]!)

    const first = await runDailyGenerationForAccount(deps(llm), accountId)
    expect(first).toMatchObject({ status: 'generated', outcome: 'graded' })
    const callsAfterFirst = llm.callCount
    expect(callsAfterFirst).toBe(3)

    // The second pass finds the day's work already recorded under its derived
    // key and hands back what the first produced — no second article, no
    // second model call.
    const second = await runDailyGenerationForAccount(deps(llm), accountId)
    expect(second).toMatchObject({ status: 'already_done', outcome: 'graded' })
    expect(llm.callCount).toBe(callsAfterFirst)

    const articles = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(articles).toHaveLength(1)
    // Tomorrow is still tomorrow's.
    expect((await topicStates())[TOMORROW]).toBe('planned')
  })

  it('lands the draft in review when the merchant asked to see drafts first', async () => {
    await db
      .update(schema.accountSettings)
      .set({ draftReview: true })
      .where(eq(schema.accountSettings.accountId, accountId))
    const { familyId, productIds } = await seedFamily()
    const topicId = await seedTopic(familyId, TODAY)

    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productIds[0]!)

    const result = await runDailyGenerationForAccount(deps(llm), accountId)
    expect(result).toMatchObject({ status: 'generated', outcome: 'graded', awaitsReview: true })

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(article!.state).toBe('in_review')
    const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
    expect(topic!.state).toBe('in_review')
  })

  /**
   * `draft` is the state an article sits in before it is graded as well as
   * after it passes, so the state alone cannot answer "is this ready to go
   * out". Everything downstream has to ask both questions at once.
   */
  it('tells a graded-and-passed draft apart from one that was never graded', async () => {
    const { familyId, productIds } = await seedFamily()
    await seedTopic(familyId, TODAY)

    // A half-written article from a run that died before the judge: `draft`,
    // with a body, and no Gate 3 decision.
    const dying = new MockLlmClient()
    enqueueWholeRun(dying, productIds[0]!)
    await expect(
      runDailyGenerationForAccount({ ...deps(dying), llm: failAfter(dying, 'judge') }, accountId),
    ).rejects.toThrow()

    const stranded = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(stranded[0]!.state).toBe('draft')
    expect(await articlesReadyForDelivery(db, accountScope(accountId))).toEqual([])

    // Now finish it. Same state on the row, opposite answer.
    const retry = new MockLlmClient()
    enqueueWholeRun(retry, productIds[0]!)
    await runDailyGenerationForAccount(deps(retry), accountId)

    const ready = await articlesReadyForDelivery(db, accountScope(accountId))
    expect(ready.map((a) => a.id)).toEqual([stranded[0]!.id])
    expect(ready[0]!.state).toBe('draft')
  })

  it('does not offer a draft that is still waiting for the merchant', async () => {
    await db
      .update(schema.accountSettings)
      .set({ draftReview: true })
      .where(eq(schema.accountSettings.accountId, accountId))
    const { familyId, productIds } = await seedFamily()
    await seedTopic(familyId, TODAY)

    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productIds[0]!)
    await runDailyGenerationForAccount(deps(llm), accountId)

    expect(await articlesReadyForDelivery(db, accountScope(accountId))).toEqual([])
  })

  /**
   * The crash cases. The queue delivers at least once, so both of these
   * happen for real, and both used to cost a second article's worth of model
   * calls and leave a stray row behind.
   */
  describe('after a crash', () => {
    it('finishes a run that died mid-pipeline instead of stranding the day', async () => {
      const { familyId, productIds } = await seedFamily()
      const topicId = await seedTopic(familyId, TODAY)

      // A first attempt that reached the writer and then died: the topic is
      // `generating`, so the ordinary dequeue would never look at it again.
      const dying = new MockLlmClient()
      enqueueWholeRun(dying, productIds[0]!)
      await expect(
        runDailyGenerationForAccount(
          { ...deps(dying), llm: failAfter(dying, 'judge') },
          accountId,
        ),
      ).rejects.toThrow('the judge went down')

      const [halfDone] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
      expect(halfDone!.state).toBe('draft')
      expect(halfDone!.bodyJson).not.toBeNull()
      expect((await topicStates())[TODAY]).toBe('generating')

      // The retry. It adopts the article the first attempt wrote rather than
      // starting a second one, and it does not pay the writer again.
      const retry = new MockLlmClient()
      enqueueWholeRun(retry, productIds[0]!)
      const result = await runDailyGenerationForAccount(deps(retry), accountId)
      expect(result).toMatchObject({ status: 'generated', outcome: 'graded' })

      const articles = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
      expect(articles).toHaveLength(1)
      expect(articles[0]!.id).toBe(halfDone!.id)
      // No `…-2` slug, because there is no second article to need one.
      expect(articles[0]!.slug).toBe(halfDone!.slug)
      expect(result).toMatchObject({ articleId: halfDone!.id })

      // The writer was not called again: the stored draft still stood up
      // against the claims this run approved, so only the plan and the judge
      // ran. The claim plan is re-run because Gate 3 grades against it.
      expect(retry.calls.map((c) => c.callType)).toEqual(['claim_plan', 'judge'])

      // One claim plan on the article, not two.
      const claims = await db
        .select()
        .from(schema.articleClaims)
        .where(eq(schema.articleClaims.articleId, halfDone!.id))
      expect(claims.length).toBeGreaterThan(0)
      const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
      expect(topic!.state).toBe('generating')
    })

    it('leaves the day alone once it has been recorded as done', async () => {
      const { familyId, productIds } = await seedFamily()
      await seedTopic(familyId, TODAY)

      const llm = new MockLlmClient()
      enqueueWholeRun(llm, productIds[0]!)
      await runDailyGenerationForAccount(deps(llm), accountId)

      // A third and fourth delivery of the same job. Neither runs anything.
      await runDailyGenerationForAccount(deps(llm), accountId)
      const last = await runDailyGenerationForAccount(deps(llm), accountId)
      expect(last.status).toBe('already_done')
      expect(llm.callCount).toBe(3)
    })
  })

  it('leaves a passing draft ready for delivery when review is off', async () => {
    const { familyId, productIds } = await seedFamily()
    const topicId = await seedTopic(familyId, TODAY)

    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productIds[0]!)

    const result = await runDailyGenerationForAccount(deps(llm), accountId)
    expect(result).toMatchObject({ status: 'generated', awaitsReview: false })

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(article!.state).toBe('draft')
    const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
    expect(topic!.state).toBe('generating')
  })

  /**
   * Telling the merchant a draft is waiting. Without this, switching draft
   * review on made the day's article simply stop appearing: it sat in review
   * and nothing said so.
   */
  describe('the draft-is-waiting notification', () => {
    async function bell(): Promise<{ type: string; dedupeKey: string; payload: unknown }[]> {
      const rows = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.accountId, accountId))
      return rows.map((r) => ({ type: r.type, dedupeKey: r.dedupeKey, payload: r.payloadJson }))
    }

    async function withDraftReviewOn(): Promise<void> {
      await db
        .update(schema.accountSettings)
        .set({ draftReview: true })
        .where(eq(schema.accountSettings.accountId, accountId))
    }

    it('rings once for a draft that is waiting, and does not ring again on a redelivered day', async () => {
      await withDraftReviewOn()
      const { familyId, productIds } = await seedFamily()
      await seedTopic(familyId, TODAY)

      const llm = new MockLlmClient()
      enqueueWholeRun(llm, productIds[0]!)
      await runDailyGenerationForAccount(deps(llm), accountId)

      const [article] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
      expect(await bell()).toEqual([
        {
          type: 'draft_ready_for_review',
          // The article's own id, so the same draft can only ever be
          // announced once however many times the job is delivered.
          dedupeKey: article!.id,
          // References, never words: the headline is looked up when the bell
          // is rendered.
          payload: { article_id: article!.id },
        },
      ])

      await runDailyGenerationForAccount(deps(llm), accountId)
      expect(await bell()).toHaveLength(1)
    })

    it('says nothing on a store that never asked to review drafts', async () => {
      const { familyId, productIds } = await seedFamily()
      await seedTopic(familyId, TODAY)

      const llm = new MockLlmClient()
      enqueueWholeRun(llm, productIds[0]!)
      await runDailyGenerationForAccount(deps(llm), accountId)

      expect(await bell()).toEqual([])
    })

    /**
     * The race main §8.7 describes: the merchant vetoes the topic while the
     * article is being written. The move into review then matches nothing and
     * the draft is already gone — telling them it is waiting would be telling
     * them something untrue about an article they threw away.
     */
    it('says nothing when the draft was discarded while it was being written', async () => {
      await withDraftReviewOn()
      const { familyId, productIds } = await seedFamily()
      await seedTopic(familyId, TODAY)

      const llm = new MockLlmClient()
      enqueueWholeRun(llm, productIds[0]!)
      // The veto lands after the article exists and before the run reaches the
      // review transition.
      const vetoedMidRun = {
        complete: async (request: Parameters<LlmClient['complete']>[0]) => {
          const answer = await llm.complete(request)
          if (request.callType === 'judge') {
            await db
              .update(schema.articles)
              .set({ state: 'discarded' })
              .where(eq(schema.articles.accountId, accountId))
          }
          return answer
        },
      } as LlmClient

      await runDailyGenerationForAccount(deps(vetoedMidRun), accountId)

      const [article] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
      expect(article!.state).toBe('discarded')
      expect(await bell()).toEqual([])
    })
  })
})
