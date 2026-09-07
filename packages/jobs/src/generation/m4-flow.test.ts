import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { silentLogger, type SeoDataProvider } from '@sortiva/core'
import { schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from './prompts'
import type { PageFetcher } from '@sortiva/providers'
import { DbOpportunitySource } from '../scan/opportunity-source'
import { replenishCalendarForAccount } from './replenish'
import { runDailyGenerationForAccount } from './daily-cycle'

/**
 * The milestone, end to end, on one synthetic store: an accepted opportunity
 * becomes a calendar topic, the calendar topic becomes a graded article, and
 * the article ends up waiting for the merchant.
 *
 * This is the M4 exit gate's own evidence, and it is deliberately assembled
 * from the real pieces rather than from doubles wherever a real piece exists.
 * The opportunity is a real row read back through the frozen `OpportunitySource`
 * seam's real implementation, the placement is the real scheduler, the pipeline
 * is the real one, and the only stand-ins are the three outside boundaries —
 * the model, the search vendor and the page fetcher — which cannot be real in
 * a test at all.
 *
 * What it therefore does **not** prove is stated here rather than left to be
 * discovered: no Gate 1 decision row exists for an automatically scheduled
 * topic. Detection already applied the demand floor, the substance backing and
 * the existing-target check before the opportunity was ever created, so the
 * checks were made — but main §9.6.4 puts a Gate 1 pass *after* scoring, on the
 * top-ranked candidates only, and nothing does that. The assertion below
 * records the current state rather than asserting a Gate 1 row that would not
 * be there. See DECISIONS 2026-09-03 T4.6.
 */

const available = await databaseAvailable()
const REPLENISH_AT = new Date('2026-09-03T07:00:00.000Z')
/** The day replenishment's first free slot lands on, so the cycle can be run on it. */
const GENERATION_DAY = new Date('2026-09-04T07:00:00.000Z')

const seo: SeoDataProvider = {
  keywordMetrics: () => Promise.reject(new Error('not expected to be called')),
  serpTop: async () => ({
    data: [{ position: 1, url: 'https://rival.example/guide', domain: 'rival.example', title: 'Water bottle guide' }],
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

describe.skipIf(!available)('M4 end to end: an opportunity becomes an article waiting for review', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_m4_flow')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'm4-flow@example.com')
  })

  async function seedStore(): Promise<{ familyId: string; productId: string }> {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_m4',
      priceId: 'price_m4',
      status: 'active',
    })
    // Draft review on, so the flow's last step is the merchant being asked.
    await db.insert(schema.accountSettings).values({ accountId, timezone: 'UTC', draftReview: true })
    await db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: 'm4.myshopify.com',
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

    const familyId = '33333333-3333-4333-8333-333333333333'
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId,
      name: 'Water bottles',
      differentiationAxes: ['capacity'],
      groupingSource: 'collection',
      confidence: 'high',
    })
    const materials = ['stainless steel', 'glass', 'tritan plastic']
    const origins = ['Germany', 'Portugal', 'Vietnam']
    let firstProductId = ''
    for (let i = 0; i < 3; i += 1) {
      const [product] = await db
        .insert(schema.products)
        .values({ accountId, shopifyProductId: `m4-${i}`, title: `Bottle ${i}`, familyId })
        .returning()
      if (i === 0) firstProductId = product!.id
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
    return { familyId, productId: firstProductId }
  }

  /** What Lane C's engine leaves behind for the calendar: an auto-accepted CREATE with its intent class on the evidence. */
  async function acceptedCreateOpportunity(familyId: string): Promise<string> {
    const [row] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best water bottles',
        evidenceJson: [
          { key: 'intent_class', value: 'buying_guide', source: 'content_inventory', fetchedAt: REPLENISH_AT.toISOString() },
          { key: 'family_id', value: familyId, source: 'content_inventory', fetchedAt: REPLENISH_AT.toISOString() },
          { key: 'monthly_search_volume', value: 900, source: 'dataforseo', fetchedAt: REPLENISH_AT.toISOString() },
        ],
        impact: 'high',
        impactScore: 82,
        confidence: 70,
        reasonTemplateKey: 'uncovered_commercial_query.no_suitable_url',
        reasonParamsJson: { volume: 900 },
        recommendedAction: 'create',
        status: 'accepted',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    return row!.id
  }

  function enqueueWholeRun(llm: MockLlmClient, productId: string): void {
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

  it('runs opportunity → topic → gates → article in review on the synthetic store', async () => {
    const { familyId, productId } = await seedStore()
    const opportunityId = await acceptedCreateOpportunity(familyId)

    // 1. The calendar tops itself up, reading candidates through the real seam.
    const replenished = await replenishCalendarForAccount(
      {
        db,
        pool: ctx.pool,
        opportunities: new DbOpportunitySource(db),
        now: () => REPLENISH_AT,
        logger: silentLogger,
      },
      accountId,
    )
    expect(replenished).toMatchObject({ status: 'filled', slotsFilled: 1, candidatesScored: 1 })

    // 2. A topic exists, on a future day, carrying the opportunity it came from
    //    and a why-line that is a key rather than a sentence.
    const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.accountId, accountId))
    expect(topic).toMatchObject({
      opportunityId,
      state: 'planned',
      intentClass: 'buying_guide',
      kind: 'new',
      source: 'auto',
      scheduledDate: '2026-09-04',
      whyLine: 'uncovered_commercial_query.no_suitable_url',
    })
    expect(topic!.score).not.toBeNull()

    // The opportunity has left the accepted pool, so nothing hands it out twice.
    const [opportunity] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunityId))
    expect(opportunity!.status).toBe('scheduled')
    expect(opportunity!.topicId).toBe(topic!.id)

    // 3. The store's own day arrives and the pipeline runs.
    const llm = new MockLlmClient()
    enqueueWholeRun(llm, productId)
    const generated = await runDailyGenerationForAccount(
      {
        db,
        pool: ctx.pool,
        llm,
        seo,
        pageFetcher,
        claimPlanPrompt: loadPrompt('claim-plan', 1),
        draftPrompt: loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION),
        judgePrompt: loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION),
        contradictionPrompt: loadPrompt('contradiction', 1),
        revisePrompt: loadPrompt('revise', 1),
        now: () => GENERATION_DAY,
        logger: silentLogger,
      },
      accountId,
    )
    expect(generated).toMatchObject({ status: 'generated', outcome: 'graded', awaitsReview: true })

    // 4. The gates that ran left an audit trail, and the article is waiting.
    const decisions = await db
      .select()
      .from(schema.gateDecisions)
      .where(eq(schema.gateDecisions.accountId, accountId))
    const gates = decisions.map((d) => d.gate).sort()
    expect(gates).toContain(3)
    // Two absences, recorded rather than hidden, because both are things a
    // reader of this file would otherwise assume are there.
    //
    // No Gate 1 row: an automatically scheduled topic never gets one. Its
    // checks were made when the opportunity was detected; nothing re-runs them
    // after scoring, which is where main §9.6.4 puts them.
    expect(gates).not.toContain(1)
    // No Gate 2 row either — the pack cleared it, and Gate 2 records only the
    // holds. That the pack was checked at all is proved by the outcome above:
    // a thin pack would have come back `held_thin_pack` and written nothing.
    expect(gates).not.toContain(2)
    expect(
      decisions.find((d) => d.gate === 3)?.outcome,
      'the draft cleared the quality bar',
    ).toBe('passed')

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.accountId, accountId))
    expect(article).toMatchObject({ state: 'in_review', topicId: topic!.id })
    expect(article!.bodyJson).not.toBeNull()
    expect(article!.metaDescription).toBeTruthy()

    const [afterwards] = await db
      .select()
      .from(schema.topics)
      .where(and(eq(schema.topics.accountId, accountId), eq(schema.topics.id, topic!.id)))
    expect(afterwards!.state).toBe('in_review')

    // Every product the article names is recorded as a row, not read back out
    // of the prose.
    const refs = await db
      .select()
      .from(schema.articleProductRefs)
      .where(eq(schema.articleProductRefs.articleId, article!.id))
    expect(refs.length).toBeGreaterThan(0)
  })
})
