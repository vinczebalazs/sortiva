import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { silentLogger, type LlmClient, type SeoDataProvider } from '@sortiva/core'
import { accountScope, articlesReadyForDelivery, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DRAFT_PROMPT_MAJOR_VERSION } from './prompts'
import type { PageFetcher } from '@sortiva/providers'
import { DbNotificationEmitter } from '../notify/emitter'
import { runDailyGenerationForAccount } from './daily-cycle'

/**
 * A day's writing that was killed before the store's own midnight, against a
 * real Postgres.
 *
 * Until this existed the product had no path back to such a day at all: the
 * next morning's pass looks for a topic planned for *that* morning, finds
 * nothing, and reports success. The article was paid for, nothing graded it,
 * and nobody was told. These cases are the two halves of the answer — one day
 * is carried to a verdict, and every other one leaves a dead letter so an
 * operator sees that a store lost a day.
 */

const available = await databaseAvailable()

/** Three days, so "before its own day" and "long before its own day" are both reachable. */
const TWO_DAYS_AGO = '2026-09-01'
const YESTERDAY = '2026-09-02'
const TODAY = '2026-09-03'
const at = (date: string) => new Date(`${date}T07:00:00.000Z`)

const CLAIM_PLAN_PROMPT = loadPrompt('claim-plan', 1)
const DRAFT_PROMPT = loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION)
const JUDGE_PROMPT = loadPrompt('judge', 1)
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

describe.skipIf(!available)('a generation run stranded past its own day', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let familyId: string
  let productId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_stranded_sweep')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'stranded@example.com')
    await seedEntitledConnectedStore()
    const seeded = await seedFamily()
    familyId = seeded.familyId
    productId = seeded.productIds[0] as string
  })

  async function seedEntitledConnectedStore(over: { vacationMode?: boolean } = {}) {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db.insert(schema.accountSettings).values({
      accountId,
      timezone: 'UTC',
      draftReview: false,
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

  async function seedFamily(): Promise<{ familyId: string; productIds: string[] }> {
    const id = '11111111-1111-4111-8111-111111111111'
    await db.insert(schema.productFamilies).values({
      id,
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
        .values({ accountId, shopifyProductId: `shopify-${i}`, title: `Bottle ${i}`, familyId: id })
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
    return { familyId: id, productIds }
  }

  async function seedTopic(scheduledDate: string, title: string): Promise<string> {
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

  function enqueueWholeRun(llm: MockLlmClient): void {
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
        productMentions: [{ id: 'p1', productId, refType: 'recommendation', fields: ['price'] }],
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

  function deps(llm: LlmClient, now: Date) {
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
      notifications: new DbNotificationEmitter(db),
      now: () => now,
      logger: silentLogger,
    }
  }

  /** A worker that dies at a named model call — the crash, reproduced. */
  function killAt(inner: MockLlmClient, callType: string): LlmClient {
    return {
      complete: async (request) => {
        if (request.callType === callType) throw new Error(`the worker was killed before ${callType}`)
        return inner.complete(request)
      },
    } as LlmClient
  }

  /**
   * Runs a day and lets it die where a real worker would, leaving the topic
   * flipped to `generating` on a date the next morning never asks about.
   */
  async function strandADay(date: string, title: string, killBefore: 'draft' | 'judge'): Promise<string> {
    const topicId = await seedTopic(date, title)
    const llm = new MockLlmClient()
    enqueueWholeRun(llm)
    await expect(runDailyGenerationForAccount(deps(killAt(llm, killBefore), at(date)), accountId)).rejects.toThrow()
    return topicId
  }

  async function topicState(topicId: string): Promise<string> {
    const [row] = await db
      .select({ state: schema.topics.state })
      .from(schema.topics)
      .where(eq(schema.topics.id, topicId))
    return row!.state
  }

  async function gate3Count(topicId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.gateDecisions.id })
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.topicId, topicId), eq(schema.gateDecisions.gate, 3)))
    return rows.length
  }

  async function deadLetters(): Promise<{ errorClass: string; lastError: string; inputRefs: unknown }[]> {
    const rows = await db
      .select({
        errorClass: schema.jobDlq.errorClass,
        lastError: schema.jobDlq.lastError,
        inputRefs: schema.jobDlq.inputRefs,
      })
      .from(schema.jobDlq)
      .where(eq(schema.jobDlq.accountId, accountId))
    return rows
  }

  /** Runs a day on which nothing is planned — the ordinary quiet day the sweep gets its room from. */
  async function runQuietDay(now = at(TODAY)) {
    const llm = new MockLlmClient()
    enqueueWholeRun(llm)
    return runDailyGenerationForAccount(deps(llm, now), accountId)
  }

  it('finishes the run the next morning, and the article becomes deliverable', async () => {
    const stranded = await strandADay(YESTERDAY, 'Best water bottles', 'judge')
    expect(await gate3Count(stranded)).toBe(0)

    await runQuietDay()

    expect(await gate3Count(stranded)).toBe(1)
    const ready = await articlesReadyForDelivery(db, accountScope(accountId))
    expect(ready).toHaveLength(1)
    expect(ready[0]!.topicId).toBe(stranded)
    expect(await deadLetters()).toEqual([])
  })

  it('leaves the finished article on its own calendar day, and adds no day to the calendar', async () => {
    const stranded = await strandADay(YESTERDAY, 'Best water bottles', 'judge')
    await runQuietDay()

    const rows = await db
      .select({ id: schema.topics.id, date: schema.topics.scheduledDate })
      .from(schema.topics)
      .where(eq(schema.topics.accountId, accountId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(stranded)
    // The day it was scheduled for is the day it stays on: nothing was
    // back-filled onto today, and today gained no entry of its own.
    expect(rows[0]!.date).toBe(YESTERDAY)
  })

  it('finishes the one furthest along and dead-letters the other', async () => {
    // Two crashes on two nights: the older one got as far as a stored draft,
    // the newer one only as far as its article row.
    const withDraft = await strandADay(TWO_DAYS_AGO, 'Best water bottles', 'judge')
    const withoutDraft = await strandADay(YESTERDAY, 'Best insulated flasks', 'draft')

    await runQuietDay()

    expect(await gate3Count(withDraft)).toBe(1)
    expect(await gate3Count(withoutDraft)).toBe(0)

    const dlq = await deadLetters()
    expect(dlq).toHaveLength(1)
    expect(dlq[0]!.errorClass).toBe('generation_run_stranded')
    expect((dlq[0]!.inputRefs as { topic_id: string }).topic_id).toBe(withoutDraft)
    // The entry has to be readable by whoever opens the queue, not just keyed.
    expect(dlq[0]!.lastError).toContain(YESTERDAY)
  })

  it('gives up on a day once, however many mornings come after it', async () => {
    await strandADay(TWO_DAYS_AGO, 'Best water bottles', 'judge')
    await strandADay(YESTERDAY, 'Best insulated flasks', 'draft')

    await runQuietDay()
    await runQuietDay(at('2026-09-04'))
    await runQuietDay(at('2026-09-05'))

    expect(await deadLetters()).toHaveLength(1)
  })

  it('does nothing at all for a store whose generation is stopped', async () => {
    const stranded = await strandADay(YESTERDAY, 'Best water bottles', 'judge')
    await db
      .update(schema.accountSettings)
      .set({ vacationMode: true })
      .where(eq(schema.accountSettings.accountId, accountId))

    const outcome = await runQuietDay()

    expect(outcome).toEqual({ status: 'skipped', reason: 'vacation' })
    expect(await gate3Count(stranded)).toBe(0)
    expect(await deadLetters()).toEqual([])
    expect(await topicState(stranded)).toBe('generating')
  })

  it('leaves a graded article from a past day alone, however long it waits to go out', async () => {
    // A healthy day: written, graded, passed. Its topic stays `generating`
    // until it is published, so nothing but the Gate 3 decision separates it
    // from a run that died — and mistaking one for the other would write the
    // store a second article for a day it already has one for.
    const topicId = await seedTopic(YESTERDAY, 'Best water bottles')
    const llm = new MockLlmClient()
    enqueueWholeRun(llm)
    await runDailyGenerationForAccount(deps(llm, at(YESTERDAY)), accountId)
    expect(await gate3Count(topicId)).toBe(1)

    await runQuietDay()

    expect(await gate3Count(topicId)).toBe(1)
    expect(await deadLetters()).toEqual([])
    const articles = await db
      .select({ id: schema.articles.id })
      .from(schema.articles)
      .where(eq(schema.articles.accountId, accountId))
    expect(articles).toHaveLength(1)
  })

  it("writes today's article as well as finishing yesterday's", async () => {
    const stranded = await strandADay(YESTERDAY, 'Best water bottles', 'judge')
    const todays = await seedTopic(TODAY, 'Best insulated flasks')

    const llm = new MockLlmClient()
    enqueueWholeRun(llm)
    enqueueWholeRun(llm)
    const outcome = await runDailyGenerationForAccount(deps(llm, at(TODAY)), accountId)

    expect(outcome.status).toBe('generated')
    expect(await gate3Count(todays)).toBe(1)
    expect(await gate3Count(stranded)).toBe(1)
    // Both days were carried to a verdict, which is the point: recovering
    // yesterday did not cost the store today. (Both drafts here are the same
    // words, so the second is held by the duplicate-content check — the
    // pipeline doing its job, and nothing to do with the sweep.)
    expect(await deadLetters()).toEqual([])
  })
})
