import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  containsCurrencyFigure,
  silentLogger,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type SeoDataProvider,
} from '@sortiva/core'
import { accountScope, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { loadPrompt, MockLlmClient } from '@sortiva/llm'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from './prompts'
import type { PageFetcher } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { generateArticle } from './generate-article'

/**
 * The T4.3 pipeline end to end, against a real Postgres: a buying-guide
 * topic over a family with one differentiation axis, run through Gate 2 and
 * the claim plan into a drafted article. Checks this card's own done-when
 * directly: the claim plan is persisted before the writer's model call, the
 * writer's prompt carries the claim list and not the raw pack, the draft's
 * sections are named by the family's axis, every citation grounds to an
 * approved claim, and no citation figure survives as literal text.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T07:00:00.000Z')
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

describe.skipIf(!available)('generateArticle against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_generate_article')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'generate-article@example.com')
  })

  /**
   * Three products, two populated fields each (material, origin), no
   * numeric fields — six distinct merchant-fact claims, ids `c1`..`c6` in a
   * predictable order (product order, then field order: material before
   * origin), and no derived-fact claims to complicate the count. Exactly
   * meets the test config's `distinct_claims_min` of 6.
   */
  async function seedFamily(): Promise<{ familyId: string; productIds: string[] }> {
    const familyId = '11111111-1111-4111-8111-111111111111'
    const scope = accountScope(accountId)
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
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
        .values({ accountId: scope.accountId, shopifyProductId: `shopify-${i}`, title: `Bottle ${i}`, familyId })
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

  async function seedTopic(familyId: string): Promise<string> {
    const scope = accountScope(accountId)
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId: scope.accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best water bottles',
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
        accountId: scope.accountId,
        opportunityId: opportunity!.id,
        title: 'Best water bottles',
        targetKeyword: 'best water bottles',
        intentClass: 'buying_guide',
        familyIds: [familyId],
        kind: 'new',
        source: 'auto',
        scheduledDate: '2026-09-03',
        state: 'generating',
      })
      .returning()
    return topic!.id
  }

  function deps(llm: LlmClient) {
    return {
      db,
      llm,
      seo,
      pageFetcher,
      claimPlanPrompt: CLAIM_PLAN_PROMPT,
      draftPrompt: DRAFT_PROMPT,
      judgePrompt: JUDGE_PROMPT,
      contradictionPrompt: CONTRADICTION_PROMPT,
      revisePrompt: REVISE_PROMPT,
      now: () => NOW,
      logger: silentLogger,
    }
  }

  /**
   * A real `LlmClient` in front of `MockLlmClient` that, on the `draft`
   * call specifically, queries the real database **before** answering — the
   * call-order proof this card's done-when names. If `article_claims` has
   * no rows for this account at that moment, the claim plan was not
   * persisted before the writer's model call, and the test fails there
   * rather than on a downstream symptom.
   */
  class OrderAssertingLlmClient implements LlmClient {
    claimsPersistedBeforeDraftCall: boolean | null = null
    readonly requests: LlmRequest[] = []
    readonly inner = new MockLlmClient()

    async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
      this.requests.push(request)
      if (request.callType === 'draft') {
        const rows = await db
          .select()
          .from(schema.articleClaims)
          .innerJoin(schema.articles, eq(schema.articles.id, schema.articleClaims.articleId))
          .where(eq(schema.articles.accountId, accountId))
        this.claimsPersistedBeforeDraftCall = rows.length > 0
      }
      return this.inner.complete<T>(request)
    }
  }

  function enqueueClaimPlan(llm: MockLlmClient): void {
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
  }

  /**
   * `productMentionProductId` must name a real product id, only known once
   * `seedFamily` has run.
   *
   * The body is deliberately long enough and varied enough to survive Gate 3's
   * free checks — every sentence carrying checkable content cites the claim it
   * came from, the target phrase is not repeated past the stuffing threshold,
   * and no figure appears twice with two different values. A fixture that
   * failed those would prove nothing about the stages before them.
   */
  function enqueueDraft(llm: MockLlmClient, productMentionProductId: string): void {
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
  }

  /** A judge verdict that sits above every floor: information gain and grounding at 4, the rest at 3. */
  function enqueueJudge(llm: MockLlmClient, scores?: Record<string, number>): void {
    const values = {
      informationGain: 4,
      factualGrounding: 4,
      searchIntentMatch: 3,
      actionability: 3,
      languageQuality: 3,
      ecommerceUsefulness: 3,
      ...scores,
    }
    llm.enqueue(
      'judge',
      JSON.stringify({
        scores: values,
        justifications: Object.fromEntries(Object.keys(values).map((k) => [k, `graded on ${k}`])),
      }),
    )
  }

  it('gate 2 admits the pack, the claim plan persists before the draft call, and the draft grounds cleanly', async () => {
    const { familyId, productIds } = await seedFamily()
    const topicId = await seedTopic(familyId)

    const order = new OrderAssertingLlmClient()
    enqueueClaimPlan(order.inner)
    enqueueDraft(order.inner, productIds[0]!)
    enqueueJudge(order.inner)

    const result = await generateArticle(deps(order), {
      accountId,
      topicId,
      intentClass: 'buying_guide',
      cluster: { head: 'best water bottles', members: [] },
      targetKeyword: 'best water bottles',
      familyIds: [familyId],
      locale: { languageCode: 'en', countryCode: 'US' },
      linkTaskUrl: null,
    })

    expect(result.outcome).toBe('graded')
    if (result.outcome === 'held_thin_pack') throw new Error('expected a graded article')

    // Done-when: Gate 2 admits a real, distinct pack.
    expect(result.gate2.outcome).toBe('admitted')

    // Done-when: the claim plan was persisted before the draft's model call.
    expect(order.claimsPersistedBeforeDraftCall).toBe(true)
    expect(order.inner.calls[0]!.callType).toBe('claim_plan')
    expect(order.inner.calls[1]!.callType).toBe('draft')

    // Gate 3 passed on the first attempt: one judge call, no repair, and no
    // contradiction call at all because the deterministic pass found nothing
    // to ask about.
    expect(result.gate3.outcome).toBe('passed')
    expect(result.gate3.calls).toEqual({ judge: 1, contradiction: 0, repair: 0 })
    expect(order.inner.callCount).toBe(3)

    // Done-when: the writer's own prompt carried the claim list, not the raw pack.
    const draftRequest = order.requests.find((r) => r.callType === 'draft')
    expect(draftRequest).toBeDefined()
    const draftPromptContent = draftRequest!.messages.map((m) => m.content).join('\n')
    expect(draftPromptContent).toContain('c1')
    expect(draftPromptContent).not.toContain('wide mouth and a leakproof lid') // raw competitor excerpt, never approved as a claim

    // Done-when: buying-guide sections are named by the family's own axis.
    expect(result.draft.sections.some((s) => s.heading === 'Selection criteria: by capacity')).toBe(true)

    // Done-when: every product claim in the draft maps to a pack fact (the grounding harness).
    expect(result.grounding.grounded).toBe(true)
    expect(result.grounding.issues).toHaveLength(0)

    // Done-when: no currency figure survives as literal text anywhere in the draft.
    const allText = [
      result.draft.intro,
      ...result.draft.sections.map((s) => s.body),
      ...result.draft.faq.map((f) => f.answer),
    ].join('\n')
    expect(containsCurrencyFigure(allText)).toBe(false)

    // A real article row and its claims/refs exist, and the draft itself is
    // stored: title and meta description in their own columns, the body in
    // `body_json` with no second copy of either inside it.
    const [articleRow] = await db.select().from(schema.articles).where(eq(schema.articles.id, result.articleId))
    expect(articleRow?.state).toBe('draft')
    expect(articleRow?.title).toBe('Best water bottles: a buying guide')
    expect(articleRow?.metaDescription).toBe('How to choose a water bottle, by material and capacity.')
    const storedBody = articleRow?.bodyJson as Record<string, unknown>
    expect(Object.keys(storedBody).sort()).toEqual(['faq', 'intro', 'sections'])

    // The Gate 3 decision is auditable: the prompt and model that produced the
    // scores are on the row, not just the scores.
    const gate3Rows = await db
      .select()
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.topicId, topicId), eq(schema.gateDecisions.gate, 3)))
    expect(gate3Rows).toHaveLength(1)
    expect(gate3Rows[0]!.outcome).toBe('passed')
    expect(gate3Rows[0]!.promptVersion).toBe(JUDGE_PROMPT.version)
    expect(gate3Rows[0]!.modelId).toBeTruthy()
    // And which *numbers* judged it. This store has no override, so the stamp
    // is the bare hash of the repo config file — the string every gate decision
    // recorded before overrides existed carries. `gate-rules-overrides.test.ts`
    // holds the other half: a store judged under an override stamps a version
    // that says so.
    expect((gate3Rows[0]!.scoresJson as { rulesVersion?: unknown }).rulesVersion).toBe(rules().rulesVersion)
    const claimRows = await db
      .select()
      .from(schema.articleClaims)
      .where(eq(schema.articleClaims.articleId, result.articleId))
    expect(claimRows.length).toBeGreaterThanOrEqual(6)
    const refRows = await db
      .select()
      .from(schema.articleProductRefs)
      .where(eq(schema.articleProductRefs.articleId, result.articleId))
    expect(refRows).toHaveLength(1)
    expect(refRows[0]!.placeholderKey).toBe('p1')
    expect(refRows[0]!.fieldsRendered).toEqual(['price'])
  })

  it('holds a thin pack at Gate 2, writing a gate_decisions row and rejecting the topic — no model call spent', async () => {
    const scope = accountScope(accountId)
    const familyId = '22222222-2222-4222-8222-222222222222'
    await db.insert(schema.productFamilies).values({
      id: familyId,
      accountId: scope.accountId,
      name: 'Thin family',
      differentiationAxes: [],
      groupingSource: 'collection',
      confidence: 'low',
    })
    const [product] = await db
      .insert(schema.products)
      .values({ accountId: scope.accountId, shopifyProductId: 'shopify-thin', title: 'Thin product', familyId })
      .returning()
    await db.insert(schema.productFacts).values({
      productId: product!.id,
      factsJson: {
        material: 'plastic',
        dimensions: null,
        weight: null,
        capacity: null,
        compatibility: [],
        use_cases_stated: [],
        care: null,
        variant_axes: [],
        price_range: null,
        certifications: [],
        origin: null,
        verifiable_claims: [],
        fluff_discarded: false,
        fact_count: 1,
      },
      factCount: 1,
      fluffDiscarded: 0,
      promptVersion: 'v1',
      modelId: 'test-model',
    })
    const topicId = await seedTopic(familyId)

    const llm = new MockLlmClient()
    const result = await generateArticle(deps(llm), {
      accountId,
      topicId,
      intentClass: 'buying_guide',
      cluster: { head: 'thin topic', members: [] },
      targetKeyword: 'thin topic',
      familyIds: [familyId],
      locale: { languageCode: 'en', countryCode: 'US' },
      linkTaskUrl: null,
    })

    expect(result.outcome).toBe('held_thin_pack')
    expect(llm.callCount).toBe(0)

    const decisions = await db
      .select()
      .from(schema.gateDecisions)
      .where(and(eq(schema.gateDecisions.topicId, topicId), eq(schema.gateDecisions.gate, 2)))
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.outcome).toBe('held_thin_pack')

    const [topicRow] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
    expect(topicRow?.state).toBe('rejected_by_gate')

    const articleRows = await db.select().from(schema.articles).where(eq(schema.articles.topicId, topicId))
    expect(articleRows).toHaveLength(0)
  })
})
